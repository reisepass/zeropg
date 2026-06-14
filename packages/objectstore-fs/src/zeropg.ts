// ZeroPG — a real Postgres (PGlite) whose durable home is an object-storage
// bucket, with a single-writer lease and manifest-swap commits.
//
// COMMIT STRATEGY (v1, shipped): incremental WAL shipping (V1-WAL-SHIPPING.md).
// A normal commit uploads ONLY the WAL bytes the transaction appended — the
// LSN range [lastShippedLsn, pg_current_wal_flush_lsn()) — as one immutable
// segment object, then CASes the manifest to append it. O(transaction size),
// not O(database size). The full-datadir snapshot is now a *compaction*
// artifact: when the accumulated WAL tail outgrows COMPACT_AT_WAL_BYTES /
// COMPACT_AT_SEGMENTS the next commit rolls a fresh snapshot and empties the
// segment list (keeping the old snapshot as a one-back backup). The FIRST
// commit of every writer life re-baselines the WAL since the current snapshot
// (commitRebaseline) rather than spanning the dead predecessor's ragged WAL
// tail — see the "generation per writer life" correction in V1-WAL-SHIPPING.md.
//
// Both pipelines are fully streaming in each direction:
//   restore: GCS ranged GETs (parallel) -> gunzip -> untar -> scratch dir,
//            overlay WAL segments, then PGlite opens it (recovery replays WAL).
//   compaction snapshot: double-CHECKPOINT -> tar(scratch dir) -> gzip -> PUT.
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
// inside the snapshot) and compaction double-CHECKPOINTs first, so pg_wal stays
// at a few segments. The manifest schema is v2 (manifest.ts); v1 single-snapshot
// manifests still decode and restore — the first commit compacts them forward.

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
import { ColdArchiver, type RetentionPolicy, INDEX_KEY, decodeBackupIndex } from './archive.js'
import {
  restoreSnapshotInto,
  applyWalSegments,
  parseLsn,
  formatLsn,
  walFileName,
} from './restore.js'
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

/**
 * Secondary cold-storage backup target (Track D). When set, ZeroPG runs a
 * ColdArchiver against this store automatically after each compaction snapshot,
 * giving a second blast radius + retention without an external cron line. When
 * unset, backups are a no-op — single-bucket setups are unaffected.
 *
 * The archiver consumes the primary bucket leaselessly (like a replica), so the
 * hook never blocks or contends with the commit path: backupOnce runs after the
 * snapshot is durable, and a failure is logged, never fatal to the commit.
 */
export interface BackupTarget {
  /** The SECONDARY BlobStore (distinct bucket, or a prefixed view of one). */
  store: BlobStore
  /**
   * Retention applied after each successful backup. Omit to keep every backup.
   * The newest backup is ALWAYS kept regardless of policy (retain() invariant).
   */
  retention?: RetentionPolicy
  /**
   * Run the backup synchronously inside the commit (true) or fire-and-forget in
   * the background (false, default). Background keeps commit latency flat; the
   * in-flight backup is always awaited by close()/flush() so nothing is lost on
   * a clean shutdown. Set true when a test needs the backup observable
   * immediately after the awaited commit.
   */
  blocking?: boolean
  /** Local scratch dir for the archiver's temp restore. Default os.tmpdir(). */
  scratchDir?: string

  // ---- Capture-frequency controls ----

  /**
   * FLOOR: minimum ms between consecutive cold backups. A compaction that fires
   * while the newest backup is younger than this is silently skipped. The check
   * reads the backup index from the secondary store (a single cheap GET) and
   * compares the newest entry's createdAt against the current clock.
   *
   * Default 3 600 000 (1 hour). Set to 0 to disable the floor (back up on every
   * compaction, which was the implicit pre-floor behaviour).
   */
  minIntervalMs?: number

  /**
   * CEILING: if the newest backup is older than this AND there have been writes
   * since (i.e. a compaction is happening), a backup is forced regardless of
   * minIntervalMs. Ensures an active database always has a reasonably recent
   * cold backup even when compactions are infrequent.
   *
   * Default 86 400 000 (24 hours). Set to 0 to disable the ceiling.
   */
  maxBackupAgeMs?: number

  /**
   * Alternative trigger: only take a cold backup every Nth compaction. When set,
   * this is evaluated AFTER minIntervalMs / maxBackupAgeMs (the ceiling still
   * wins, forcing a backup when the newest is too old). Useful when operators
   * think in "commits" rather than wall-clock time.
   *
   * Default unset (disabled). N must be >= 1; N=1 is equivalent to disabled.
   */
  everyNCompactions?: number
}

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
  /**
   * full_page_writes (A1). Postgres writes a full 8KB page image into WAL on
   * the first change to each page after a checkpoint, to repair torn pages
   * during local crash recovery — often the MAJORITY of WAL bytes, which is
   * exactly the volume we ship per commit. zeropg never recovers from a torn
   * local datadir (it restores from a consistent post-CHECKPOINT snapshot on
   * tmpfs and replays complete, CRC/page-address-verified WAL over it), so the
   * protection is plausibly redundant and turning it off shrinks every
   * incremental commit and stretches compaction intervals.
   *
   * It is correctness-sensitive, NOT a free win, so the default is the safe
   * stock behavior (`true`). Turn it off only with the E2b/e4b crash matrix
   * green WITH it off (see results/fpw.jsonl + V1-WAL-SHIPPING.md). Default:
   * `true`, overridable for the harnesses by env `ZEROPG_FULL_PAGE_WRITES`
   * (`off`/`false`/`0` => off) when this option is left unset.
   */
  fullPageWrites?: boolean
  /**
   * wal_compression (A1.3): compress full-page images inside the WAL before
   * our per-segment handling, shrinking the shipped LSN range itself. Lower
   * value when fullPageWrites is off (no FPIs to compress). Undefined leaves
   * the engine default (off). Values: 'off' | 'pglz' | 'lz4' | 'zstd' — the
   * non-default codecs require the PGlite WASM build to include them (probed
   * at boot; unsupported values are ignored, non-fatally).
   */
  walCompression?: 'off' | 'pglz' | 'lz4' | 'zstd'
  /**
   * Secondary cold-storage backup target (Track D). When set, every compaction
   * snapshot is followed by a ColdArchiver backup of the freshly-committed point
   * to this second store, with optional retention. Unset => no-op (single-bucket
   * setups still work). See BackupTarget.
   */
  backup?: BackupTarget
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
//
// GUARDRAIL — wal_level MUST stay `replica` (its default here), NEVER `minimal`
// (TODO A1.2 / V1-WAL-SHIPPING.md "wal_level constraint"). This is a data-loss
// landmine SPECIFICALLY BECAUSE we ship WAL. Under wal_level=minimal Postgres
// skips WAL for bulk operations against a relation created or truncated in the
// SAME transaction — COPY, CREATE TABLE AS, CREATE INDEX, CLUSTER, ALTER TABLE
// rewrites — and instead only fsync()s the heap/index files at commit. Those
// changes therefore NEVER appear in any shipped WAL segment: an incremental
// commit ships an LSN range that does not contain them, so a restore that
// replays our segments over the snapshot silently loses the entire bulk load
// until the next FULL snapshot (compaction) happens to capture the heap files.
// `replica` forces every such change through the WAL, which is the only thing
// our restore path replays. We deliberately do NOT add wal_level to this list:
// leaving it at the engine default keeps it at `replica` and makes any future
// override require a conscious edit right here, with this warning attached.
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
  private fullPageWrites: boolean
  private walCompression?: string

  // ---- Track D: secondary cold-storage backup ----
  private backup: BackupTarget | null = null
  private archiver: ColdArchiver | null = null
  /** In-flight background backup, awaited by close()/flush() so a clean
   * shutdown never abandons a backup mid-upload. */
  private backupInFlight: Promise<void> | null = null
  /** How many compaction snapshots have fired this writer life (for everyNCompactions). */
  private compactionCount = 0

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
  /** Cluster flush LSN right after this life's boot: WAL at or below this is
   * recovery artifacts, not user writes — a dirty flag with no growth past it
   * (idempotent boot DDL) must not upload anything. */
  private lifeBaseLsn = 0n
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
    // Option wins; else env override (test convenience); else safe default on.
    this.fullPageWrites = opts.fullPageWrites ?? !/^(off|false|0)$/i.test(
      process.env.ZEROPG_FULL_PAGE_WRITES ?? '',
    )
    this.walCompression = opts.walCompression ?? process.env.ZEROPG_WAL_COMPRESSION
    if (opts.backup) {
      this.backup = opts.backup
      this.archiver = new ColdArchiver(opts.store, opts.backup.store, {
        scratchDir: opts.backup.scratchDir,
        now: this.now,
      })
    }
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
      // Re-read AFTER the lease is ours: acquisition can wait out a previous
      // holder for up to acquireTimeoutMs, during which that holder may have
      // flushed (its idle-flush backstop / SIGTERM flush CASes the manifest).
      // Adopting the pre-wait read would serve — and on the next commit,
      // overwrite — state older than what the bucket holds. (E4 P2 caught
      // this live; V1-WAL-SHIPPING.md called the ordering critical.)
      const fresh = (await this.store.get(MANIFEST_KEY)) ?? existing
      const m = decodeManifest(fresh.bytes)
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`,
        )
      }
      // 3a) Restore: stream bucket -> gunzip -> untar -> scratch dir.
      await this.adoptManifest(m, fresh.etag)
      // Token-floor freshness check: if we acquired the lease via clean
      // create-if-absent (not a takeover) while the previous holder was still
      // comitting, our tokenFloor came from the manifest we read BEFORE we
      // queued, so freshToken = floor+1 can equal the previous holder's last
      // committed token. Upgrade our lease token to strictly above the manifest
      // AFTER the re-read so every future commit embeds a strictly higher value.
      if (this.lease?.held && !this.lease.tookOver) {
        await this.lease.upgradeToken(m.fencingToken)
      }
      // Takeover path: stamp our (already-higher) token into the manifest so
      // the previous holder's next commit fails the CAS immediately.
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
    this.bootTimings.snapshotBytes = await restoreSnapshotInto(this.store, this.dataDir, m.snapshot)
    await applyWalSegments(this.store, this.dataDir, m)
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
    // WAL ranges never span writer lives (the Litestream rule: new generation
    // per process). E4 measured why: pg_current_wal_flush_lsn() at a writer's
    // end of life can overshoot the last replayable record by a header-sized
    // tail (observed: resume exactly 24 bytes past the recovery end, always),
    // so a successor resuming from the dead writer's LSN ships from a
    // misaligned stream and a restorer silently drops the tail — acked-write
    // loss. The first commit of every life therefore compacts (one snapshot,
    // normally absorbed by the idle flush); all later commits in this life
    // ship incrementally from LSNs this process measured itself.
    this.forceCompactNext = true
    if (this.incrementalCapable) {
      try {
        const r = await this.pg.query<{ lsn: string }>(
          'SELECT pg_current_wal_flush_lsn()::text lsn',
        )
        this.lifeBaseLsn = parseLsn(r.rows[0]!.lsn)
      } catch {
        this.lifeBaseLsn = 0n
      }
    }
  }

  /**
   * Every 8KB WAL page carries its own address (xlp_pageaddr). Verify each
   * full page in [start, end) claims the LSN it sits at — zeros or stale
   * bytes fail immediately. This is the guard against shipping WAL the
   * engine has ACCOUNTED as flushed but not yet physically written back to
   * the host FS (observed live: a 5MB commit's tail read back as garbage and
   * the restorer dropped it — acked-write loss).
   */
  private validateWalRange(buf: Buffer, start: bigint): bigint | null {
    const PAGE = 8192n
    let page = ((start + PAGE - 1n) / PAGE) * PAGE // first full page in range
    const end = start + BigInt(buf.length)
    while (page + 12n <= end) {
      const off = Number(page - start)
      const pageaddr = buf.readBigUInt64LE(off + 8)
      const magic = buf.readUInt16LE(off)
      if (pageaddr !== page || magic === 0) return page // first bad page
      page += PAGE
    }
    return null
  }

  /**
   * Read [start, end) from local pg_wal for shipping: force the engine's FS
   * write-back first (PGlite accounts WAL flushed ahead of physically writing
   * it — large commits lose that race), then validate every full WAL page's
   * self-address, retrying while write-back catches up. Returns null if the
   * bytes never validate or the range has fallen off disk — the caller then
   * compacts rather than ship garbage. The one read-and-trust gate both the
   * incremental and rebaseline commit paths go through.
   */
  private async readShippableWal(start: bigint, end: bigint): Promise<Buffer | null> {
    await this.pg.syncToFs()
    let buf: Buffer
    try {
      buf = await this.readWalRange(start, end)
      for (let attempt = 0; ; attempt++) {
        const badPage = this.validateWalRange(buf, start)
        if (badPage === null) break
        if (attempt >= 20) {
          console.error(
            JSON.stringify({
              event: 'zeropg-wal-writeback-stall',
              badPageLsn: formatLsn(badPage),
              range: `${formatLsn(start)}..${formatLsn(end)}`,
              action: 'compacting',
            }),
          )
          return null
        }
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)))
        buf = await this.readWalRange(start, end)
      }
    } catch {
      return null
    }
    return buf
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

  /** Persist WAL GUCs into the datadir (travels with snapshots), reconcile the
   * per-instance WAL knobs (full_page_writes / wal_compression) so they are
   * LIVE for this life's writes, and probe whether this session can ship WAL
   * incrementally: the flush-LSN function must exist and our LSN->filename math
   * must agree with the server's. */
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
      }
      // full_page_writes / wal_compression are per-instance choices (A1/A1.3),
      // NOT part of WAL_GUCS: the live writer's setting must win over whatever
      // the restored snapshot's postgresql.auto.conf carried. ALTER SYSTEM
      // writes auto.conf now; the value becomes live below.
      const fpw = this.fullPageWrites ? 'on' : 'off'
      await this.pg.exec(`ALTER SYSTEM SET full_page_writes = ${fpw}`)
      let walcApplied = false
      if (this.walCompression) {
        try {
          await this.pg.exec(`ALTER SYSTEM SET wal_compression = ${this.walCompression}`)
          walcApplied = true
        } catch {
          // codec not compiled into this PGlite WASM build — leave at default.
        }
      }
      await this.pg.query('SELECT pg_reload_conf()')
      // PGlite applies SIGHUP-context GUCs (max_wal_size, full_page_writes,
      // wal_compression) only at PROCESS START — pg_reload_conf() does NOT make
      // them live in-process (verified). So if the running value still differs
      // from what we need, reopen the datadir ONCE: a clean shutdown + restart
      // reads the auto.conf we just wrote, and this life's writes then use it
      // (e.g. ship WAL with full_page_writes genuinely off). This self-heals —
      // once any life's snapshot bakes the value into auto.conf, every later
      // restore starts with it already live and skips the reopen, so steady
      // state pays zero extra boot cost. FPW only governs WAL about to be
      // WRITTEN; it never affects replay of WAL already shipped, so a reopen
      // here (before this life's first commit) is safe.
      const live = await this.pg.query<{ setting: string }>(
        "SELECT setting FROM pg_settings WHERE name = 'full_page_writes'",
      )
      const liveWalc = walcApplied
        ? (await this.pg.query<{ setting: string }>(
            "SELECT setting FROM pg_settings WHERE name = 'wal_compression'",
          )).rows[0]?.setting
        : undefined
      const fpwMismatch = live.rows[0]?.setting !== fpw
      const walcMismatch = walcApplied && liveWalc !== this.walCompression
      if (fpwMismatch || walcMismatch) {
        await this.pg.close()
        this.pg = await PGlite.create({ dataDir: this.dataDir })
        await this.pg.waitReady
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
    // The tar reads these files from the host FS — make sure the engine's
    // write-back has fully landed first (same race as the WAL-range read).
    await this.pg.syncToFs().catch(() => {})
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
    if (cp.flushLsn) {
      this.lastShippedLsn = parseLsn(cp.flushLsn)
      this.lifeBaseLsn = this.lastShippedLsn
    }
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

  private async doCommit(): Promise<CommitInfo | null> {
    // Nothing real happened this life? (dirty flag from idempotent boot DDL,
    // no WAL growth past the boot baseline) -> never upload for it; without
    // this, compact-on-first-commit would ship a full snapshot per cold start
    // for read-only traffic.
    if (this.incrementalCapable && this.lifeBaseLsn > 0n) {
      try {
        const r = await this.pg.query<{ lsn: string }>(
          'SELECT pg_current_wal_flush_lsn()::text lsn',
        )
        if (parseLsn(r.rows[0]!.lsn) <= this.lifeBaseLsn) {
          this.dirty = false
          return null
        }
      } catch {
        // fall through to the normal paths
      }
    }
    if (this.incrementalCapable && this.manifest.version === 2) {
      if (this.forceCompactNext) {
        // First commit of this writer life. WAL ranges can't cross lives via
        // the inherited resume LSN (the dead writer's flush LSN overshoots its
        // last replayable record), so v1 re-snapshotted the whole DB here.
        // Cheaper and equally sound: re-baseline only the WAL since the
        // current snapshot, read from THIS instance's own coherent on-disk
        // stream between two clean boundaries. Falls back to a full snapshot
        // when that isn't possible (too much WAL, suspect bytes, no flush LSN).
        const r = await this.commitRebaseline()
        if (r) return r
      } else if (
        // Steady state: append this commit's WAL delta, until the tail grows
        // past the compaction thresholds.
        this.manifest.walSegments.length < COMPACT_AT_SEGMENTS &&
        this.walBytesSinceSnapshot < COMPACT_AT_WAL_BYTES
      ) {
        const r = await this.commitIncremental()
        if (r === 'empty') {
          // Dirty flag with zero WAL growth (idempotent DDL like CREATE TABLE
          // IF NOT EXISTS on an existing table): nothing user-visible changed,
          // so there is nothing to persist. Compacting here would let any
          // read-mostly instance rewrite the whole manifest for a no-op.
          this.dirty = false
          return null
        }
        if (r) return r
        // Local WAL no longer holds the range (or an anomaly): compact.
      }
    }
    return this.commitSnapshot()
  }

  /**
   * First commit of a writer life: re-ship the WAL accumulated since the
   * current snapshot as ONE fresh segment and REPLACE the inherited segment
   * list, instead of re-snapshotting the whole database.
   *
   * Why this is sound where cross-life incremental resume is not: it ships
   * [snapshot.walFlushLsn, ourCurrentFlushLsn) — both ends are clean
   * boundaries this instance can trust (the snapshot's own checkpoint LSN and
   * our own post-recovery flush LSN), read from one coherent on-disk WAL
   * stream that recovery just replayed and extended. It never relies on the
   * dead predecessor's ragged tail LSN, which is the whole reason the
   * per-life rule exists. The new range covers everything the inherited
   * segments did (recovery replayed them) plus our end-of-recovery
   * checkpoint, so replacing them drops no committed data.
   *
   * Cost: O(WAL since the snapshot) ≤ the compaction threshold, not O(database
   * size) — a few KB–MB on the 500MB demo vs a 533MB snapshot. Returns null
   * to fall back to a full snapshot when preconditions don't hold.
   */
  private async commitRebaseline(): Promise<CommitInfo | null> {
    const snapFlush = this.manifest.walFlushLsn
    if (!snapFlush) return null // pre-v2 snapshot has no resume point; must compact
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken
    const nextSeq = this.manifest.commitSeq + 1
    const start = parseLsn(snapFlush)
    const t0 = performance.now()
    const r = await this.pg.query<{ lsn: string }>('SELECT pg_current_wal_flush_lsn()::text lsn')
    const end = parseLsn(r.rows[0]!.lsn)
    if (end <= start) return null // nothing since the snapshot — fall back
    if (end - start > BigInt(COMPACT_AT_WAL_BYTES)) return null // too much WAL: a real snapshot restores faster
    const dumpMs = performance.now() - t0

    const tUp = performance.now()
    const buf = await this.readShippableWal(start, end)
    if (!buf) return null
    const key = this.segmentKeyFor(nextSeq, token)
    await this.store.put(key, buf, { contentType: 'application/octet-stream' })
    const entry: WalSegment = {
      key,
      startLsn: formatLsn(start),
      endLsn: formatLsn(end),
      crc32: crc32(buf) >>> 0,
    }
    const uploadMs = performance.now() - tUp

    const oldSegments = this.manifest.walSegments
    const m: Manifest = {
      ...this.manifest,
      version: 2,
      fencingToken: token,
      walSegments: [entry], // REPLACE: this range supersedes + extends the inherited ones
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString(),
    }
    const manifestMs = await this.casManifest(m, token)
    this.manifest = m
    this.dirty = false
    this.forceCompactNext = false
    this.lastShippedLsn = end
    this.walBytesSinceSnapshot = Number(end - start)
    // The inherited segments are no longer referenced (our range covers them).
    for (const seg of oldSegments) void this.store.delete(seg.key).catch(() => {})
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

  /**
   * v1 commit: ship only the WAL bytes appended since the last commit — the
   * LSN range [lastShippedLsn, flushLsn) — as one immutable segment object,
   * then CAS the manifest with the new entry. O(transaction size), not
   * O(database size). Returns 'empty' when the WAL did not grow (a dirty
   * flag with no real change), or null when the local WAL no longer holds
   * the range (caller falls back to compaction).
   */
  private async commitIncremental(): Promise<CommitInfo | 'empty' | null> {
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
    if (end === start) return 'empty' // dirty flag without WAL growth: no-op
    if (end < start) {
      // Continuity violation: the cluster is BEHIND the manifest's resume
      // point — recovery ended short of what the bucket claims was shipped
      // (observed live in E4: every subsequent write then computes a negative
      // delta and would be silently swallowed, losing acked-durable writes).
      // DESIGN 4.6: any continuity doubt -> full snapshot of actual state.
      console.error(
        JSON.stringify({
          event: 'zeropg-wal-continuity-violation',
          clusterFlushLsn: formatLsn(end),
          resumeLsn: formatLsn(start),
          action: 'compacting',
        }),
      )
      this.forceCompactNext = true
      return null
    }
    const dumpMs = performance.now() - t0
    const tUp = performance.now()
    const buf = await this.readShippableWal(start, end)
    if (!buf) return null // bytes never validated / range fell off disk -> compact
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
    // Track D hook: the snapshot is now durable in the primary, so take a cold
    // backup of this committed point. One call, after compaction, never fatal.
    this.compactionCount++
    await this.runBackup()
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

  /**
   * Track D backup hook. Called after a compaction snapshot is durable in the
   * primary. No-op when no backup target is configured. The archiver reads the
   * primary leaselessly (no contention) and writes to the secondary, then
   * applies retention. A failure here is LOGGED, never fatal: a backup that
   * could not be taken must not fail an already-committed write.
   *
   * Default is background (fire-and-forget) so commit latency stays flat; the
   * promise is parked in backupInFlight and always awaited by flush()/close().
   * blocking:true awaits inline (tests that assert the backup right after the
   * awaited commit).
   *
   * Capture-frequency gate (evaluated before spawning a backup run):
   *   1. Read the backup index to find the newest entry's createdAt.
   *   2. FLOOR (minIntervalMs, default 1h): skip if newest is younger.
   *   3. CEILING (maxBackupAgeMs, default 24h): force if newest is older.
   *   4. everyNCompactions: skip if this compaction is not on the Nth boundary.
   *   The ceiling always wins over the floor and the N-gate.
   *   An idle (scaled-to-zero) DB takes zero backups — correct, nothing changed.
   */
  private async runBackup(): Promise<void> {
    if (!this.archiver || !this.backup) return
    const archiver = this.archiver
    const backup = this.backup
    const policy = backup.retention
    const minIntervalMs = backup.minIntervalMs ?? 3_600_000
    const maxBackupAgeMs = backup.maxBackupAgeMs ?? 86_400_000
    const everyN = backup.everyNCompactions ?? 1

    // A thunk, NOT an eagerly-started promise: when backgrounded it must not
    // begin until any previous backup finishes (one archiver, serial restore +
    // index CAS), else two runs race the index against themselves.
    const run = async (): Promise<void> => {
      try {
        // Capture-frequency gate: cheap index read, in-memory comparison.
        if (minIntervalMs > 0 || maxBackupAgeMs > 0 || everyN > 1) {
          const nowMs = this.now()
          const idxRaw = await backup.store.get(INDEX_KEY).catch(() => null)
          const newest = idxRaw
            ? decodeBackupIndex(idxRaw.bytes).backups.at(-1) ?? null
            : null
          const newestAgeMs = newest ? nowMs - Date.parse(newest.createdAt) : Infinity

          // Ceiling wins first: if the newest backup is older than maxBackupAgeMs,
          // always proceed regardless of the floor or the N-gate.
          if (maxBackupAgeMs > 0 && newestAgeMs < maxBackupAgeMs) {
            // Ceiling does NOT force — evaluate the floor and N-gate.
            if (minIntervalMs > 0 && newestAgeMs < minIntervalMs) {
              console.log(
                JSON.stringify({
                  event: 'zeropg-backup-skip',
                  reason: 'min-interval',
                  newestAgeMs: Math.round(newestAgeMs),
                  minIntervalMs,
                }),
              )
              return
            }
            if (everyN > 1 && this.compactionCount % everyN !== 0) {
              console.log(
                JSON.stringify({
                  event: 'zeropg-backup-skip',
                  reason: 'every-n-compactions',
                  compactionCount: this.compactionCount,
                  everyN,
                }),
              )
              return
            }
          }
          // else: ceiling forces the backup — skip floor and N-gate.
        }

        const entry = await archiver.backupOnce()
        if (entry && policy) await archiver.applyRetention(policy)
      } catch (e) {
        // Never fatal to the commit: log and move on.
        console.log(
          JSON.stringify({
            event: 'zeropg-backup-error',
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      }
    }
    if (backup.blocking) {
      await run()
    } else {
      const prev = this.backupInFlight ?? Promise.resolve()
      this.backupInFlight = prev.then(run)
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

  /**
   * Force a full-snapshot compaction now: fold the current state + all shipped
   * WAL into a fresh snapshot and empty the segment list, bounding future
   * cold-start restore to the snapshot alone. No-op if already compact
   * (nothing dirty and no WAL tail). Useful right after a bulk load so the
   * persisted state is a clean snapshot rather than one giant WAL segment.
   */
  async compact(): Promise<CommitInfo | null> {
    if (this.closed) throw new Error('database is closed')
    while (this.commitInFlight) await this.commitInFlight.catch(() => {})
    if (!this.dirty && this.manifest.walSegments.length === 0) return null
    this.commitInFlight = this.commitSnapshot().finally(() => {
      this.lastCasAt = this.now()
      this.commitInFlight = null
    })
    return this.commitInFlight
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
      // Never abandon a background backup mid-upload on a clean shutdown.
      if (this.backupInFlight) await this.backupInFlight.catch(() => {})
    } finally {
      if (this.lease) await this.lease.release().catch(() => {})
      await this.pg.close()
      await this.cleanupScratch().catch(() => {})
    }
  }

  /** Await any in-flight background cold backup (Track D). Tests / graceful
   * shutdown use this to observe the backup that a non-blocking commit kicked
   * off. No-op when no backup target is configured. */
  async drainBackups(): Promise<void> {
    if (this.backupInFlight) await this.backupInFlight.catch(() => {})
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
