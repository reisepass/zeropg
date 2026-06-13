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
          return this.adoptExisting(key)
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

  /** A snapshot object already existed at `key` (a previous run wrote it but
   * lost/never finished the index update). Return its index entry if present;
   * otherwise the object is an orphan a later successful run will adopt. */
  private async adoptExisting(key: string): Promise<BackupEntry | null> {
    const cur = await this.secondary.get(INDEX_KEY)
    if (!cur) return null
    const idx = decodeBackupIndex(cur.bytes)
    return idx.backups.find((b) => b.key === key) ?? null
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
