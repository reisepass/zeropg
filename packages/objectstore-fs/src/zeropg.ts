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
import { Lease, FencedError, LockedError } from '@zeropg/lease'
import {
  type Manifest,
  type WalSegment,
  MANIFEST_KEY,
  encodeManifest,
  decodeManifest,
} from './manifest.js'
import { createTarStream, extractTarStream, largestFile } from './tar.js'
import { createGunzip, createGzip, gzipSync, crc32 } from 'node:zlib'
import { Readable } from 'node:stream'
import * as nodeStream from 'node:stream'
// stream.compose() exists at runtime since Node 16.9 but @types/node omits it.
// It chains streams WITH error propagation (unlike .pipe()).
const compose = (nodeStream as unknown as {
  compose: (...streams: unknown[]) => Readable
}).compose
import { mkdir, rm, readdir, stat, open } from 'node:fs/promises'
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
  /**
   * How long boot may wait for a held lease to expire before giving up
   * (LockedError). Revision switches and crash-restarts routinely boot a new
   * instance while the previous holder's lease has not yet expired; waiting
   * here (instead of failing the boot) is what makes those windows seamless.
   * Default 0 (fail fast).
   */
  acquireTimeoutMs?: number
  /** Durability mode. Default 'strict'. */
  durability?: Durability
  /** @deprecated alias for durability: 'interval'. */
  relaxedDurability?: boolean
  /** Interval-mode flush cadence ms. Default 1000. */
  flushIntervalMs?: number
  /**
   * Minimum spacing between manifest CASes (group-commit window). Defaults
   * from the store's cost model: GCS caps sustained writes per object name at
   * ~1/s, so back-to-back strict commits must batch. Writes arriving inside
   * the window coalesce into the next commit. 0 disables pacing.
   */
  commitIntervalMs?: number
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
  /** 'incremental': shipped only the WAL bytes this commit appended.
   *  'snapshot': full-datadir compaction (initial commit, threshold, or
   *  migration from a v1 manifest). */
  mode: 'incremental' | 'snapshot'
  /** Snapshot key ('snapshot' mode) or the last segment key ('incremental'). */
  snapshotKey: string
  /** Bytes uploaded by this commit (segment bytes or whole snapshot). */
  snapshotBytes: number
  /** Segments shipped by this commit (0 in 'snapshot' mode). */
  segments: number
  /** CHECKPOINT (+ pg_switch_wal at compaction) time before upload. */
  dumpMs: number
  /** Upload time (segment PUTs, or the tar->gzip->PUT pipeline). */
  uploadMs: number
  manifestMs: number
}

const SQL_WRITE = /^\s*(insert|update|delete|create|alter|drop|truncate|comment|grant|revoke|with[\s\S]*\b(insert|update|delete)\b|copy)/i

// Persisted via ALTER SYSTEM into postgresql.auto.conf, which travels inside
// the snapshot — every future boot of this database inherits them.
//
// wal_recycle=off + wal_init_zero=off make pg_wal files strictly append-only
// (created small, grown by appends, never rewritten, never zero-padded).
// Incremental WAL shipping is built on that invariant: "new bytes" is just
// "file grew past its high-water mark".
const WAL_GUCS = [
  ["max_wal_size", "'64MB'"],
  ["min_wal_size", "'32MB'"],
  ["wal_recycle", 'off'],
  ["wal_init_zero", 'off'],
  // Incremental shipping reads committed WAL straight off the filesystem; a
  // commit must have write()n its WAL before it returns or the scan misses it.
  ["synchronous_commit", 'on'],
] as const

// Compaction thresholds: when the segment tail outgrows these, the next commit
// rolls a fresh full snapshot instead of appending more segments.
const COMPACT_AT_WAL_BYTES = 16 * 1024 * 1024
const COMPACT_AT_SEGMENTS = 64

// ---- WAL LSN arithmetic ----
// Postgres preallocates pg_wal segment files at their full size (16MB) and
// fills them by overwrite, so file sizes say nothing about where WAL ends.
// The only truth is the flush LSN; these helpers map LSNs onto file names and
// offsets, mirroring XLogFileName()/XLByteToSeg() in xlog_internal.h.

function parseLsn(s: string): bigint {
  const [hi, lo] = s.split('/')
  return (BigInt(parseInt(hi, 16)) << 32n) | BigInt(parseInt(lo, 16))
}
function formatLsn(l: bigint): string {
  return `${(l >> 32n).toString(16).toUpperCase()}/${(l & 0xffffffffn).toString(16).toUpperCase()}`
}
function walFileName(tli: number, lsn: bigint, segBytes: number): string {
  const segno = lsn / BigInt(segBytes)
  const perId = 0x1_0000_0000n / BigInt(segBytes)
  const hex = (n: bigint) => n.toString(16).toUpperCase().padStart(8, '0')
  return hex(BigInt(tli)) + hex(segno / perId) + hex(segno % perId)
}

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

  // ---- incremental WAL shipping state ----
  /** Everything below this LSN is durable in the bucket (snapshot + shipped
   * ranges). The next incremental commit ships [lastShippedLsn, flushLsn). */
  private lastShippedLsn = 0n
  /** Segment bytes shipped since the last compaction (threshold input). */
  private walBytesSinceSnapshot = 0
  /** WAL segment file size + timeline, validated against the live cluster. */
  private walSegBytes = 0
  private walTli = 1
  /** False when this session can't do LSN-mapped shipping (function missing,
   * or our file-name math disagrees with pg_walfile_name). */
  private incrementalCapable = false
  /** Force the next commit to compact (e.g. the manifest predates v2 and has
   * no walFlushLsn to resume shipping from). */
  private forceCompactNext = false

  private constructor(opts: ZeroPGOptions) {
    this.store = opts.store
    this.noLease = opts.noLease ?? false
    this.durability = opts.durability ?? (opts.relaxedDurability ? 'interval' : 'strict')
    this.leaseTtlMs = opts.leaseTtlMs ?? 30_000
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000
    const capPerSec = opts.store.cost?.maxWritesPerObjectPerSec
    this.commitIntervalMs = opts.commitIntervalMs ?? (capPerSec ? Math.ceil(1000 / capPerSec) : 0)
    this.now = opts.now ?? Date.now
    this.scratchBase = opts.scratchDir ?? join(tmpdir(), 'zeropg')
  }

  private commitIntervalMs: number
  private lastCasAt = 0

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
      const deadline = tLease + (opts.acquireTimeoutMs ?? 0)
      for (;;) {
        try {
          await this.lease.acquire()
          break
        } catch (e) {
          if (!(e instanceof LockedError) || performance.now() >= deadline) throw e
          // Holder is alive (or recently died); its lease expires within TTL.
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      this.bootTimings.leaseMs = performance.now() - tLease
    }

    if (existing) {
      const m = decodeManifest(existing.bytes)
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`,
        )
      }
      // 3a) Restore: stream bucket -> gunzip -> untar -> scratch dir.
      await this.adoptManifest(m, existing.etag)
      // If we took the lease over, the previous holder may still be running.
      // Stamp our fencing token into the manifest so its next commit fails
      // the CAS immediately, instead of racing us for one final win (which
      // would leave us serving a state it is about to replace).
      if (this.lease?.held && this.lease.tookOver) {
        await this.fenceStamp()
      }
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

  /** Make `m` our state: restore its snapshot into the scratch dir, overlay
   * its WAL segments, and start PGlite on it (Postgres recovery replays the
   * overlaid WAL). Used at boot and when the manifest moves underneath us. */
  private async adoptManifest(m: Manifest, etag: string): Promise<void> {
    this.manifest = m
    this.manifestEtag = etag
    this.generation = m.generation
    if (this.pg) {
      await this.pg.close()
      await rm(this.dataDir, { recursive: true, force: true })
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    }
    const tRestore = performance.now()
    this.bootTimings.snapshotBytes = await this.restoreInto(this.dataDir, m.snapshot)
    await this.applyWalSegments(this.dataDir, m)
    // Resume point BEFORE Postgres boots: everything the bucket holds ends at
    // the last shipped LSN. Anything Postgres writes past it from here on
    // (including its end-of-recovery checkpoint record) ships with the next
    // commit, so a future restore replays the identical byte stream.
    const resumeAt = m.walSegments.length
      ? m.walSegments[m.walSegments.length - 1].endLsn
      : m.walFlushLsn
    this.lastShippedLsn = resumeAt ? parseLsn(resumeAt) : 0n
    this.walSegBytes = m.walSegmentBytes ?? 0
    this.walTli = m.walTimeline ?? 1
    this.walBytesSinceSnapshot = m.walSegments.reduce(
      (n, s) => n + Number(parseLsn(s.endLsn) - parseLsn(s.startLsn)),
      0,
    )
    this.bootTimings.restoreMs = performance.now() - tRestore
    const tPg = performance.now()
    this.pg = await PGlite.create({ dataDir: this.dataDir })
    await this.pg.waitReady
    this.bootTimings.pgliteCreateMs = performance.now() - tPg
    await this.ensureWalConfig()
    // No walFlushLsn (pre-v2 manifest) -> nowhere to resume shipping from.
    // One compaction records it and the database ships incrementally forever.
    this.forceCompactNext = m.version !== 2 || !m.walFlushLsn
  }

  /** Overlay shipped WAL ranges onto the restored datadir: fetch concurrently
   * (small objects), verify CRC + LSN continuity, write each range into the
   * pg_wal segment file(s) it spans at the LSN-derived offsets. */
  private async applyWalSegments(dir: string, m: Manifest): Promise<void> {
    const segments = m.walSegments
    if (segments.length === 0) return
    if (!m.walFlushLsn || !m.walSegmentBytes) {
      throw new Error('manifest has WAL segments but no walFlushLsn/walSegmentBytes')
    }
    const segBytes = m.walSegmentBytes
    const tli = m.walTimeline ?? 1
    // Continuity: first range starts at the snapshot's flush LSN, each next
    // range starts where the previous ended. A gap would mean a hole in the
    // replay stream — refuse loudly rather than boot a half-restored DB.
    let expect = parseLsn(m.walFlushLsn)
    for (const seg of segments) {
      if (parseLsn(seg.startLsn) !== expect) {
        throw new Error(`WAL range gap: expected ${formatLsn(expect)}, got ${seg.startLsn} (${seg.key})`)
      }
      expect = parseLsn(seg.endLsn)
    }
    const bodies = await Promise.all(
      segments.map(async (seg) => {
        const obj = await this.store.get(seg.key)
        if (!obj) throw new Error(`manifest references missing WAL segment ${seg.key}`)
        const want = Number(parseLsn(seg.endLsn) - parseLsn(seg.startLsn))
        if (obj.bytes.byteLength !== want) {
          throw new Error(`WAL segment ${seg.key}: size ${obj.bytes.byteLength} != ${want}`)
        }
        if ((crc32(obj.bytes) >>> 0) !== seg.crc32) {
          throw new Error(`WAL segment ${seg.key}: CRC mismatch`)
        }
        return obj.bytes
      }),
    )
    for (let i = 0; i < segments.length; i++) {
      const body = bodies[i]
      let pos = parseLsn(segments[i].startLsn)
      let bodyOff = 0
      while (bodyOff < body.byteLength) {
        const offInFile = Number(pos % BigInt(segBytes))
        const take = Math.min(body.byteLength - bodyOff, segBytes - offInFile)
        const path = join(dir, 'pg_wal', walFileName(tli, pos, segBytes))
        // Create-if-missing without truncating, then write at the offset.
        const fh = await open(path, 'a').then(async (h) => {
          await h.close()
          return open(path, 'r+')
        })
        try {
          await fh.write(body, bodyOff, take, offInFile)
        } finally {
          await fh.close()
        }
        pos += BigInt(take)
        bodyOff += take
      }
    }
  }

  /** Read WAL bytes [start, end) out of the local pg_wal segment files. */
  private async readWalRange(start: bigint, end: bigint): Promise<Buffer> {
    const out = Buffer.alloc(Number(end - start))
    let pos = start
    let outOff = 0
    while (pos < end) {
      const offInFile = Number(pos % BigInt(this.walSegBytes))
      const take = Math.min(Number(end - pos), this.walSegBytes - offInFile)
      const path = join(this.dataDir, 'pg_wal', walFileName(this.walTli, pos, this.walSegBytes))
      const fh = await open(path, 'r')
      try {
        const { bytesRead } = await fh.read(out, outOff, take, offInFile)
        if (bytesRead !== take) {
          throw new Error(`short WAL read in ${path}: ${bytesRead} < ${take} at ${offInFile}`)
        }
      } finally {
        await fh.close()
      }
      pos += BigInt(take)
      outOff += take
    }
    return out
  }

  /** Advance manifest.fencingToken to ours (no data change). On conflict the
   * manifest moved while we were restoring — adopt the new state and retry. */
  private async fenceStamp(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const m: Manifest = { ...this.manifest, fencingToken: this.lease!.fencingToken }
      try {
        const { etag } = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
          ifMatch: this.manifestEtag ?? undefined,
          contentType: 'application/json',
        })
        this.manifest = m
        this.manifestEtag = etag
        return
      } catch (e) {
        if (!(e instanceof PreconditionFailedError)) throw e
        const cur = await this.store.get(MANIFEST_KEY)
        if (!cur) throw e
        await this.adoptManifest(decodeManifest(cur.bytes), cur.etag)
      }
    }
    throw new Error('fence-stamp failed after repeated manifest races')
  }

  /** Stream a snapshot object into dir; returns its stored size. The key
   * suffix says whether it is gzipped (.tar.gz) or raw tar (.tar). */
  private async restoreInto(dir: string, snapshotKey: string): Promise<number> {
    const src = await this.store.getStream(snapshotKey)
    if (!src) throw new Error(`manifest references missing snapshot ${snapshotKey}`)
    const tarStream = snapshotKey.endsWith('.gz')
      ? compose(Readable.from(src.stream), createGunzip())
      : Readable.from(src.stream)
    await extractTarStream(tarStream as AsyncIterable<Uint8Array>, dir)
    return src.size
  }

  /**
   * Decide the snapshot codec by test-compressing a slice of the largest heap
   * file. Incompressible data (media blobs, encrypted values, random test
   * data) makes gzip pure CPU waste — on a 1-vCPU Cloud Run instance, deflate
   * caps the upload at ~12MB/s while a raw PUT runs at network speed.
   */
  private async chooseCodec(): Promise<'gzip' | 'none'> {
    try {
      const big = await largestFile(this.dataDir)
      if (!big || big.size < 1024 * 1024) return 'gzip' // small DB: gzip is cheap
      const fh = await import('node:fs/promises')
      const sample = Buffer.alloc(Math.min(big.size, 4 * 1024 * 1024))
      const f = await fh.open(big.path, 'r')
      try {
        await f.read(sample, 0, sample.length, 0)
      } finally {
        await f.close()
      }
      const ratio = gzipSync(sample, { level: 1 }).length / sample.length
      // Deflate on a serverless vCPU moves ~12-30MB/s; the network moves
      // 100MB/s+. gzip only pays off when it removes a large fraction of the
      // bytes — otherwise ship raw tar and let the NIC do the work.
      return ratio > 0.65 ? 'none' : 'gzip'
    } catch {
      return 'gzip'
    }
  }

  /** Persist WAL GUCs into the datadir (travels with snapshots), and probe
   * whether this session can ship WAL incrementally: the flush-LSN function
   * must exist and our LSN->filename math must agree with the server's. */
  private async ensureWalConfig(): Promise<void> {
    try {
      const cur = await this.pg.query<{ name: string; setting: string }>(
        "SELECT name, setting FROM pg_settings WHERE name = 'max_wal_size'",
      )
      // Immediate (session) — ALTER SYSTEM below persists it for future boots.
      await this.pg.exec('SET synchronous_commit = on')
      if (cur.rows[0]?.setting !== '64') {
        for (const [k, v] of WAL_GUCS) {
          await this.pg.exec(`ALTER SYSTEM SET ${k} = ${v}`)
        }
        await this.pg.query('SELECT pg_reload_conf()')
      }
    } catch {
      // Non-fatal: snapshots are just bigger than they need to be.
    }
    try {
      const probe = await this.pg.query<{ lsn: string; fname: string; segsz: string }>(
        `SELECT pg_current_wal_flush_lsn()::text lsn,
                pg_walfile_name(pg_current_wal_flush_lsn())::text fname,
                current_setting('wal_segment_size') segsz`,
      )
      const { lsn, fname, segsz } = probe.rows[0]!
      const m = /^(\d+)\s*(MB|kB|GB)$/.exec(segsz)
      if (!m) throw new Error(`unparseable wal_segment_size: ${segsz}`)
      const mult = { kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] as 'kB' | 'MB' | 'GB']
      this.walSegBytes = Number(m[1]) * mult
      this.walTli = parseInt(fname.slice(0, 8), 16)
      // Validate our XLogFileName math against the server. pg_walfile_name
      // maps exact-boundary LSNs to the PREVIOUS segment, so accept either.
      const at = parseLsn(lsn)
      const ours = walFileName(this.walTli, at, this.walSegBytes)
      const oursPrev = walFileName(this.walTli, at > 0n ? at - 1n : 0n, this.walSegBytes)
      this.incrementalCapable = fname === ours || fname === oursPrev
    } catch {
      this.incrementalCapable = false // this session commits via snapshots
    }
  }

  /** Flush dirty pages + trim pg_wal so the tar reflects the data, not the
   * write burst. Must run BEFORE chooseCodec so the probe sees heap files.
   * In an incremental-capable session, also switch onto a fresh WAL segment:
   * the post-snapshot tail then grows organically from byte 0, which is what
   * makes size-diff shipping safe forever after. */
  private async checkpointForSnapshot(): Promise<{ ms: number; flushLsn: string | null }> {
    const t0 = performance.now()
    let flushLsn: string | null = null
    try {
      // Twice: the first moves the redo point past the write burst, the second
      // lets Postgres unlink (wal_recycle=off) segments behind it.
      await this.pg.exec('CHECKPOINT')
      await this.pg.exec('CHECKPOINT')
      if (this.incrementalCapable) {
        // The post-checkpoint flush LSN: where the snapshot's pg_wal content
        // ends and incremental shipping will resume. Read AFTER the
        // checkpoints (they write WAL) and before the tar (we are quiescent).
        const r = await this.pg.query<{ lsn: string }>(
          'SELECT pg_current_wal_flush_lsn()::text lsn',
        )
        flushLsn = r.rows[0]?.lsn ?? null
      }
    } catch {
      // CHECKPOINT may be unavailable in some PGlite builds; snapshot anyway.
    }
    return { ms: performance.now() - t0, flushLsn }
  }

  private async uploadSnapshot(
    key: string,
    codec: 'gzip' | 'none',
    dumpMs: number,
  ): Promise<{ snapshotBytes: number; dumpMs: number; uploadMs: number }> {
    const tUp = performance.now()
    let snapshotBytes = 0
    const tar = Readable.from(createTarStream(this.dataDir))
    const body = codec === 'gzip' ? compose(tar, createGzip({ level: 1 })) : tar
    const counted = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        snapshotBytes += chunk.length
        yield chunk
      }
    }
    await this.store.putStream(key, counted(), {
      contentType: codec === 'gzip' ? 'application/gzip' : 'application/x-tar',
    })
    return { snapshotBytes, dumpMs, uploadMs: performance.now() - tUp }
  }

  /** Data-object keys embed the writer's fencing token (DESIGN 4.4): a fenced
   * zombie's in-flight upload then lands at a key nobody references, instead
   * of overwriting the same-seq object the winner's manifest points at.
   * (E4 P4 produced exactly that collision before tokens were embedded.) */
  private snapshotKeyFor(seq: number, token: number, codec: 'gzip' | 'none'): string {
    return `generations/${this.generation}/snapshot-${seq}-t${token}.tar${codec === 'gzip' ? '.gz' : ''}`
  }

  private segmentKeyFor(seq: number, token: number): string {
    return `generations/${this.generation}/wal/${String(seq).padStart(8, '0')}-t${token}.seg`
  }

  private async commitInitial(): Promise<void> {
    const cp = await this.checkpointForSnapshot()
    const codec = await this.chooseCodec()
    const snapshotKey = this.snapshotKeyFor(0, this.lease?.held ? this.lease.fencingToken : 1, codec)
    await this.uploadSnapshot(snapshotKey, codec, cp.ms)
    if (cp.flushLsn) this.lastShippedLsn = parseLsn(cp.flushLsn)
    this.walBytesSinceSnapshot = 0
    const m: Manifest = {
      // version 2 means "walFlushLsn is recorded": incremental shipping can
      // resume from it. Without it the next writer compacts first.
      version: cp.flushLsn ? 2 : 1,
      generation: this.generation,
      fencingToken: this.lease?.held ? this.lease.fencingToken : 1,
      snapshot: snapshotKey,
      walSegments: [],
      ...(cp.flushLsn
        ? { walFlushLsn: cp.flushLsn, walSegmentBytes: this.walSegBytes, walTimeline: this.walTli }
        : {}),
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
        await this.adoptManifest(decodeManifest(cur.bytes), cur.etag)
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
    this.commitInFlight = (async () => {
      // Group-commit pacing: stay under the store's per-object write cap on
      // the manifest. Writes that land during the wait are already in PGlite's
      // WAL, so they ride along in this commit's LSN range — exactly Postgres
      // group commit, bucket edition. Idle databases pay nothing (lastCasAt
      // is long past, wait <= 0).
      const wait = this.commitIntervalMs - (this.now() - this.lastCasAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      try {
        return await this.doCommit()
      } finally {
        this.lastCasAt = this.now()
        this.commitInFlight = null
      }
    })()
    return this.commitInFlight
  }

  private async doCommit(): Promise<CommitInfo> {
    // Incremental unless: the session can't guarantee append-only pg_wal, the
    // booted snapshot predates that guarantee (forceCompactNext), or the
    // segment tail has outgrown the compaction thresholds.
    if (
      this.incrementalCapable &&
      !this.forceCompactNext &&
      this.manifest.version === 2 &&
      this.manifest.walSegments.length < COMPACT_AT_SEGMENTS &&
      this.walBytesSinceSnapshot < COMPACT_AT_WAL_BYTES
    ) {
      const r = await this.commitIncremental()
      if (r) return r
      // Zero WAL delta with dirty set, or an invariant anomaly: compact.
    }
    return this.commitSnapshot()
  }

  /**
   * v1 commit: ship only the WAL bytes appended since the last commit — the
   * LSN range [lastShippedLsn, flushLsn) — as one immutable segment object,
   * then CAS the manifest with the new entry. O(transaction size), not
   * O(database size). Returns null if there is nothing shippable or the local
   * WAL no longer holds the range (caller falls back to compaction).
   */
  private async commitIncremental(): Promise<CommitInfo | null> {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken
    const nextSeq = this.manifest.commitSeq + 1
    // No CHECKPOINT here — that would defeat the point. synchronous_commit=on
    // (enforced in ensureWalConfig) guarantees completed transactions have
    // write()n + flushed their WAL before this query runs, and the flush LSN
    // is exactly the boundary of what is safe to ship.
    const t0 = performance.now()
    const r = await this.pg.query<{ lsn: string }>('SELECT pg_current_wal_flush_lsn()::text lsn')
    const end = parseLsn(r.rows[0]!.lsn)
    const start = this.lastShippedLsn
    if (end <= start) return null // dirty flag without WAL growth: compact to be safe
    const dumpMs = performance.now() - t0

    const tUp = performance.now()
    let buf: Buffer
    try {
      buf = await this.readWalRange(start, end)
    } catch {
      // The range fell off the local pg_wal (an automatic checkpoint removed
      // segments past our resume point — possible after a huge unflushed
      // burst in sleep mode). A full snapshot is the right answer anyway.
      return null
    }
    const key = this.segmentKeyFor(nextSeq, token)
    await this.store.put(key, buf, { contentType: 'application/octet-stream' })
    const entry: WalSegment = {
      key,
      startLsn: formatLsn(start),
      endLsn: formatLsn(end),
      crc32: crc32(buf) >>> 0,
    }
    const uploadMs = performance.now() - tUp

    const m: Manifest = {
      ...this.manifest,
      version: 2,
      fencingToken: token,
      walSegments: [...this.manifest.walSegments, entry],
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString(),
    }
    const manifestMs = await this.casManifest(m, token)
    this.manifest = m
    this.dirty = false
    // Advance the resume point ONLY after the CAS: a fenced commit must not
    // mark bytes as shipped (its segment object is orphaned garbage).
    this.lastShippedLsn = end
    this.walBytesSinceSnapshot += buf.length
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      mode: 'incremental',
      snapshotKey: key,
      snapshotBytes: buf.length,
      segments: 1,
      dumpMs,
      uploadMs,
      manifestMs,
    }
  }

  /** v0-style full commit, now serving as compaction + rolling backup. */
  private async commitSnapshot(): Promise<CommitInfo> {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken
    const nextSeq = this.manifest.commitSeq + 1
    const cp = await this.checkpointForSnapshot()
    const codec = await this.chooseCodec()
    const snapshotKey = this.snapshotKeyFor(nextSeq, token, codec)
    const { snapshotBytes, dumpMs, uploadMs } = await this.uploadSnapshot(snapshotKey, codec, cp.ms)

    const oldSnapshot = this.manifest.snapshot
    const oldBackup = this.manifest.previousSnapshot
    const oldSegments = this.manifest.walSegments
    const m: Manifest = {
      ...this.manifest,
      version: cp.flushLsn ? 2 : 1,
      fencingToken: token,
      snapshot: snapshotKey,
      walSegments: [],
      walFlushLsn: cp.flushLsn ?? undefined,
      walSegmentBytes: cp.flushLsn ? this.walSegBytes : undefined,
      walTimeline: cp.flushLsn ? this.walTli : undefined,
      // The compacted-away snapshot stays as a one-generation-back backup in
      // case something corrupts the current state. GC preserves it.
      previousSnapshot: oldSnapshot !== snapshotKey ? oldSnapshot : oldBackup,
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString(),
    }
    const manifestMs = await this.casManifest(m, token)
    this.manifest = m
    this.dirty = false
    this.forceCompactNext = false
    if (cp.flushLsn) this.lastShippedLsn = parseLsn(cp.flushLsn)
    this.walBytesSinceSnapshot = 0
    // Best-effort cleanup: the grandparent backup and the segments folded
    // into this snapshot are no longer referenced by anything.
    if (oldBackup && oldBackup !== m.previousSnapshot) {
      void this.store.delete(oldBackup).catch(() => {})
    }
    for (const seg of oldSegments) {
      void this.store.delete(seg.key).catch(() => {})
    }
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      mode: 'snapshot',
      snapshotKey,
      snapshotBytes,
      segments: 0,
      dumpMs,
      uploadMs,
      manifestMs,
    }
  }

  /** Conditional manifest swap — the one operation that IS a commit. */
  private async casManifest(m: Manifest, token: number): Promise<number> {
    const tMan = performance.now()
    try {
      const r = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
        ifMatch: this.manifestEtag ?? undefined,
        contentType: 'application/json',
      })
      this.manifestEtag = r.etag
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        // Manifest advanced by someone else => we are fenced. Whatever we
        // just uploaded is orphaned garbage (no manifest references it).
        throw new FencedError(token, 'manifest CAS failed at commit')
      }
      throw e
    }
    return performance.now() - tMan
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
    // Throws FencedError if someone took the lease over. Returns false when
    // the lease is expired but still ours (idle instance under CPU throttling
    // never got to renew) — renew() re-arms it via CAS on our own version,
    // which is exactly as safe as the manifest CAS that guards every commit.
    const ok = await this.lease.validate()
    if (!ok || this.lease.expiresInMs(this.now()) < this.leaseTtlMs / 2) {
      await this.lease.renew()
    }
    return true
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
