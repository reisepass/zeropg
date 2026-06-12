// ZeroPG — the v0 product: a real Postgres (PGlite) whose durable home is an
// object-storage bucket, with a single-writer lease and manifest-swap commits.
//
// v0 strategy (DESIGN.md roadmap): whole-datadir snapshot per commit. Crude but
// correct. The snapshot pipeline is fully streaming in both directions:
//
//   restore: GCS ranged GETs (parallel) -> gunzip -> untar -> scratch dir,
//            then PGlite opens the scratch dir via its NodeFS backend.
//   commit:  CHECKPOINT -> tar(scratch dir) -> gzip -> chunked PUT.
//
// Peak memory is one chunk, not three copies of the database — a 500MB DB
// restores inside a 1-2GiB container instead of OOMing it. On Cloud Run the
// scratch dir lives on tmpfs, so "disk" is memory; the win is that it is ONE
// copy outside the JS heap, and PGlite faults pages from it lazily instead of
// loading the whole datadir up front.
//
// WAL hygiene: Postgres keeps up to max_wal_size (default 1GB!) of recycled
// WAL segments in pg_wal/, which a naive datadir snapshot ships forever — that
// is how a 500MB database once produced a 969MB snapshot. Every writer boot
// persists small WAL GUCs via ALTER SYSTEM (they live in postgresql.auto.conf
// inside the snapshot) and commits double-CHECKPOINT first, so pg_wal stays at
// a few segments.
//
// v1 will replace per-commit full snapshots with incremental pg_wal/ segment
// shipping via a true PGlite Filesystem VFS. The public API here does not
// change when that lands.

import { PGlite } from '@electric-sql/pglite'
import { type BlobStore, PreconditionFailedError } from '@zeropg/blobstore'
import { Lease, FencedError } from '@zeropg/lease'
import {
  type Manifest,
  MANIFEST_KEY,
  encodeManifest,
  decodeManifest,
} from './manifest.js'
import { createTarStream, extractTarStream } from './tar.js'
import { createGunzip, createGzip, gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import * as nodeStream from 'node:stream'
// stream.compose() exists at runtime since Node 16.9 but @types/node omits it.
// It chains streams WITH error propagation (unlike .pipe()).
const compose = (nodeStream as unknown as {
  compose: (...streams: unknown[]) => Readable
}).compose
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * When a write becomes durable in the bucket:
 *  - 'strict':   every write commits before it returns. Slowest, zero loss.
 *  - 'interval': writes return at memory speed; a timer flushes every
 *                flushIntervalMs (Litestream-style bounded loss window).
 *  - 'sleep':    writes return at memory speed; nothing is uploaded until
 *                close()/flush() — i.e. when the instance is told to sleep
 *                (SIGTERM on scale-to-zero). Fastest; loss window is "since
 *                last flush" if the instance dies without grace.
 */
export type Durability = 'strict' | 'interval' | 'sleep'

export interface ZeroPGOptions {
  store: BlobStore
  /** Stable writer identity. Default: hostname:pid. */
  holder?: string
  /** Lease TTL ms. Default 30s. */
  leaseTtlMs?: number
  /** Durability mode. Default 'strict'. */
  durability?: Durability
  /** @deprecated alias for durability: 'interval'. */
  relaxedDurability?: boolean
  /** Interval-mode flush cadence ms. Default 1000. */
  flushIntervalMs?: number
  /**
   * Prebuilt empty-datadir snapshot (gzipped tar bytes) used to create a fresh
   * database without running initdb (~6.5s). Strongly recommended on
   * serverless. If absent, a fresh DB runs initdb once.
   */
  seedSnapshot?: Uint8Array
  /** Local scratch directory for the datadir. Default: os.tmpdir()/zeropg. */
  scratchDir?: string
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
  /** Time spent in CHECKPOINT before the snapshot. */
  dumpMs: number
  /** Time in the tar -> gzip -> chunked-PUT pipeline (overlapped). */
  uploadMs: number
  manifestMs: number
}

const SQL_WRITE = /^\s*(insert|update|delete|create|alter|drop|truncate|comment|grant|revoke|with[\s\S]*\b(insert|update|delete)\b|copy)/i

// Persisted via ALTER SYSTEM into postgresql.auto.conf, which travels inside
// the snapshot — every future boot of this database inherits them.
const WAL_GUCS = [
  ["max_wal_size", "'64MB'"],
  ["min_wal_size", "'32MB'"],
  ["wal_recycle", 'off'],
] as const

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
  private durability: Durability
  private leaseTtlMs: number
  private flushIntervalMs: number
  private now: () => number
  private scratchBase: string
  private dataDir!: string

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
    this.durability = opts.durability ?? (opts.relaxedDurability ? 'interval' : 'strict')
    this.leaseTtlMs = opts.leaseTtlMs ?? 30_000
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000
    this.now = opts.now ?? Date.now
    this.scratchBase = opts.scratchDir ?? join(tmpdir(), 'zeropg')
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
  get durabilityMode(): Durability {
    return this.durability
  }
  /** True when there are committed-in-memory writes not yet in the bucket. */
  get pendingFlush(): boolean {
    return this.dirty
  }

  /** Cold-start phase breakdown (ms), populated during open(). */
  readonly bootTimings: {
    manifestGetMs: number
    leaseMs: number
    /** Full restore pipeline: ranged download + gunzip + untar to scratch. */
    restoreMs: number
    snapshotBytes: number
    pgliteCreateMs: number
    totalMs: number
    fresh: boolean
  } = {
    manifestGetMs: 0,
    leaseMs: 0,
    restoreMs: 0,
    snapshotBytes: 0,
    pgliteCreateMs: 0,
    totalMs: 0,
    fresh: false,
  }

  static async open(opts: ZeroPGOptions): Promise<ZeroPG> {
    const db = new ZeroPG(opts)
    try {
      await db.boot(opts)
    } catch (e) {
      await db.cleanupScratch().catch(() => {})
      throw e
    }
    return db
  }

  private async boot(opts: ZeroPGOptions): Promise<void> {
    const bootStart = performance.now()
    const holder = opts.holder ?? `${process.env.HOSTNAME ?? 'host'}:${process.pid}`
    this.dataDir = join(this.scratchBase, `data-${process.pid}-${randomGeneration()}`)
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })

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
        ttlMs: this.leaseTtlMs,
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
      // 3a) Restore: stream bucket -> gunzip -> untar -> scratch dir.
      const tRestore = performance.now()
      this.bootTimings.snapshotBytes = await this.restoreInto(this.dataDir, m.snapshot)
      this.bootTimings.restoreMs = performance.now() - tRestore
      const tPg = performance.now()
      this.pg = await PGlite.create({ dataDir: this.dataDir })
      await this.pg.waitReady
      this.bootTimings.pgliteCreateMs = performance.now() - tPg
      await this.ensureWalConfig()
    } else {
      this.bootTimings.fresh = true
      // 3b) Fresh database. Seed from the prebuilt empty snapshot if provided
      //     (fast), else initdb (slow).
      this.generation = randomGeneration()
      const tPg = performance.now()
      if (opts.seedSnapshot) {
        await extractTarStream(
          compose(Readable.from([Buffer.from(opts.seedSnapshot)]), createGunzip()),
          this.dataDir,
        )
      }
      this.pg = await PGlite.create({ dataDir: this.dataDir })
      await this.pg.waitReady
      this.bootTimings.pgliteCreateMs = performance.now() - tPg
      await this.ensureWalConfig()
      // Initial commit, create-if-absent so two cold boots can't both seed.
      await this.commitInitial()
    }

    this.bootTimings.totalMs = performance.now() - bootStart

    if (this.durability === 'interval') {
      this.flushTimer = setInterval(() => {
        void this.flush().catch(() => {})
      }, this.flushIntervalMs)
      // Don't keep the process alive solely for the flush timer.
      this.flushTimer.unref?.()
    }
  }

  /** Stream a snapshot object into dir; returns its compressed size. */
  private async restoreInto(dir: string, snapshotKey: string): Promise<number> {
    const src = await this.store.getStream(snapshotKey)
    if (!src) throw new Error(`manifest references missing snapshot ${snapshotKey}`)
    await extractTarStream(compose(Readable.from(src.stream), createGunzip()), dir)
    return src.size
  }

  /** Persist WAL-shrinking GUCs into the datadir (travels with snapshots). */
  private async ensureWalConfig(): Promise<void> {
    try {
      const cur = await this.pg.query<{ setting: string }>(
        "SELECT setting FROM pg_settings WHERE name = 'max_wal_size'",
      )
      if (cur.rows[0]?.setting === '64') return // already configured (MB units)
      for (const [k, v] of WAL_GUCS) {
        await this.pg.exec(`ALTER SYSTEM SET ${k} = ${v}`)
      }
      await this.pg.query('SELECT pg_reload_conf()')
    } catch {
      // Non-fatal: snapshots are just bigger than they need to be.
    }
  }

  /**
   * CHECKPOINT, then stream tar(datadir) -> gzip -> chunked PUT. The datadir is
   * quiescent during the tar: we hold the single PGlite connection and commits
   * are serialized behind commitInFlight.
   */
  private async uploadSnapshot(
    key: string,
  ): Promise<{ snapshotBytes: number; dumpMs: number; uploadMs: number }> {
    const t0 = performance.now()
    try {
      // Twice: the first moves the redo point past the write burst, the second
      // lets Postgres unlink (wal_recycle=off) segments behind it.
      await this.pg.exec('CHECKPOINT')
      await this.pg.exec('CHECKPOINT')
    } catch {
      // CHECKPOINT may be unavailable in some PGlite builds; snapshot anyway.
    }
    const dumpMs = performance.now() - t0

    const tUp = performance.now()
    let snapshotBytes = 0
    const gz = compose(Readable.from(createTarStream(this.dataDir)), createGzip({ level: 1 }))
    const counted = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of gz as AsyncIterable<Uint8Array>) {
        snapshotBytes += chunk.length
        yield chunk
      }
    }
    await this.store.putStream(key, counted(), { contentType: 'application/gzip' })
    return { snapshotBytes, dumpMs, uploadMs: performance.now() - tUp }
  }

  private async commitInitial(): Promise<void> {
    const snapshotKey = `generations/${this.generation}/snapshot-0.tar.gz`
    await this.uploadSnapshot(snapshotKey)
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
        await this.pg.close()
        await rm(this.dataDir, { recursive: true, force: true })
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
        await this.restoreInto(this.dataDir, cm.snapshot)
        this.pg = await PGlite.create({ dataDir: this.dataDir })
        await this.pg.waitReady
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
    const nextSeq = this.manifest.commitSeq + 1
    const snapshotKey = `generations/${this.generation}/snapshot-${nextSeq}.tar.gz`
    const { snapshotBytes, dumpMs, uploadMs } = await this.uploadSnapshot(snapshotKey)

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

    const prevSeq = this.manifest.commitSeq
    this.manifest = m
    this.manifestEtag = etag
    this.dirty = false
    // Best-effort: delete the now-superseded previous snapshot in this
    // generation to bound bucket growth (keep current only). The manifest
    // never references it again, so this is safe.
    if (prevSeq >= 0) {
      const prevKey = `generations/${this.generation}/snapshot-${prevSeq}.tar.gz`
      void this.store.delete(prevKey).catch(() => {})
    }
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      snapshotKey,
      snapshotBytes,
      dumpMs,
      uploadMs,
      manifestMs,
    }
  }

  /** Flush pending writes (interval/sleep mode / explicit). No-op if clean. */
  async flush(): Promise<CommitInfo | null> {
    return this.commit()
  }

  /** Mark the database dirty after writes made via `raw` (bypassing exec/query). */
  markDirty(): void {
    this.dirty = true
  }

  // ---- Query surface (delegates to PGlite, commits on writes in strict mode) ----

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql)
    await this.afterWrite(SQL_WRITE.test(sql))
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number; execMs: number; commit: CommitInfo | null }> {
    const t0 = performance.now()
    const r = await this.pg.query<T>(sql, params)
    const execMs = performance.now() - t0
    const commit = await this.afterWrite(SQL_WRITE.test(sql))
    return { rows: r.rows, affectedRows: r.affectedRows, execMs, commit }
  }

  /** Run a function inside a Postgres transaction, then commit durably. */
  async transaction<T>(fn: (tx: import('@electric-sql/pglite').Transaction) => Promise<T>): Promise<T> {
    const out = await this.pg.transaction(fn)
    await this.afterWrite(true)
    return out
  }

  /** @returns the CommitInfo when this write triggered a durable commit. */
  private async afterWrite(isWrite: boolean): Promise<CommitInfo | null> {
    if (!isWrite) return null
    this.dirty = true
    if (this.durability === 'strict') return this.commit()
    return null
  }

  /**
   * Re-validate the lease on the request path (E4 bet b: no background work),
   * and renew it once it is past half-life so a warm instance under traffic
   * keeps writership indefinitely. Throws FencedError if taken over.
   */
  async validateLease(): Promise<boolean> {
    if (!this.lease) return true
    const ok = await this.lease.validate()
    if (ok && this.lease.expiresInMs(this.now()) < this.leaseTtlMs / 2) {
      await this.lease.renew()
    }
    return ok
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer) clearInterval(this.flushTimer)
    try {
      if (this.dirty) {
        // Bypass commit()'s closed-check; this is the sleep-mode flush.
        await (this.commitInFlight ?? this.doCommit())
      }
    } finally {
      if (this.lease) await this.lease.release().catch(() => {})
      await this.pg.close()
      await this.cleanupScratch().catch(() => {})
    }
  }

  private async cleanupScratch(): Promise<void> {
    if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true })
  }

  // ---- Helpers ----

  /** Build a reusable empty-datadir snapshot (gzipped) to seed fresh DBs fast.
   * The WAL GUCs are baked in so databases born from it never bloat. */
  static async buildEmptySnapshot(): Promise<Uint8Array> {
    const pg = new PGlite()
    await pg.waitReady
    for (const [k, v] of WAL_GUCS) {
      await pg.exec(`ALTER SYSTEM SET ${k} = ${v}`)
    }
    const file = await pg.dumpDataDir('none')
    const raw = new Uint8Array(await file.arrayBuffer())
    await pg.close()
    return gzipSync(raw, { level: 1 })
  }
}
