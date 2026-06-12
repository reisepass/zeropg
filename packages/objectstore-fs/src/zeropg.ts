// ZeroPG — the v0 product: a real Postgres (PGlite) whose durable home is an
// object-storage bucket, with a single-writer lease and manifest-swap commits.
//
// v0 strategy (DESIGN.md roadmap): whole-datadir snapshot per commit. Crude but
// correct, fine for MB-scale DBs. `dumpDataDir()` is the snapshot; a conditional
// PUT of manifest.json is the atomic commit. The lease + fencing token make a
// second/zombie writer physically unable to advance the manifest.
//
// v1 will replace per-commit full snapshots with incremental pg_wal/ segment
// shipping via a true PGlite Filesystem VFS. The public API here does not change
// when that lands.

import { PGlite } from '@electric-sql/pglite'
import { type BlobStore, PreconditionFailedError } from '@zeropg/blobstore'
import { Lease, FencedError } from '@zeropg/lease'
import {
  type Manifest,
  MANIFEST_KEY,
  encodeManifest,
  decodeManifest,
} from './manifest.js'
import { gzipSync, gunzipSync } from 'node:zlib'

export interface ZeroPGOptions {
  store: BlobStore
  /** Stable writer identity. Default: hostname:pid. */
  holder?: string
  /** Lease TTL ms. Default 30s. */
  leaseTtlMs?: number
  /**
   * Strict (false, default): a write resolves only after its commit is durable
   * in the bucket. Relaxed (true): writes are acknowledged immediately and
   * flushed on an interval / on close (bounded loss window, Litestream-like).
   */
  relaxedDurability?: boolean
  /** Relaxed-mode flush cadence ms. Default 1000. */
  flushIntervalMs?: number
  /**
   * Prebuilt empty-datadir snapshot (gzipped tar bytes) used to create a fresh
   * database without running initdb (~6.5s). Strongly recommended on
   * serverless. If absent, a fresh DB runs initdb once.
   */
  seedSnapshot?: Uint8Array
  /** Injectable clock (tests). */
  now?: () => number
  /** If true, skip taking the lease (single-tenant platform guarantees it).
   * The lease is still validated as belt-and-suspenders if present. */
  noLease?: boolean
}

export interface CommitInfo {
  commitSeq: number
  generation: string
  snapshotKey: string
  snapshotBytes: number
  dumpMs: number
  uploadMs: number
  manifestMs: number
}

const SQL_WRITE = /^\s*(insert|update|delete|create|alter|drop|truncate|comment|grant|revoke|with[\s\S]*\b(insert|update|delete)\b|copy)/i

function randomGeneration(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export class ZeroPG {
  readonly store: BlobStore
  private pg!: PGlite
  private lease: Lease | null = null
  private noLease: boolean
  private relaxed: boolean
  private flushIntervalMs: number
  private now: () => number

  private manifest!: Manifest
  private manifestEtag: string | null = null
  private generation!: string
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null
  private closed = false
  private commitInFlight: Promise<CommitInfo | null> | null = null

  private constructor(opts: ZeroPGOptions) {
    this.store = opts.store
    this.noLease = opts.noLease ?? false
    this.relaxed = opts.relaxedDurability ?? false
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000
    this.now = opts.now ?? Date.now
  }

  /** The underlying PGlite instance (escape hatch / ORM adapters). */
  get raw(): PGlite {
    return this.pg
  }
  get fencingToken(): number | null {
    return this.lease?.held ? this.lease.fencingToken : null
  }
  get currentManifest(): Manifest {
    return this.manifest
  }

  /** Cold-start phase breakdown (ms), populated during open(). */
  readonly bootTimings: {
    manifestGetMs: number
    leaseMs: number
    snapshotGetMs: number
    snapshotBytes: number
    gunzipMs: number
    pgliteCreateMs: number
    totalMs: number
    fresh: boolean
  } = {
    manifestGetMs: 0,
    leaseMs: 0,
    snapshotGetMs: 0,
    snapshotBytes: 0,
    gunzipMs: 0,
    pgliteCreateMs: 0,
    totalMs: 0,
    fresh: false,
  }

  static async open(opts: ZeroPGOptions): Promise<ZeroPG> {
    const db = new ZeroPG(opts)
    await db.boot(opts)
    return db
  }

  private async boot(opts: ZeroPGOptions): Promise<void> {
    const bootStart = performance.now()
    const holder = opts.holder ?? `${process.env.HOSTNAME ?? 'host'}:${process.pid}`

    // 1) Read the manifest to learn the current commit point + token floor.
    const tMan = performance.now()
    const existing = await this.store.get(MANIFEST_KEY)
    this.bootTimings.manifestGetMs = performance.now() - tMan

    // 2) Acquire the lease, with the fencing-token floor sourced from the
    //    manifest so tokens are monotonic across the whole bucket history.
    const tokenFloor = existing ? decodeManifest(existing.bytes).fencingToken : 0
    if (!this.noLease) {
      this.lease = new Lease(this.store, {
        holder,
        ttlMs: opts.leaseTtlMs ?? 30_000,
        now: this.now,
        tokenFloor,
      })
      const tLease = performance.now()
      await this.lease.acquire()
      this.bootTimings.leaseMs = performance.now() - tLease
    }

    if (existing) {
      const m = decodeManifest(existing.bytes)
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`,
        )
      }
      this.manifest = m
      this.manifestEtag = existing.etag
      this.generation = m.generation
      // 3a) Restore from the snapshot the manifest points at.
      const tSnap = performance.now()
      const snap = await this.store.get(m.snapshot)
      this.bootTimings.snapshotGetMs = performance.now() - tSnap
      if (!snap) throw new Error(`manifest references missing snapshot ${m.snapshot}`)
      this.bootTimings.snapshotBytes = snap.bytes.byteLength
      const tGz = performance.now()
      const tar = gunzipSync(snap.bytes)
      this.bootTimings.gunzipMs = performance.now() - tGz
      const tPg = performance.now()
      this.pg = await PGlite.create({ loadDataDir: new Blob([tar]) })
      await this.pg.waitReady
      this.bootTimings.pgliteCreateMs = performance.now() - tPg
    } else {
      this.bootTimings.fresh = true
      // 3b) Fresh database. Seed from the prebuilt empty snapshot if provided
      //     (fast), else initdb (slow).
      this.generation = randomGeneration()
      const tPg = performance.now()
      if (opts.seedSnapshot) {
        const tar = gunzipSync(opts.seedSnapshot)
        this.pg = await PGlite.create({ loadDataDir: new Blob([tar]) })
      } else {
        this.pg = new PGlite()
      }
      await this.pg.waitReady
      this.bootTimings.pgliteCreateMs = performance.now() - tPg
      // Initial commit, create-if-absent so two cold boots can't both seed.
      await this.commitInitial()
    }

    this.bootTimings.totalMs = performance.now() - bootStart

    if (this.relaxed) {
      this.flushTimer = setInterval(() => {
        void this.flush().catch(() => {})
      }, this.flushIntervalMs)
      // Don't keep the process alive solely for the flush timer.
      this.flushTimer.unref?.()
    }
  }

  private async snapshotBytes(): Promise<{ bytes: Uint8Array; dumpMs: number }> {
    const t0 = performance.now()
    // CHECKPOINT first: flush dirty buffers and let Postgres recycle/truncate
    // pg_wal so the whole-datadir tar doesn't carry stale WAL. Without this, a
    // burst of writes can make the snapshot much larger than the data itself.
    try {
      await this.pg.exec('CHECKPOINT')
    } catch {
      // CHECKPOINT may be unavailable in some PGlite builds; snapshot anyway.
    }
    const file = await this.pg.dumpDataDir('none') // we gzip ourselves for timing control
    const raw = new Uint8Array(await file.arrayBuffer())
    const bytes = gzipSync(raw, { level: 1 })
    return { bytes, dumpMs: performance.now() - t0 }
  }

  private async commitInitial(): Promise<void> {
    const { bytes } = await this.snapshotBytes()
    const snapshotKey = `generations/${this.generation}/snapshot-0.tar.gz`
    await this.store.put(snapshotKey, bytes, { contentType: 'application/gzip' })
    const m: Manifest = {
      version: 1,
      generation: this.generation,
      fencingToken: this.lease?.held ? this.lease.fencingToken : 1,
      snapshot: snapshotKey,
      walSegments: [],
      commitSeq: 0,
      committedAt: new Date(this.now()).toISOString(),
    }
    try {
      const { etag } = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
        ifNoneMatch: true,
        contentType: 'application/json',
      })
      this.manifest = m
      this.manifestEtag = etag
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        // Someone else seeded first; adopt their manifest + restore.
        const cur = await this.store.get(MANIFEST_KEY)
        if (!cur) throw e
        const cm = decodeManifest(cur.bytes)
        this.manifest = cm
        this.manifestEtag = cur.etag
        this.generation = cm.generation
        const snap = await this.store.get(cm.snapshot)
        if (snap) {
          await this.pg.close()
          this.pg = await PGlite.create({ loadDataDir: new Blob([gunzipSync(snap.bytes)]) })
          await this.pg.waitReady
        }
      } else throw e
    }
  }

  /**
   * The commit: snapshot the datadir, upload it, then CAS the manifest. The
   * manifest PUT IS the commit. Precondition failure means the lease was lost
   * (a newer writer advanced the manifest) -> FencedError, never a blind retry.
   */
  async commit(): Promise<CommitInfo | null> {
    if (this.closed) throw new Error('database is closed')
    if (!this.dirty) return null
    // Serialize commits; coalesce concurrent callers onto the in-flight one.
    if (this.commitInFlight) return this.commitInFlight
    this.commitInFlight = this.doCommit().finally(() => {
      this.commitInFlight = null
    })
    return this.commitInFlight
  }

  private async doCommit(): Promise<CommitInfo> {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken
    const { bytes, dumpMs } = await this.snapshotBytes()
    const nextSeq = this.manifest.commitSeq + 1
    const snapshotKey = `generations/${this.generation}/snapshot-${nextSeq}.tar.gz`

    const tUp = performance.now()
    await this.store.put(snapshotKey, bytes, { contentType: 'application/gzip' })
    const uploadMs = performance.now() - tUp

    const m: Manifest = {
      ...this.manifest,
      fencingToken: token,
      snapshot: snapshotKey,
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString(),
    }
    const tMan = performance.now()
    let etag: string
    try {
      const r = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
        ifMatch: this.manifestEtag ?? undefined,
        contentType: 'application/json',
      })
      etag = r.etag
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        // Manifest advanced by someone else => we are fenced. The snapshot we
        // just uploaded is orphaned garbage (no manifest references it).
        throw new FencedError(token, 'manifest CAS failed at commit')
      }
      throw e
    }
    const manifestMs = performance.now() - tMan

    this.manifest = m
    this.manifestEtag = etag
    this.dirty = false
    // Best-effort: delete the now-superseded previous snapshot in this
    // generation to bound bucket growth (keep current only). The manifest
    // never references it again, so this is safe.
    const prevKey = `generations/${this.generation}/snapshot-${this.manifest.commitSeq - 1}.tar.gz`
    if (this.manifest.commitSeq - 1 >= 0) {
      void this.store.delete(prevKey).catch(() => {})
    }
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      snapshotKey,
      snapshotBytes: bytes.byteLength,
      dumpMs,
      uploadMs,
      manifestMs,
    }
  }

  /** Flush pending writes (relaxed mode / explicit). No-op if not dirty. */
  async flush(): Promise<CommitInfo | null> {
    return this.commit()
  }

  // ---- Query surface (delegates to PGlite, commits on writes in strict mode) ----

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql)
    await this.afterWrite(SQL_WRITE.test(sql))
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }> {
    const r = await this.pg.query<T>(sql, params)
    await this.afterWrite(SQL_WRITE.test(sql))
    return { rows: r.rows, affectedRows: r.affectedRows }
  }

  /** Run a function inside a Postgres transaction, then commit durably. */
  async transaction<T>(fn: (tx: import('@electric-sql/pglite').Transaction) => Promise<T>): Promise<T> {
    const out = await this.pg.transaction(fn)
    this.dirty = true
    if (!this.relaxed) await this.commit()
    return out
  }

  private async afterWrite(isWrite: boolean): Promise<void> {
    if (!isWrite) return
    this.dirty = true
    if (!this.relaxed) await this.commit()
  }

  /** Re-validate the lease on the request path (E4 bet b: no background work). */
  async validateLease(): Promise<boolean> {
    if (!this.lease) return true
    return this.lease.validate()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer) clearInterval(this.flushTimer)
    try {
      if (this.dirty) await this.commit()
    } finally {
      if (this.lease) await this.lease.release().catch(() => {})
      await this.pg.close()
    }
  }

  // ---- Helpers ----

  /** Build a reusable empty-datadir snapshot (gzipped) to seed fresh DBs fast. */
  static async buildEmptySnapshot(): Promise<Uint8Array> {
    const pg = new PGlite()
    await pg.waitReady
    const file = await pg.dumpDataDir('none')
    const raw = new Uint8Array(await file.arrayBuffer())
    await pg.close()
    return gzipSync(raw, { level: 1 })
  }
}
