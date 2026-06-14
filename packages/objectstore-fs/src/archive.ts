// Track D: secondary cold-storage backups (docs/D-COLD-BACKUP.md).
//
// zeropg's primary bucket already IS the live backup — every commit is
// immutable data plus an atomically-swapped manifest. What it does NOT give is
// a second blast radius, retention / point-in-the-past, or a colder/cheaper
// tier. This is the "give me daily backups to a second, colder place, keep the
// last N / drop anything older than X days" feature, expressed in zeropg's
// object model.
//
// Shape: each backup run produces ONE independent, fully-restorable
// full-snapshot object as of a single committed point, plus an index entry.
// Self-contained snapshots (the pg_dump-per-day model) make retention trivial
// (delete any one freely, no WAL chain to reason about) and restore trivial
// (one object -> one datadir). The incremental object-mirror alternative is the
// right tool for PITR, not for an archive whose whole value is independence
// (see D5 / the design doc).
//
// The archiver consumes the primary bucket exactly as ZeroPGReplica does —
// leaseless, read-only, no contention with the writer — and writes to a second
// BlobStore. zeropg ships the mechanism (backupOnce + retention), not the
// scheduler: cadence is the operator's cron line (scripts/backup.ts).
//
// It reuses, not forks: restore.ts (restoreSnapshotInto / applyWalSegments),
// tar.ts (createTarStream / extractTarStream / largestFile), and gc.ts's
// keep-set-first discipline. The only strong primitive remains conditional PUT.

import { PGlite } from '@electric-sql/pglite'
import { type BlobStore, PreconditionFailedError } from '@zeropg/blobstore'
import { MANIFEST_KEY, decodeManifest } from './manifest.js'
import { restoreSnapshotInto, applyWalSegments } from './restore.js'
import { createTarStream, largestFile } from './tar.js'
import { createGzip, gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import * as nodeStream from 'node:stream'
// stream.compose() exists at runtime since Node 16.9 but @types/node omits it.
const compose = (nodeStream as unknown as {
  compose: (...streams: unknown[]) => Readable
}).compose
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One self-contained backup: an independent full-snapshot object plus the
 * metadata retention reasons over. Mirrors a manifest commit point. */
export interface BackupEntry {
  /** Object key in the SECONDARY store, immutable once written. */
  key: string
  /** Source manifest's commit counter at the moment the backup was taken. */
  commitSeq: number
  /** When that commit was made (writer clock) — the DATA age, drives
   * maxAgeDays and GFS bucketing. */
  committedAt: string
  /** When this backup object was written — operational metadata, and the
   * clock the cold-tier minimum-storage-duration guard counts from. */
  createdAt: string
  /** Stored size of the snapshot object (post-codec bytes). */
  sizeBytes: number
  /** 'gzip' (.tar.gz) or 'none' (.tar) — same adaptive codec as the writer. */
  codec: 'gzip' | 'none'
  /** The source manifest's generation, kept for provenance. */
  sourceGeneration: string
  /** The source manifest's fencing token, kept for provenance. */
  fencingToken: number
}

/** The backup index: to the cold store what the manifest is to the primary —
 * the source of truth for what exists and the input to retention. A single
 * small JSON object, written only via CAS so concurrent runs can't clobber it. */
export interface BackupIndex {
  version: 1
  /** Newest last. */
  backups: BackupEntry[]
}

export const INDEX_KEY = 'backups/index.json'

export function encodeBackupIndex(idx: BackupIndex): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(idx, null, 2))
}

export function decodeBackupIndex(bytes: Uint8Array): BackupIndex {
  return JSON.parse(new TextDecoder().decode(bytes)) as BackupIndex
}

/** Backup object key: zero-padded commitSeq (sortable) + a filesystem-safe
 * committedAt (colons/millis stripped), e.g.
 * backups/00000000000000000412-2026-06-13T02-00-05Z.tar.gz */
export function backupKey(commitSeq: number, committedAt: string, codec: 'gzip' | 'none'): string {
  const seq = String(commitSeq).padStart(20, '0')
  const stamp = committedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')
  return `backups/${seq}-${stamp}.tar${codec === 'gzip' ? '.gz' : ''}`
}

/** What to keep in the cold store. The keep-set is the UNION of every
 * configured policy's keep-set: a backup survives if ANY policy wants it. */
export interface RetentionPolicy {
  /** Keep the N most-recent backups. */
  keepLast?: number
  /** Delete backups whose committedAt is older than X days. */
  maxAgeDays?: number
  /** Grandfather-father-son: keep the newest backup in each of the most-recent
   * `daily` days, `weekly` ISO-weeks, and `monthly` months. */
  gfs?: {
    daily?: number
    weekly?: number
    monthly?: number
  }
  /** Honor the destination tier's minimum-storage-duration (default true): do
   * not delete an object younger than the tier minimum, and warn when a policy
   * would routinely churn under it. See CostModel.minStorageDurationDays. */
  respectMinStorageDuration?: boolean
}

const DAY_MS = 86_400_000

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD
}
function utcMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7) // YYYY-MM
}
/** ISO-8601 year-week key (YYYY-Www), Monday-based, sortable lexically. */
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // Thursday of this week decides the ISO year + week number.
  const dayNum = (t.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * DAY_MS))
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** GFS keep-set: bucket the backups by day/week/month, keep the newest in each
 * of the most-recent N buckets of each granularity. `sorted` is ascending. */
function gfsKeep(sorted: BackupEntry[], gfs: NonNullable<RetentionPolicy['gfs']>): Set<string> {
  const keep = new Set<string>()
  const pick = (keyOf: (d: Date) => string, limit?: number) => {
    if (!limit || limit <= 0) return
    // Ascending walk: a later entry in the same bucket overwrites, so each
    // bucket ends up mapped to its newest member.
    const newestPerBucket = new Map<string, BackupEntry>()
    for (const b of sorted) newestPerBucket.set(keyOf(new Date(b.committedAt)), b)
    // Most-recent `limit` buckets: bucket keys sort lexically by time.
    const bucketKeys = [...newestPerBucket.keys()].sort()
    for (const bk of bucketKeys.slice(-limit)) keep.add(newestPerBucket.get(bk)!.key)
  }
  pick(utcDayKey, gfs.daily)
  pick(isoWeekKey, gfs.weekly)
  pick(utcMonthKey, gfs.monthly)
  return keep
}

/**
 * Pure retention decision (unit-tested in isolation): which backups to KEEP
 * under `policy` at wall-clock `nowMs`. The clock is injected exactly as gc.ts
 * does so retention is deterministically testable.
 *
 * The keep-set is the UNION across every configured policy, and the newest
 * backup is ALWAYS kept regardless of policy — the cold store must never go
 * empty while the feature is "on" (the GC-grace-rule analog). Returns the kept
 * subset in newest-last order; deleting `backups \ retain(...)` is the caller's
 * job (applyRetention).
 */
export function retain(backups: BackupEntry[], policy: RetentionPolicy, nowMs: number): BackupEntry[] {
  if (backups.length === 0) return []
  const sorted = [...backups].sort(
    (a, b) => Date.parse(a.committedAt) - Date.parse(b.committedAt) || a.commitSeq - b.commitSeq,
  )
  const keep = new Set<string>()
  // Invariant, always: never delete the most-recent backup.
  keep.add(sorted[sorted.length - 1].key)

  if (policy.keepLast && policy.keepLast > 0) {
    for (const b of sorted.slice(-policy.keepLast)) keep.add(b.key)
  }
  if (policy.maxAgeDays && policy.maxAgeDays > 0) {
    const cutoff = nowMs - policy.maxAgeDays * DAY_MS
    for (const b of sorted) if (Date.parse(b.committedAt) >= cutoff) keep.add(b.key)
  }
  if (policy.gfs) {
    for (const k of gfsKeep(sorted, policy.gfs)) keep.add(k)
  }
  return sorted.filter((b) => keep.has(b.key))
}

/** Outcome of an applyRetention sweep. */
export interface RetentionResult {
  /** Backups still present after the sweep (kept by policy or blocked). */
  kept: BackupEntry[]
  /** Backups deleted from the secondary (empty on dryRun). */
  deleted: BackupEntry[]
  /** Backups a policy wanted to delete but the cold-tier minimum-storage-
   * duration guard kept (too young to delete without an early-deletion fee). */
  blocked: BackupEntry[]
  bytesFreed: number
}

export interface ColdArchiverOptions {
  /** Local scratch directory for the temp restore datadir. Default os.tmpdir(). */
  scratchDir?: string
  /** Injectable clock (tests), as gc.ts does. Default Date.now. */
  now?: () => number
  /** Structured log sink for the no-op/skip/warn events a cron run emits.
   * Default: one JSON line per event on stdout. */
  log?: (event: Record<string, unknown>) => void
}

export class ColdArchiver {
  readonly primary: BlobStore
  readonly secondary: BlobStore
  private scratchBase: string
  private now: () => number
  private log: (event: Record<string, unknown>) => void

  constructor(primary: BlobStore, secondary: BlobStore, opts: ColdArchiverOptions = {}) {
    this.primary = primary
    this.secondary = secondary
    this.scratchBase = opts.scratchDir ?? tmpdir()
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((e) => console.log(JSON.stringify(e)))
  }

  /**
   * Take one self-contained backup of the primary's current committed point
   * and append it to the cold-store index. Returns the new entry, or null when
   * there is nothing to back up (empty/migrated primary) — a logged no-op,
   * never an error (cf. gc.ts returning empty on no manifest).
   *
   * Algorithm (design doc "out-of-process archiver"):
   *   1. GET the current manifest from the PRIMARY (pins the committed point).
   *   2. Restore it into a temp datadir (restoreSnapshotInto + applyWalSegments,
   *      the exact existing restore path).
   *   3. CHECKPOINT and re-tar a clean, WAL-folded full snapshot.
   *   4. putStream to the SECONDARY at an immutable backups/<seq>-<at> key
   *      (ifNoneMatch: backup keys are never reused).
   *   5. Append to the CAS'd backup index.
   */
  async backupOnce(): Promise<BackupEntry | null> {
    const cur = await this.primary.get(MANIFEST_KEY)
    if (!cur) {
      this.log({ event: 'zeropg-backup-skip', reason: 'no manifest at primary (empty bucket)' })
      return null
    }
    const m = decodeManifest(cur.bytes)
    if (m.movedTo) {
      this.log({ event: 'zeropg-backup-skip', reason: 'primary migrated out', movedTo: m.movedTo })
      return null
    }

    const dir = await mkdtemp(join(this.scratchBase, 'zpg-backup-'))
    try {
      // Reuse the writer/replica restore path verbatim: snapshot + WAL overlay.
      await restoreSnapshotInto(this.primary, dir, m.snapshot)
      await applyWalSegments(this.primary, dir, m)

      // Fold the WAL into a clean snapshot: boot PGlite on the restored datadir,
      // double-CHECKPOINT (moves the redo point, lets segments unlink), sync to
      // FS so the tar reads settled bytes — exactly the writer's snapshot prep.
      const pg = await PGlite.create({ dataDir: dir })
      await pg.waitReady
      try {
        await pg.exec('CHECKPOINT')
        await pg.exec('CHECKPOINT')
      } catch {
        // CHECKPOINT may be unavailable in some PGlite builds; snapshot anyway.
      }
      await pg.syncToFs().catch(() => {})
      await pg.close()

      const codec = await this.chooseCodec(dir)
      const key = backupKey(m.commitSeq, m.committedAt, codec)

      // putStream create-if-absent. A duplicate key (same commitSeq already
      // archived) is an idempotent no-op: the object is immutable and the index
      // already (or will) name it.
      let sizeBytes = 0
      const tar = Readable.from(createTarStream(dir))
      const body = codec === 'gzip' ? compose(tar, createGzip({ level: 1 })) : tar
      const counted = async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          sizeBytes += chunk.length
          yield chunk
        }
      }
      try {
        await this.secondary.putStream(key, counted(), {
          ifNoneMatch: true,
          contentType: codec === 'gzip' ? 'application/gzip' : 'application/x-tar',
        })
      } catch (e) {
        if (e instanceof PreconditionFailedError) {
          this.log({ event: 'zeropg-backup-exists', key, commitSeq: m.commitSeq })
          return this.adoptExisting(key, m, codec)
        }
        throw e
      }

      const entry: BackupEntry = {
        key,
        commitSeq: m.commitSeq,
        committedAt: m.committedAt,
        createdAt: new Date(this.now()).toISOString(),
        sizeBytes,
        codec,
        sourceGeneration: m.generation,
        fencingToken: m.fencingToken,
      }
      await this.appendToIndex(entry)
      this.log({
        event: 'zeropg-backup-ok',
        key,
        commitSeq: entry.commitSeq,
        sizeBytes: entry.sizeBytes,
        codec: entry.codec,
      })
      return entry
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Append an entry to the CAS'd backup index, retrying on a lost race exactly
   * as the manifest commit does. Idempotent: an entry whose key already exists
   * is left as-is (a re-run that adopted a pre-existing snapshot object). */
  private async appendToIndex(entry: BackupEntry): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.secondary.get(INDEX_KEY)
      if (!cur) {
        const idx: BackupIndex = { version: 1, backups: [entry] }
        try {
          await this.secondary.put(INDEX_KEY, encodeBackupIndex(idx), {
            ifNoneMatch: true,
            contentType: 'application/json',
          })
          return
        } catch (e) {
          if (e instanceof PreconditionFailedError) continue // someone created it; re-read
          throw e
        }
      }
      const idx = decodeBackupIndex(cur.bytes)
      if (idx.backups.some((b) => b.key === entry.key)) return // already recorded
      idx.backups.push(entry)
      idx.backups.sort((a, b) => a.commitSeq - b.commitSeq) // newest last
      try {
        await this.secondary.put(INDEX_KEY, encodeBackupIndex(idx), {
          ifMatch: cur.etag,
          contentType: 'application/json',
        })
        return
      } catch (e) {
        if (e instanceof PreconditionFailedError) continue // lost the race; re-read + retry
        throw e
      }
    }
    throw new Error('backup index CAS failed after repeated races')
  }

  /**
   * A snapshot object already existed at `key`. Two cases:
   *   1. A previous run fully recorded it — its entry is in the index; return it
   *      (the idempotent re-run path).
   *   2. A previous run wrote the object but CRASHED before the index append —
   *      the object is an orphan the index never names. The object IS a complete,
   *      immutable snapshot of THIS committed point (same key => same commitSeq),
   *      so we can finish what the dead run started: reconstruct the entry from
   *      the manifest we are holding + the object's real stored size, and append
   *      it. This is what makes "crash mid-backup, next backup succeeds" hold —
   *      without it the orphan is un-adoptable and the backup is lost forever.
   */
  private async adoptExisting(
    key: string,
    m: ReturnType<typeof decodeManifest>,
    codec: 'gzip' | 'none',
  ): Promise<BackupEntry | null> {
    const cur = await this.secondary.get(INDEX_KEY)
    if (cur) {
      const existing = decodeBackupIndex(cur.bytes).backups.find((b) => b.key === key)
      if (existing) return existing // case 1: already recorded
    }
    // Case 2: orphan from a crashed prior run. Confirm the object is really
    // there, get its true stored size, and adopt it into the index.
    const head = await this.secondary.head(key)
    if (!head) return null // raced away (e.g. a concurrent retention sweep); skip
    const entry: BackupEntry = {
      key,
      commitSeq: m.commitSeq,
      committedAt: m.committedAt,
      createdAt: new Date(this.now()).toISOString(),
      sizeBytes: head.size,
      codec,
      sourceGeneration: m.generation,
      fencingToken: m.fencingToken,
    }
    await this.appendToIndex(entry)
    this.log({ event: 'zeropg-backup-adopted-orphan', key, commitSeq: m.commitSeq, sizeBytes: head.size })
    return entry
  }

  /**
   * Restore a backup from the cold store into a datadir. Picks the entry by
   * `commitSeq` if given, else the newest. A backup is already a clean,
   * WAL-folded snapshot, so this is the snapshot half of the restore path with
   * NO WAL overlay (restoreSnapshotInto handles the .tar / .tar.gz codecs).
   *
   * Returns the chosen entry + the datadir it was materialized into; the caller
   * boots a ZeroPG/PGlite on it directly, or seeds a fresh primary bucket from
   * it for disaster recovery into a new home.
   */
  async restoreFromBackup(
    seq?: number,
    into?: string,
  ): Promise<{ entry: BackupEntry; dir: string; bytes: number }> {
    const cur = await this.secondary.get(INDEX_KEY)
    if (!cur) throw new Error('no backup index at secondary (nothing to restore)')
    const idx = decodeBackupIndex(cur.bytes)
    if (idx.backups.length === 0) throw new Error('backup index is empty')
    const entry =
      seq === undefined
        ? idx.backups[idx.backups.length - 1] // newest last
        : idx.backups.find((b) => b.commitSeq === seq)
    if (!entry) throw new Error(`no backup with commitSeq ${seq}`)

    const dir = into ?? (await mkdtemp(join(this.scratchBase, 'zpg-restore-')))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const bytes = await restoreSnapshotInto(this.secondary, dir, entry.key)
    this.log({ event: 'zeropg-restore-ok', key: entry.key, commitSeq: entry.commitSeq, dir, bytes })
    return { entry, dir, bytes }
  }

  /**
   * Apply a retention policy to the cold store: compute the keep-set with the
   * pure `retain`, delete everything outside it from the secondary, and rewrite
   * the index — mirroring gc.ts's keep-set-first discipline (never delete
   * outside the computed set).
   *
   * Cold-tier guard: when respectMinStorageDuration is set (default) and the
   * destination's CostModel declares a minStorageDurationDays, an object younger
   * than that minimum is NOT deleted (deleting early still pays the floored
   * price — the opposite of the savings the cold tier is for); it is reported as
   * `blocked` and survives in the index. A policy that would routinely churn
   * under the minimum (e.g. maxAgeDays below it) is warned about.
   */
  async applyRetention(
    policy: RetentionPolicy,
    opts: { dryRun?: boolean } = {},
  ): Promise<RetentionResult> {
    const cur = await this.secondary.get(INDEX_KEY)
    if (!cur) {
      // No index: nothing exists to judge, so do nothing (cf. gc.ts on no manifest).
      this.log({ event: 'zeropg-retention-skip', reason: 'no backup index' })
      return { kept: [], deleted: [], blocked: [], bytesFreed: 0 }
    }
    const dryRun = opts.dryRun ?? false
    const idx = decodeBackupIndex(cur.bytes)
    const nowMs = this.now()
    const keepKeys = new Set(retain(idx.backups, policy, nowMs).map((b) => b.key))

    const minDays = this.secondary.cost?.minStorageDurationDays
    const respectMin = policy.respectMinStorageDuration ?? true
    if (respectMin && minDays && policy.maxAgeDays && policy.maxAgeDays < minDays) {
      this.log({
        event: 'zeropg-retention-warn',
        reason: `maxAgeDays ${policy.maxAgeDays} on a tier with a ${minDays}-day minimum storage duration will incur early-deletion fees on every backup; raise maxAgeDays >= ${minDays} or use a Standard/IA-class bucket`,
      })
    }

    const deleted: BackupEntry[] = []
    const blocked: BackupEntry[] = []
    let bytesFreed = 0
    for (const b of idx.backups) {
      if (keepKeys.has(b.key)) continue
      // Min-storage-duration counts from object creation (createdAt).
      if (respectMin && minDays) {
        const ageDays = (nowMs - Date.parse(b.createdAt)) / DAY_MS
        if (ageDays < minDays) {
          blocked.push(b)
          this.log({ event: 'zeropg-retention-blocked', key: b.key, ageDays: Math.floor(ageDays), minDays })
          continue
        }
      }
      if (!dryRun) await this.secondary.delete(b.key)
      deleted.push(b)
      bytesFreed += b.sizeBytes
    }

    // Survivors = policy-kept plus min-duration-blocked (those still exist).
    const deletedKeys = new Set(deleted.map((b) => b.key))
    const kept = idx.backups.filter((b) => !deletedKeys.has(b.key))
    if (!dryRun && deleted.length > 0) {
      const newIdx: BackupIndex = { version: 1, backups: kept }
      // CAS the index against the version we read; a concurrent run racing us
      // means our delete-set may be stale, so surface the conflict.
      await this.secondary.put(INDEX_KEY, encodeBackupIndex(newIdx), {
        ifMatch: cur.etag,
        contentType: 'application/json',
      })
    }
    this.log({
      event: 'zeropg-retention-ok',
      dryRun,
      kept: kept.length,
      deleted: deleted.length,
      blocked: blocked.length,
      bytesFreed,
    })
    return { kept, deleted, blocked, bytesFreed }
  }

  /**
   * Decide the snapshot codec by test-compressing a slice of the largest heap
   * file (mirrors ZeroPG.chooseCodec): incompressible data makes gzip pure CPU
   * waste, so ship raw tar and let the NIC do the work.
   */
  private async chooseCodec(dir: string): Promise<'gzip' | 'none'> {
    try {
      const big = await largestFile(dir)
      if (!big || big.size < 1024 * 1024) return 'gzip' // small DB: gzip is cheap
      const { open } = await import('node:fs/promises')
      const sample = Buffer.alloc(Math.min(big.size, 4 * 1024 * 1024))
      const f = await open(big.path, 'r')
      try {
        await f.read(sample, 0, sample.length, 0)
      } finally {
        await f.close()
      }
      const ratio = gzipSync(sample, { level: 1 }).length / sample.length
      return ratio > 0.65 ? 'none' : 'gzip'
    } catch {
      return 'gzip'
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred (see docs/D-COLD-BACKUP.md "Phasing"):
//   D4: storage-class support on GcsBlobStore / R2BlobStore (Archive/Coldline ·
//       Glacier/Deep-Archive/IA applied on PUT) + cost rows for the cold tiers.
//       The archiver just writes to whichever store it is handed.
//   D5: (after A2) optional incremental/PITR mode — mirror numbered manifests +
//       WAL for restore-as-of-any-commit, layered over this snapshot archive.
// ---------------------------------------------------------------------------
