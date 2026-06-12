// GCS JSON API transport for the BlobStore interface.
//
// Plain fetch, no @google-cloud/storage SDK. The one strong primitive we need
// is the conditional precondition `ifGenerationMatch`, which GCS implements
// atomically server-side:
//   ifGenerationMatch=0    -> create-if-absent (fails 412 if object exists)
//   ifGenerationMatch=<g>  -> compare-and-swap (fails 412 if current gen != g)
//
// The version token we expose as `etag` is the GCS object *generation* (a
// numeric string), NOT the HTTP ETag. Generation is what the preconditions act
// on, so that is what callers must round-trip for a correct CAS.

import { Readable } from 'node:stream'
import {
  type BlobStore,
  type Bytes,
  type GetOptions,
  type GetResult,
  type GetStreamResult,
  type ListEntry,
  type PutOptions,
  type PutResult,
  PreconditionFailedError,
} from './types.js'
import { getAccessToken } from './token.js'

const BASE = 'https://storage.googleapis.com'

export interface GcsOptions {
  bucket: string
  /** Key prefix prepended to every key (no leading/trailing slash needed). */
  prefix?: string
  /** Override token provider (tests). Defaults to metadata/gcloud. */
  tokenProvider?: () => Promise<string>
}

function joinPrefix(prefix: string | undefined, key: string): string {
  if (!prefix) return key
  const p = prefix.replace(/\/+$/, '')
  return `${p}/${key}`
}

export class GcsBlobStore implements BlobStore {
  private bucket: string
  private prefix: string | undefined
  private getToken: () => Promise<string>

  constructor(opts: GcsOptions) {
    this.bucket = opts.bucket
    this.prefix = opts.prefix
    this.getToken = opts.tokenProvider ?? getAccessToken
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}` }
  }

  private fullKey(key: string): string {
    return joinPrefix(this.prefix, key)
  }

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    const name = encodeURIComponent(this.fullKey(key))
    const url = `${BASE}/storage/v1/b/${this.bucket}/o/${name}?alt=media`
    const headers: Record<string, string> = { ...(await this.authHeaders()) }
    if (opts?.range) {
      const { start, end } = opts.range
      headers.Range = `bytes=${start}-${end ?? ''}`
    }
    const res = await fetch(url, { headers })
    if (res.status === 404) return null
    if (!res.ok) throw await gcsError(res, 'get', key)
    const buf = new Uint8Array(await res.arrayBuffer())
    const etag = res.headers.get('x-goog-generation') ?? ''
    return { bytes: buf, etag, size: buf.byteLength }
  }

  /** Tuning for getStream's parallel-range download. */
  static STREAM_CHUNK_BYTES = 32 * 1024 * 1024
  static STREAM_CONCURRENCY = 4

  async getStream(key: string): Promise<GetStreamResult | null> {
    const meta = await this.head(key)
    if (!meta) return null
    const name = encodeURIComponent(this.fullKey(key))
    // Pin every range request to the generation we statted, so a concurrent
    // overwrite can never interleave bytes from two versions.
    const base = `${BASE}/storage/v1/b/${this.bucket}/o/${name}?alt=media&generation=${meta.etag}`
    const auth = await this.authHeaders()
    const CHUNK = GcsBlobStore.STREAM_CHUNK_BYTES
    const CONC = GcsBlobStore.STREAM_CONCURRENCY

    async function fetchRange(start: number, endIncl: number): Promise<Response> {
      const res = await fetch(base, {
        headers: { ...auth, Range: `bytes=${start}-${endIncl}` },
      })
      if (!(res.status === 206 || res.status === 200)) {
        throw await gcsError(res, 'getStream', key)
      }
      return res
    }

    const size = meta.size
    async function* ordered(): AsyncGenerator<Uint8Array> {
      if (size === 0) return
      const starts: number[] = []
      for (let s = 0; s < size; s += CHUNK) starts.push(s)
      // Sliding window of in-flight range requests, consumed strictly in order.
      const inflight: Promise<Response>[] = []
      let next = 0
      const fill = () => {
        while (next < starts.length && inflight.length < CONC) {
          const s = starts[next++]
          inflight.push(fetchRange(s, Math.min(s + CHUNK, size) - 1))
        }
      }
      fill()
      while (inflight.length > 0) {
        const res = inflight.shift()!
        const r = await res
        fill()
        if (!r.body) throw new Error(`GCS getStream "${key}": empty response body`)
        for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
          yield part
        }
      }
    }
    return { stream: ordered(), etag: meta.etag, size }
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    opts?: PutOptions,
  ): Promise<PutResult> {
    // Coalesce small producer chunks (tar headers, gzip flushes) into ~1MB
    // chunks; per-chunk HTTP framing otherwise dominates the upload time.
    async function* coalesced(): AsyncGenerator<Uint8Array> {
      const TARGET = 1024 * 1024
      let buf: Uint8Array[] = []
      let n = 0
      for await (const c of source) {
        buf.push(c)
        n += c.length
        if (n >= TARGET) {
          yield Buffer.concat(buf, n)
          buf = []
          n = 0
        }
      }
      if (n > 0) yield Buffer.concat(buf, n)
    }
    const name = this.fullKey(key)
    const params = new URLSearchParams({ uploadType: 'media', name })
    if (opts?.ifNoneMatch) params.set('ifGenerationMatch', '0')
    else if (opts?.ifMatch !== undefined) params.set('ifGenerationMatch', opts.ifMatch)
    const url = `${BASE}/upload/storage/v1/b/${this.bucket}/o?${params}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(await this.authHeaders()),
        'Content-Type': opts?.contentType ?? 'application/octet-stream',
      },
      // Chunked transfer — GCS media upload accepts bodies with no length.
      body: Readable.toWeb(Readable.from(coalesced())) as unknown as ReadableStream,
      // Node fetch requires explicit half-duplex for streamed request bodies.
      ...({ duplex: 'half' } as object),
    })
    if (res.status === 412) {
      throw new PreconditionFailedError(key, opts?.ifNoneMatch ? 'object exists' : 'generation mismatch')
    }
    if (!res.ok) throw await gcsError(res, 'putStream', key)
    const meta = (await res.json()) as { generation: string }
    return { etag: meta.generation }
  }

  async put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult> {
    const name = this.fullKey(key)
    const params = new URLSearchParams({ uploadType: 'media', name })
    if (opts?.ifNoneMatch) params.set('ifGenerationMatch', '0')
    else if (opts?.ifMatch !== undefined) params.set('ifGenerationMatch', opts.ifMatch)
    const url = `${BASE}/upload/storage/v1/b/${this.bucket}/o?${params}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(await this.authHeaders()),
        'Content-Type': opts?.contentType ?? 'application/octet-stream',
      },
      body: bytes,
    })
    if (res.status === 412) {
      throw new PreconditionFailedError(key, opts?.ifNoneMatch ? 'object exists' : 'generation mismatch')
    }
    if (!res.ok) throw await gcsError(res, 'put', key)
    const meta = (await res.json()) as { generation: string }
    return { etag: meta.generation }
  }

  async *list(prefix: string): AsyncIterable<ListEntry> {
    const fullPrefix = this.fullKey(prefix)
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({ prefix: fullPrefix })
      if (pageToken) params.set('pageToken', pageToken)
      const url = `${BASE}/storage/v1/b/${this.bucket}/o?${params}`
      const res = await fetch(url, { headers: await this.authHeaders() })
      if (!res.ok) throw await gcsError(res, 'list', prefix)
      const body = (await res.json()) as {
        items?: Array<{ name: string; generation: string; size: string }>
        nextPageToken?: string
      }
      for (const item of body.items ?? []) {
        // Strip our prefix back off so callers see the logical key.
        const logical = this.prefix
          ? item.name.slice(this.prefix.replace(/\/+$/, '').length + 1)
          : item.name
        yield { key: logical, etag: item.generation, size: Number(item.size) }
      }
      pageToken = body.nextPageToken
    } while (pageToken)
  }

  /**
   * Server-side copy within the bucket (GCS rewrite API) — no bytes flow
   * through the client, so copying a 500MB snapshot takes ~a second. Loops on
   * rewriteToken as the API requires for large objects.
   */
  async copy(srcKey: string, destKey: string): Promise<PutResult> {
    const src = encodeURIComponent(this.fullKey(srcKey))
    const dst = encodeURIComponent(this.fullKey(destKey))
    let token: string | undefined
    for (;;) {
      const url =
        `${BASE}/storage/v1/b/${this.bucket}/o/${src}/rewriteTo/b/${this.bucket}/o/${dst}` +
        (token ? `?rewriteToken=${encodeURIComponent(token)}` : '')
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) throw await gcsError(res, 'copy', srcKey)
      const body = (await res.json()) as {
        done: boolean
        rewriteToken?: string
        resource?: { generation: string }
      }
      if (body.done) return { etag: body.resource?.generation ?? '' }
      token = body.rewriteToken
    }
  }

  async delete(key: string): Promise<void> {
    const name = encodeURIComponent(this.fullKey(key))
    const url = `${BASE}/storage/v1/b/${this.bucket}/o/${name}`
    const res = await fetch(url, { method: 'DELETE', headers: await this.authHeaders() })
    if (res.status === 404) return // idempotent
    if (!res.ok) throw await gcsError(res, 'delete', key)
  }

  async head(key: string): Promise<{ etag: string; size: number } | null> {
    const name = encodeURIComponent(this.fullKey(key))
    const url = `${BASE}/storage/v1/b/${this.bucket}/o/${name}`
    const res = await fetch(url, { headers: await this.authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) throw await gcsError(res, 'head', key)
    const meta = (await res.json()) as { generation: string; size: string }
    return { etag: meta.generation, size: Number(meta.size) }
  }
}

async function gcsError(res: Response, op: string, key: string): Promise<Error> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    // ignore
  }
  return new Error(`GCS ${op} "${key}" failed: ${res.status} ${res.statusText} ${detail.slice(0, 400)}`)
}
