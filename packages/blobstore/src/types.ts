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

export interface GetStreamResult {
  /** Object bytes, in order. Consume with `for await`. */
  stream: AsyncIterable<Uint8Array>
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

/**
 * Per-provider cost/limit table (COST-MODEL.md). Policy above the store —
 * commit pacing, snapshot cadence, retention — is computed from this instead
 * of being hardcoded per cloud. Prices drift: pin with a date, re-verify.
 */
export interface CostModel {
  /** Date the numbers were last checked against the provider's price page. */
  asOf: string
  writeOpUsd: number
  readOpUsd: number
  storageGbMonthUsd: number
  /** 0 where egress to the internet is free (R2). */
  internetEgressGbUsd: number
  /**
   * Minimum billed storage duration of this store's tier, in days (Track D).
   * Archive/Glacier/Infrequent-Access classes charge for a floor regardless of
   * when an object is deleted (GCS Archive 365d, Coldline 90d; S3 Glacier
   * 90-180d): deleting earlier still pays the remainder. The retention engine
   * reads this to refuse early deletes and to warn when a configured policy
   * would routinely churn under it. Omit/0 for Standard-class stores, where a
   * delete is free at any age. See docs/D-COLD-BACKUP.md "cold-tier" note.
   */
  minStorageDurationDays?: number
  /**
   * Sustained write cap per object NAME (GCS: ~1/s, soft, 429s beyond).
   * The manifest is one object name, so this caps strict-mode commit rate and
   * forces group-commit batching above it. Omit when no such limit exists.
   */
  maxWritesPerObjectPerSec?: number
  /**
   * Strength of the store's conditional-write primitive — the property the
   * whole lease/manifest design rests on (TODO B3):
   *
   *  - `'generation'`: the precondition compares a server-assigned, strictly
   *    monotonic *generation number* (GCS `ifGenerationMatch`). A generation is
   *    never reused, so there is no ABA window: a token you hold is either the
   *    current version or it is in the past, never "the past, reincarnated".
   *  - `'etag'`: the precondition compares an *ETag* (S3 / R2 `If-Match` /
   *    `If-None-Match`). An ETag is a content hash (or opaque per-version id);
   *    it is unique per write in practice, but it is not a monotonic counter,
   *    so there is a *theoretical* ABA window — write A (etag X), overwrite to
   *    B, overwrite back to byte-identical A (etag X again) could let a stale
   *    `If-Match: X` succeed against what it thinks is the original A.
   *
   * Why ABA is moot for zeropg (see docs/R2.md): the two CAS sites never reuse
   * a name with reverting content. (1) The lease is create-if-absent + CAS to a
   * strictly *incrementing* fencing token, so the body never reverts to an
   * earlier value. (2) The numbered-immutable-manifest plan (ROADMAP v2 #1)
   * makes every commit a create-if-absent on a fresh, never-reused name —
   * which has no ABA window at all on any etag store.
   */
  casStrength?: 'generation' | 'etag'
  /**
   * Free monthly allowance, where the provider grants one (R2: 10GB stored +
   * 1M Class A + 10M Class B per month). Feeds the README cost calculator.
   */
  freeTier?: { storageGb: number; writeOps: number; readOps: number }
}

export interface BlobStore {
  /** Provider cost/limit table, when the transport knows it. */
  readonly cost?: CostModel
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
  /**
   * GET an object as an ordered byte stream without buffering it in memory.
   * Implementations may fetch multiple ranges concurrently under the hood
   * (pinned to one version) — large-snapshot restores live on this path.
   */
  getStream(key: string): Promise<GetStreamResult | null>
  /**
   * PUT an object from a byte stream (chunked upload, no Content-Length).
   * Same conditional semantics as `put`. Snapshot uploads live on this path so
   * a commit never needs the whole archive in memory.
   */
  putStream(key: string, source: AsyncIterable<Uint8Array>, opts?: PutOptions): Promise<PutResult>
}
