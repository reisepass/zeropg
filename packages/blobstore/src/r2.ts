// Cloudflare R2 transport for the BlobStore interface, via R2's S3-compatible
// API with AWS Signature Version 4 signing.
//
// R2 has two faces: Workers bindings (in-Worker `env.BUCKET.put(...)`) and an
// S3-compatible HTTP API. This transport targets the S3 API, because that is
// what runs from Node and from our experiment harness (the DO/Worker skeleton
// in examples/ shows the bindings path). Plain fetch, no aws-sdk: the one
// strong primitive the whole design needs is the conditional PUT, which S3/R2
// implement with `If-None-Match: *` (create-if-absent) and `If-Match: <etag>`
// (compare-and-swap), atomically server-side.
//
// CAS strength (TODO B3): the version token we expose as `etag` is the literal
// S3 ETag, which is NOT a monotonic generation counter the way GCS's is — so
// this store reports `casStrength: 'etag'` (a theoretical ABA window) vs GCS's
// 'generation'. The lease (incrementing token, never reverts) and the
// numbered-immutable-manifest plan make ABA moot in practice; see docs/R2.md.
//
// Retry discipline mirrors gcs.ts EXACTLY: 429/5xx clean rejections retry with
// jittered backoff; an ambiguous network failure on a conditional PUT is NEVER
// retried, because a retried-but-already-landed CAS would read back as a
// spurious 412 -> a false FencedError upstream.

import { createHash, createHmac } from 'node:crypto'
import {
  type BlobStore,
  type Bytes,
  type CostModel,
  type GetOptions,
  type GetResult,
  type GetStreamResult,
  type ListEntry,
  type PutOptions,
  type PutResult,
  PreconditionFailedError,
} from './types.js'

/** Cloudflare R2 (COST-MODEL.md). Free egress is the headline: it is where the
 * CDN-seeded read-replica / browser-PGlite story becomes free (TODO B6). No
 * published hard per-object write-rate cap (Workers-side limits dominate), so
 * `maxWritesPerObjectPerSec` is omitted — no forced group-commit pacing. */
export const R2_COST: CostModel = {
  asOf: '2026-06',
  writeOpUsd: 4.5 / 1_000_000, // Class A $4.50 / million
  readOpUsd: 0.36 / 1_000_000, // Class B $0.36 / million
  storageGbMonthUsd: 0.015,
  internetEgressGbUsd: 0, // the whole point of R2
  casStrength: 'etag', // S3 If-Match/If-None-Match, not monotonic generations
  freeTier: { storageGb: 10, writeOps: 1_000_000, readOps: 10_000_000 },
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const UNSIGNED = 'UNSIGNED-PAYLOAD'

export interface R2Options {
  /** Cloudflare account id. Builds the default endpoint when `endpoint` is unset. */
  accountId?: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Key prefix prepended to every key (no leading/trailing slash needed). */
  prefix?: string
  /** Full S3 endpoint origin. Defaults to https://<accountId>.r2.cloudflarestorage.com */
  endpoint?: string
  /** SigV4 region. R2 ignores it but it must be consistent; defaults to 'auto'. */
  region?: string
}

/**
 * Build R2Options from the environment, or return null if credentials are
 * absent. Accepts the R2_* names this project documents and the standard AWS_*
 * names (with R2_ACCOUNT_ID or AWS_ENDPOINT_URL_S3 to locate the endpoint).
 * The CAS conformance suite uses this to run live only when creds exist.
 */
export function r2OptionsFromEnv(prefix?: string): R2Options | null {
  const e = process.env
  const accessKeyId = e.R2_ACCESS_KEY_ID ?? e.AWS_ACCESS_KEY_ID
  const secretAccessKey = e.R2_SECRET_ACCESS_KEY ?? e.AWS_SECRET_ACCESS_KEY
  const bucket = e.R2_BUCKET ?? e.AWS_BUCKET ?? e.S3_BUCKET
  const accountId = e.R2_ACCOUNT_ID ?? e.CF_ACCOUNT_ID
  const endpoint = e.R2_ENDPOINT ?? e.AWS_ENDPOINT_URL_S3 ?? e.AWS_ENDPOINT_URL
  if (!accessKeyId || !secretAccessKey || !bucket) return null
  if (!accountId && !endpoint) return null
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    accountId,
    endpoint,
    prefix,
    region: e.R2_REGION ?? e.AWS_REGION ?? 'auto',
  }
}

function joinPrefix(prefix: string | undefined, key: string): string {
  if (!prefix) return key
  const p = prefix.replace(/\/+$/, '')
  return `${p}/${key}`
}

/** RFC3986 encode, used for canonical URIs and query strings. encodeURIComponent
 * leaves !*'() unescaped, which SigV4 requires escaped. */
function uriEncode(s: string, encodeSlash = true): string {
  let out = ''
  for (const ch of Buffer.from(s, 'utf8').toString('latin1')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch
    else if (ch === '/') out += encodeSlash ? '%2F' : '/'
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function stripQuotes(s: string): string {
  // R2 quirk: GET returns a WEAK etag (W/"<hash>") for objects that LIST/PUT
  // report with a STRONG etag ("<hash>") — same hash, different validator. An
  // If-Match conditional PUT requires a strong validator, so a weak etag never
  // matches and lease takeover livelocks ("contention"). Strip the W/ prefix so
  // every etag we hand back is the strong form R2 accepts in If-Match.
  return s.replace(/^W\//, '').replace(/^"|"$/g, '')
}

export class R2BlobStore implements BlobStore {
  readonly cost = R2_COST
  private accessKeyId: string
  private secretAccessKey: string
  private bucket: string
  private prefix: string | undefined
  private origin: string
  private region: string

  constructor(opts: R2Options) {
    this.accessKeyId = opts.accessKeyId
    this.secretAccessKey = opts.secretAccessKey
    this.bucket = opts.bucket
    this.prefix = opts.prefix
    this.region = opts.region ?? 'auto'
    const endpoint =
      opts.endpoint ??
      (opts.accountId
        ? `https://${opts.accountId}.r2.cloudflarestorage.com`
        : undefined)
    if (!endpoint) throw new Error('R2BlobStore: provide either `endpoint` or `accountId`')
    this.origin = endpoint.replace(/\/+$/, '')
  }

  static fromEnv(prefix?: string): R2BlobStore | null {
    const opts = r2OptionsFromEnv(prefix)
    return opts ? new R2BlobStore(opts) : null
  }

  private fullKey(key: string): string {
    return joinPrefix(this.prefix, key)
  }

  /** Path-style object URL: <origin>/<bucket>/<key>. */
  private objectPath(key: string): string {
    return `/${this.bucket}/${uriEncode(this.fullKey(key), false)}`
  }

  // ---- SigV4 -------------------------------------------------------------

  /**
   * Sign a request and return the headers to send. `query` is the parsed query
   * params (already decoded values); they are canonicalised and signed. The
   * caller builds the final URL from `path` + the same query.
   */
  private sign(
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    payloadHash: string,
  ): Record<string, string> {
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8)
    const host = new URL(this.origin).host

    const allHeaders: Record<string, string> = {
      ...headers,
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }

    // Canonical headers: lowercase name, trimmed value, sorted by name.
    const headerNames = Object.keys(allHeaders)
      .map((h) => h.toLowerCase())
      .sort()
    const lower: Record<string, string> = {}
    for (const [k, v] of Object.entries(allHeaders)) lower[k.toLowerCase()] = String(v).trim()
    const canonicalHeaders = headerNames.map((h) => `${h}:${lower[h]}\n`).join('')
    const signedHeaders = headerNames.join(';')

    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join('&')

    const canonicalRequest = [
      method,
      path, // already RFC3986-encoded (slashes preserved)
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n')

    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, 's3')
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    return {
      ...allHeaders,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join('&')
    return `${this.origin}${path}${qs ? `?${qs}` : ''}`
  }

  /** Map S3 conditional headers from our PutOptions. */
  private condHeaders(opts?: PutOptions): Record<string, string> {
    const h: Record<string, string> = {}
    if (opts?.ifNoneMatch) h['If-None-Match'] = '*'
    else if (opts?.ifMatch !== undefined) h['If-Match'] = opts.ifMatch
    if (opts?.contentType) h['Content-Type'] = opts.contentType
    return h
  }

  // ---- core ops ----------------------------------------------------------

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    const path = this.objectPath(key)
    const headers: Record<string, string> = {}
    if (opts?.range) {
      const { start, end } = opts.range
      headers.Range = `bytes=${start}-${end ?? ''}`
    }
    const signed = this.sign('GET', path, {}, headers, EMPTY_SHA256)
    const res = await fetch(this.buildUrl(path, {}), { headers: signed })
    if (res.status === 404) return null
    if (!(res.ok || res.status === 206)) throw await r2Error(res, 'get', key)
    const buf = new Uint8Array(await res.arrayBuffer())
    return { bytes: buf, etag: stripQuotes(res.headers.get('etag') ?? ''), size: buf.byteLength }
  }

  async head(key: string): Promise<{ etag: string; size: number } | null> {
    const path = this.objectPath(key)
    const signed = this.sign('HEAD', path, {}, {}, EMPTY_SHA256)
    const res = await fetch(this.buildUrl(path, {}), { method: 'HEAD', headers: signed })
    if (res.status === 404) return null
    if (!res.ok) throw await r2Error(res, 'head', key)
    return {
      etag: stripQuotes(res.headers.get('etag') ?? ''),
      size: Number(res.headers.get('content-length') ?? '0'),
    }
  }

  async put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult> {
    const path = this.objectPath(key)
    const payloadHash = createHash('sha256').update(bytes).digest('hex')
    const cond = this.condHeaders(opts)
    // Retry 429/5xx with jittered backoff. ONLY clean rejections are retried:
    // an ambiguous network failure on a conditional PUT may have landed, and
    // retrying it could turn our own success into a spurious 412 -> a false
    // FencedError upstream. So a thrown fetch (network error) propagates.
    for (let attempt = 0; ; attempt++) {
      const signed = this.sign('PUT', path, {}, cond, payloadHash)
      const res = await fetch(this.buildUrl(path, {}), {
        method: 'PUT',
        headers: signed,
        body: bytes,
      })
      if (res.status === 412 || res.status === 409) {
        await res.body?.cancel().catch(() => {})
        throw new PreconditionFailedError(
          key,
          opts?.ifNoneMatch ? 'object exists' : 'etag mismatch',
        )
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.text().catch(() => {})
        const backoff = Math.min(3000, 200 * 2 ** attempt) * (0.5 + Math.random())
        await new Promise((r) => setTimeout(r, backoff))
        continue
      }
      if (!res.ok) throw await r2Error(res, 'put', key)
      const etag = stripQuotes(res.headers.get('etag') ?? '')
      await res.body?.cancel().catch(() => {})
      return { etag }
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.objectPath(key)
    const signed = this.sign('DELETE', path, {}, {}, EMPTY_SHA256)
    const res = await fetch(this.buildUrl(path, {}), { method: 'DELETE', headers: signed })
    if (res.status === 404 || res.status === 204 || res.ok) {
      await res.body?.cancel().catch(() => {})
      return // S3 delete is idempotent (204 even when absent)
    }
    throw await r2Error(res, 'delete', key)
  }

  async *list(prefix: string): AsyncIterable<ListEntry> {
    const fullPrefix = this.fullKey(prefix)
    const stripLen = this.prefix ? this.prefix.replace(/\/+$/, '').length + 1 : 0
    let token: string | undefined
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: fullPrefix }
      if (token) query['continuation-token'] = token
      const path = `/${this.bucket}`
      const signed = this.sign('GET', path, query, {}, EMPTY_SHA256)
      const res = await fetch(this.buildUrl(path, query), { headers: signed })
      if (!res.ok) throw await r2Error(res, 'list', prefix)
      const xml = await res.text()
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const name = decodeXml(matchTag(block, 'Key') ?? '')
        const etag = stripQuotes(decodeXml(matchTag(block, 'ETag') ?? ''))
        const size = Number(matchTag(block, 'Size') ?? '0')
        const logical = stripLen ? name.slice(stripLen) : name
        yield { key: logical, etag, size }
      }
      const truncated = matchTag(xml, 'IsTruncated') === 'true'
      token = truncated ? matchTag(xml, 'NextContinuationToken') ?? undefined : undefined
    } while (token)
  }

  /**
   * Server-side copy within the bucket (S3 CopyObject) — no bytes flow through
   * the client. The source is pinned via x-amz-copy-source.
   */
  async copy(srcKey: string, destKey: string): Promise<PutResult> {
    const path = this.objectPath(destKey)
    const headers: Record<string, string> = {
      'x-amz-copy-source': `/${this.bucket}/${uriEncode(this.fullKey(srcKey), false)}`,
    }
    const signed = this.sign('PUT', path, {}, headers, EMPTY_SHA256)
    const res = await fetch(this.buildUrl(path, {}), { method: 'PUT', headers: signed })
    if (!res.ok) throw await r2Error(res, 'copy', srcKey)
    const xml = await res.text()
    return { etag: stripQuotes(decodeXml(matchTag(xml, 'ETag') ?? '')) }
  }

  // ---- streaming ---------------------------------------------------------

  /** Tuning for getStream's parallel-range download (mirrors gcs.ts). */
  static STREAM_CHUNK_BYTES = 32 * 1024 * 1024
  static STREAM_CONCURRENCY = 4
  /** Multipart part size for putStream (S3 minimum is 5MB per non-final part). */
  static PART_BYTES = 8 * 1024 * 1024

  async getStream(key: string): Promise<GetStreamResult | null> {
    const meta = await this.head(key)
    if (!meta) return null
    const path = this.objectPath(key)
    const self = this
    const CHUNK = R2BlobStore.STREAM_CHUNK_BYTES
    const CONC = R2BlobStore.STREAM_CONCURRENCY

    // Pin every range to the version we statted via If-Match: a concurrent
    // overwrite makes the ranged GET 412 instead of interleaving two versions'
    // bytes. (R2/S3 has no generation query param; If-Match is the equivalent.)
    async function fetchRange(start: number, endIncl: number): Promise<Response> {
      const headers = { Range: `bytes=${start}-${endIncl}`, 'If-Match': meta!.etag }
      const signed = self.sign('GET', path, {}, headers, EMPTY_SHA256)
      const res = await fetch(self.buildUrl(path, {}), { headers: signed })
      if (res.status === 412) throw await r2Error(res, 'getStream(version changed)', key)
      if (!(res.status === 206 || res.status === 200)) throw await r2Error(res, 'getStream', key)
      return res
    }

    const size = meta.size
    async function* ordered(): AsyncGenerator<Uint8Array> {
      if (size === 0) return
      const starts: number[] = []
      for (let s = 0; s < size; s += CHUNK) starts.push(s)
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
        const r = await inflight.shift()!
        fill()
        if (!r.body) throw new Error(`R2 getStream "${key}": empty response body`)
        for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) yield part
      }
    }
    return { stream: ordered(), etag: meta.etag, size }
  }

  /**
   * PUT from a byte stream. Small streams (under one part) collapse to a single
   * conditional PutObject; larger ones use an S3 multipart upload (parts
   * buffered to PART_BYTES, so peak memory is O(part size)). The conditional
   * precondition is applied to the final commit step in both cases — a single
   * PUT, or CompleteMultipartUpload — so it stays atomic.
   */
  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    opts?: PutOptions,
  ): Promise<PutResult> {
    const PART = R2BlobStore.PART_BYTES
    const it = source[Symbol.asyncIterator]()
    // Accumulate until we either cross one part boundary or the stream ends.
    let buf: Uint8Array[] = []
    let n = 0
    let done = false
    while (n < PART) {
      const { value, done: d } = await it.next()
      if (d) {
        done = true
        break
      }
      buf.push(value)
      n += value.length
    }
    // Fits in one part: single conditional PutObject (1 request).
    if (done) return this.put(key, Buffer.concat(buf, n), opts)

    // Otherwise: multipart upload.
    const path = this.objectPath(key)
    const uploadId = await this.createMultipart(path, key, opts?.contentType)
    const parts: { PartNumber: number; ETag: string }[] = []
    try {
      let partNo = 0
      const flush = async (chunks: Uint8Array[], total: number) => {
        partNo++
        const body = Buffer.concat(chunks, total)
        const etag = await this.uploadPart(path, key, uploadId, partNo, body)
        parts.push({ PartNumber: partNo, ETag: etag })
      }
      await flush(buf, n) // first full part
      buf = []
      n = 0
      for (;;) {
        const { value, done: d } = await it.next()
        if (d) break
        buf.push(value)
        n += value.length
        if (n >= PART) {
          await flush(buf, n)
          buf = []
          n = 0
        }
      }
      if (n > 0) await flush(buf, n) // final (short) part
      return await this.completeMultipart(path, key, uploadId, parts, opts)
    } catch (e) {
      await this.abortMultipart(path, uploadId).catch(() => {})
      throw e
    }
  }

  private async createMultipart(path: string, key: string, contentType?: string): Promise<string> {
    const query = { uploads: '' }
    const headers: Record<string, string> = {}
    if (contentType) headers['Content-Type'] = contentType
    const signed = this.sign('POST', path, query, headers, EMPTY_SHA256)
    const res = await fetch(this.buildUrl(path, query), { method: 'POST', headers: signed })
    if (!res.ok) throw await r2Error(res, 'createMultipart', key)
    const xml = await res.text()
    const id = matchTag(xml, 'UploadId')
    if (!id) throw new Error(`R2 createMultipart "${key}": no UploadId in response`)
    return id
  }

  private async uploadPart(
    path: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const query = { partNumber: String(partNumber), uploadId }
    const payloadHash = createHash('sha256').update(body).digest('hex')
    // Parts are plain (non-conditional) PUTs; retry clean 429/5xx only.
    for (let attempt = 0; ; attempt++) {
      const signed = this.sign('PUT', path, query, {}, payloadHash)
      const res = await fetch(this.buildUrl(path, query), {
        method: 'PUT',
        headers: signed,
        body,
      })
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.text().catch(() => {})
        await new Promise((r) => setTimeout(r, Math.min(3000, 200 * 2 ** attempt) * (0.5 + Math.random())))
        continue
      }
      if (!res.ok) throw await r2Error(res, `uploadPart#${partNumber}`, key)
      const etag = res.headers.get('etag') ?? ''
      await res.body?.cancel().catch(() => {})
      if (!etag) throw new Error(`R2 uploadPart "${key}" #${partNumber}: no ETag header`)
      return etag
    }
  }

  private async completeMultipart(
    path: string,
    key: string,
    uploadId: string,
    parts: { PartNumber: number; ETag: string }[],
    opts?: PutOptions,
  ): Promise<PutResult> {
    const query = { uploadId }
    const xmlBody =
      '<CompleteMultipartUpload>' +
      parts
        .map((p) => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>'
    const bodyBytes = Buffer.from(xmlBody, 'utf8')
    const payloadHash = createHash('sha256').update(bodyBytes).digest('hex')
    const headers = this.condHeaders(opts)
    const signed = this.sign('POST', path, query, headers, payloadHash)
    const res = await fetch(this.buildUrl(path, query), {
      method: 'POST',
      headers: signed,
      body: bodyBytes,
    })
    if (res.status === 412 || res.status === 409) {
      await res.body?.cancel().catch(() => {})
      throw new PreconditionFailedError(key, opts?.ifNoneMatch ? 'object exists' : 'etag mismatch')
    }
    if (!res.ok) throw await r2Error(res, 'completeMultipart', key)
    const xml = await res.text()
    // S3 can return 200 with an error body on complete; treat that as failure.
    if (/<Error>/.test(xml)) throw new Error(`R2 completeMultipart "${key}" failed: ${xml.slice(0, 400)}`)
    return { etag: stripQuotes(decodeXml(matchTag(xml, 'ETag') ?? '')) }
  }

  private async abortMultipart(path: string, uploadId: string): Promise<void> {
    const query = { uploadId }
    const signed = this.sign('DELETE', path, query, {}, EMPTY_SHA256)
    const res = await fetch(this.buildUrl(path, query), { method: 'DELETE', headers: signed })
    await res.body?.cancel().catch(() => {})
  }
}

function matchTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? m[1] : undefined
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

async function r2Error(res: Response, op: string, key: string): Promise<Error> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    // ignore
  }
  return new Error(`R2 ${op} "${key}" failed: ${res.status} ${res.statusText} ${detail.slice(0, 400)}`)
}
