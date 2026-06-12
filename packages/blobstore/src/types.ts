// The BlobStore interface from DESIGN.md 4.1.
//
// Conditional `put` is the only strong primitive the whole design requires;
// everything else is plain GET/PUT/LIST/DELETE. A transport (GCS, R2, S3) just
// has to implement these four methods honestly, with `put` honoring the
// conditional preconditions atomically.

/** Raw object bytes. */
export type Bytes = Uint8Array

export interface GetOptions {
  /** Inclusive byte range [start, end]. end omitted = to EOF. */
  range?: { start: number; end?: number }
}

export interface PutOptions {
  /**
   * Conditional create-if-absent. When true, the put only succeeds if no
   * object currently exists at the key. Maps to GCS ifGenerationMatch=0,
   * S3 If-None-Match: *, R2 etag precondition.
   */
  ifNoneMatch?: boolean
  /**
   * Conditional compare-and-swap. The put only succeeds if the object's
   * current version token (etag/generation) equals this value. Maps to GCS
   * ifGenerationMatch=<gen>, S3 If-Match, R2 etag precondition.
   */
  ifMatch?: string
  /** Optional content-type stored with the object. */
  contentType?: string
}

export interface PutResult {
  /**
   * Opaque version token for the newly written object. For GCS this is the
   * object generation (a number as a string). Pass it back as ifMatch to do a
   * compare-and-swap against exactly this version.
   */
  etag: string
}

export interface GetResult {
  bytes: Bytes
  etag: string
  size: number
}

export interface ListEntry {
  key: string
  etag: string
  size: number
}

/**
 * Thrown by `put` when a conditional precondition fails: the key already exists
 * (ifNoneMatch) or the current version no longer matches (ifMatch). This is the
 * single signal the lease and commit protocols are built on.
 */
export class PreconditionFailedError extends Error {
  readonly key: string
  constructor(key: string, detail?: string) {
    super(`precondition failed for key "${key}"${detail ? `: ${detail}` : ''}`)
    this.name = 'PreconditionFailedError'
    this.key = key
  }
}

export interface BlobStore {
  /** GET an object. Returns null if it does not exist. */
  get(key: string, opts?: GetOptions): Promise<GetResult | null>
  /**
   * PUT an object. With no conditional options it is an unconditional
   * overwrite. With ifNoneMatch/ifMatch it is atomic; on precondition failure
   * it throws PreconditionFailedError.
   */
  put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult>
  /** LIST objects under a prefix. */
  list(prefix: string): AsyncIterable<ListEntry>
  /** DELETE an object. Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>
  /** Just the current version token of a key, or null if absent. Cheap HEAD. */
  head(key: string): Promise<{ etag: string; size: number } | null>
}
