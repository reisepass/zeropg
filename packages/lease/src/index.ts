// The writer lease — the part Litestream never built.
//
// Goal (DESIGN.md 4.4): at most one committing writer, zombie-proof, with no
// coordination service. Built entirely on the object store's one strong
// primitive: atomic conditional writes.
//
//   acquire()  - conditional create of lease.json. If it exists and is
//                unexpired -> LockedError. If expired -> CAS takeover,
//                incrementing the fencing token.
//   renew()    - CAS on our own version; extends expiry. Failure => we were
//                taken over => FencedError.
//   release()  - CAS-delete our lease so the next writer starts fresh.
//
// Fencing: the token is monotonic across takeovers. Every commit embeds it, so
// a stale (zombie) holder physically cannot advance the manifest. Correctness
// comes from the conditional writes, never from the clock — clock skew only
// changes how aggressively an expired lease is taken over.

import {
  type BlobStore,
  PreconditionFailedError,
} from '@zeropg/blobstore'

export interface LeaseBody {
  holder: string
  fencingToken: number
  acquiredAt: string
  expiresAt: string
}

/** The lease is currently held by someone else and not yet expired. */
export class LockedError extends Error {
  readonly holder: string
  readonly expiresAt: string
  constructor(holder: string, expiresAt: string) {
    super(`database is locked by writer "${holder}" until ${expiresAt}`)
    this.name = 'LockedError'
    this.holder = holder
    this.expiresAt = expiresAt
  }
}

/** We lost the lease (taken over / changed underneath us). We are a zombie. */
export class FencedError extends Error {
  readonly fencingToken: number
  constructor(fencingToken: number, detail = '') {
    super(`writer fenced: lease with token ${fencingToken} is no longer ours${detail ? ` (${detail})` : ''}`)
    this.name = 'FencedError'
    this.fencingToken = fencingToken
  }
}

export interface LeaseOptions {
  /** Stable identity of this writer (e.g. instance id + pid). */
  holder: string
  /** Lease time-to-live in milliseconds. */
  ttlMs: number
  /** Injectable clock for deterministic TTL tests. Defaults to Date.now. */
  now?: () => number
  /**
   * A floor for the fencing token, sourced from the manifest (DESIGN.md 4.4).
   * The acquired token is always > this AND > any token in an existing lease.
   * Guarantees monotonicity even across a clean release that deleted the lease.
   */
  tokenFloor?: number
  /** Lease object key. Default "lease.json". */
  key?: string
  /** Max takeover retries when racing another taker. Default 5. */
  maxTakeoverRetries?: number
}

export class Lease {
  private store: BlobStore
  private holder: string
  private ttlMs: number
  private now: () => number
  private tokenFloor: number
  private key: string
  private maxRetries: number

  private etag: string | null = null
  private body: LeaseBody | null = null

  constructor(store: BlobStore, opts: LeaseOptions) {
    this.store = store
    this.holder = opts.holder
    this.ttlMs = opts.ttlMs
    this.now = opts.now ?? Date.now
    this.tokenFloor = opts.tokenFloor ?? 0
    this.key = opts.key ?? 'lease.json'
    this.maxRetries = opts.maxTakeoverRetries ?? 5
  }

  get fencingToken(): number {
    if (!this.body) throw new Error('lease not held')
    return this.body.fencingToken
  }
  get currentEtag(): string | null {
    return this.etag
  }
  get held(): boolean {
    return this.body !== null
  }
  /** Milliseconds until the held lease expires (negative if already past). */
  expiresInMs(now: number = this.now()): number {
    if (!this.body) return -1
    return Date.parse(this.body.expiresAt) - now
  }

  private encode(body: LeaseBody): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(body))
  }
  private decode(bytes: Uint8Array): LeaseBody {
    return JSON.parse(new TextDecoder().decode(bytes)) as LeaseBody
  }

  private makeBody(fencingToken: number): LeaseBody {
    const t = this.now()
    return {
      holder: this.holder,
      fencingToken,
      acquiredAt: new Date(t).toISOString(),
      expiresAt: new Date(t + this.ttlMs).toISOString(),
    }
  }

  private isExpired(body: LeaseBody): boolean {
    return this.now() >= Date.parse(body.expiresAt)
  }

  /**
   * Acquire the lease. Throws LockedError if held and unexpired. On success the
   * fencing token is available via `fencingToken`.
   */
  async acquire(): Promise<number> {
    // Fast path: create-if-absent with token = floor + 1.
    const freshToken = this.tokenFloor + 1
    try {
      const body = this.makeBody(freshToken)
      const { etag } = await this.store.put(this.key, this.encode(body), {
        ifNoneMatch: true,
        contentType: 'application/json',
      })
      this.etag = etag
      this.body = body
      return freshToken
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e
      // Lease exists — fall through to inspect / take over.
    }

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const existing = await this.store.get(this.key)
      if (!existing) {
        // Vanished between create and get (clean release). Retry create.
        try {
          const body = this.makeBody(Math.max(freshToken, this.tokenFloor + 1))
          const { etag } = await this.store.put(this.key, this.encode(body), {
            ifNoneMatch: true,
            contentType: 'application/json',
          })
          this.etag = etag
          this.body = body
          return body.fencingToken
        } catch (e) {
          if (e instanceof PreconditionFailedError) continue
          throw e
        }
      }
      const current = this.decode(existing.bytes)
      if (!this.isExpired(current)) {
        throw new LockedError(current.holder, current.expiresAt)
      }
      // Expired — take over via CAS on the existing version. Token strictly
      // increases, and never drops below the manifest-sourced floor.
      const takeoverToken = Math.max(current.fencingToken, this.tokenFloor) + 1
      const body = this.makeBody(takeoverToken)
      try {
        const { etag } = await this.store.put(this.key, this.encode(body), {
          ifMatch: existing.etag,
          contentType: 'application/json',
        })
        this.etag = etag
        this.body = body
        return takeoverToken
      } catch (e) {
        if (e instanceof PreconditionFailedError) continue // lost the race; re-evaluate
        throw e
      }
    }
    throw new Error(`failed to acquire lease after ${this.maxRetries} takeover attempts (contention)`)
  }

  /**
   * Renew (heartbeat) the lease, extending expiry. CAS on our own version; if
   * it fails we were taken over => FencedError. Becoming a zombie is defined as
   * failing to renew, so this is where a zombie learns the truth.
   */
  async renew(): Promise<void> {
    if (!this.body || !this.etag) throw new Error('lease not held; call acquire first')
    const body = this.makeBody(this.body.fencingToken)
    try {
      const { etag } = await this.store.put(this.key, this.encode(body), {
        ifMatch: this.etag,
        contentType: 'application/json',
      })
      this.etag = etag
      this.body = body
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        const token = this.body.fencingToken
        this.body = null
        this.etag = null
        throw new FencedError(token, 'renew CAS failed')
      }
      throw e
    }
  }

  /**
   * Release the lease so the next writer can acquire fresh (token = floor+1)
   * without waiting for TTL expiry. CAS-guarded: if we no longer own it, we are
   * already fenced and there is nothing to release.
   */
  async release(): Promise<void> {
    if (!this.body || !this.etag) return
    // Verify we still own it before deleting (delete is unconditional in the
    // BlobStore API, so guard with a CAS read).
    const current = await this.store.head(this.key)
    if (current && current.etag === this.etag) {
      await this.store.delete(this.key)
    }
    this.body = null
    this.etag = null
  }

  /** Re-validate the lease against the store without mutating expiry. Returns
   * true if we still hold it; used on the request path under CPU throttling
   * (DESIGN bet E4.1.b: no background heartbeat needed). */
  async validate(): Promise<boolean> {
    if (!this.body || !this.etag) return false
    const current = await this.store.head(this.key)
    if (!current || current.etag !== this.etag) {
      const token = this.body.fencingToken
      this.body = null
      this.etag = null
      throw new FencedError(token, 'validate: lease changed')
    }
    // We still own the object; is it still within TTL?
    return !this.isExpired(this.body)
  }
}
