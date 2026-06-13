// A minimal in-process BlobStore for store-independent measurements (e.g. WAL
// volume): the bytes Postgres writes per commit do not depend on the transport,
// so the FPW experiment uses this instead of paying GCS latency / the 1/s cap.
// Implements the same conditional-PUT semantics the commit + lease paths rely
// on (etag = monotonic version per key; ifNoneMatch / ifMatch enforced).

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
} from '@zeropg/blobstore'

interface Obj {
  bytes: Uint8Array
  etag: string
  size: number
  /** True when the body was dropped in measurement mode (size still tracked). */
  discarded?: boolean
}

export interface MemBlobStoreOptions {
  /**
   * Measurement mode: don't retain object bodies whose key matches this
   * predicate (snapshots / WAL segments), only their size + etag. The commit
   * path never re-GETs those during a no-reopen run, so this keeps a 500MB
   * snapshot from materializing in the JS heap while bytesPut still counts it.
   * get()/getStream() on a discarded body throws (loud misuse signal).
   */
  discardBody?: (key: string) => boolean
}

export class MemBlobStore implements BlobStore {
  private objs = new Map<string, Obj>()
  private seq = 0
  /** Total bytes accepted by put/putStream (handy for upload-cost accounting). */
  bytesPut = 0
  private discardBody?: (key: string) => boolean

  constructor(opts?: MemBlobStoreOptions) {
    this.discardBody = opts?.discardBody
  }

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    const o = this.objs.get(key)
    if (!o) return null
    if (o.discarded) throw new Error(`MemBlobStore: body of ${key} was discarded (measurement mode)`)
    let bytes = o.bytes
    if (opts?.range) {
      const end = opts.range.end ?? o.bytes.byteLength - 1
      bytes = o.bytes.subarray(opts.range.start, end + 1)
    }
    return { bytes, etag: o.etag, size: o.size }
  }

  async getStream(key: string): Promise<GetStreamResult | null> {
    const o = this.objs.get(key)
    if (!o) return null
    if (o.discarded) throw new Error(`MemBlobStore: body of ${key} was discarded (measurement mode)`)
    const bytes = o.bytes
    return {
      stream: (async function* () {
        yield bytes
      })(),
      etag: o.etag,
      size: bytes.byteLength,
    }
  }

  private write(key: string, bytes: Uint8Array, opts?: PutOptions): PutResult {
    const cur = this.objs.get(key)
    if (opts?.ifNoneMatch && cur) throw new PreconditionFailedError(key, 'exists')
    if (opts?.ifMatch !== undefined && (!cur || cur.etag !== opts.ifMatch)) {
      throw new PreconditionFailedError(key, `etag ${cur?.etag} != ${opts.ifMatch}`)
    }
    const etag = String(++this.seq)
    this.bytesPut += bytes.byteLength
    if (this.discardBody?.(key)) {
      this.objs.set(key, { bytes: new Uint8Array(0), etag, size: bytes.byteLength, discarded: true })
    } else {
      this.objs.set(key, { bytes, etag, size: bytes.byteLength })
    }
    return { etag }
  }

  async put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult> {
    return this.write(key, bytes.slice(), opts)
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    opts?: PutOptions,
  ): Promise<PutResult> {
    const chunks: Uint8Array[] = []
    let n = 0
    for await (const c of source) {
      chunks.push(c)
      n += c.byteLength
    }
    const buf = new Uint8Array(n)
    let off = 0
    for (const c of chunks) {
      buf.set(c, off)
      off += c.byteLength
    }
    return this.write(key, buf, opts)
  }

  async *list(prefix: string): AsyncIterable<ListEntry> {
    for (const [key, o] of this.objs) {
      if (key.startsWith(prefix)) yield { key, etag: o.etag, size: o.size }
    }
  }

  async delete(key: string): Promise<void> {
    this.objs.delete(key)
  }

  async head(key: string): Promise<{ etag: string; size: number } | null> {
    const o = this.objs.get(key)
    return o ? { etag: o.etag, size: o.size } : null
  }
}
