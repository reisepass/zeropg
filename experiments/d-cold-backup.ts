// Track D unit + round-trip checks for secondary cold-storage backups
// (docs/D-COLD-BACKUP.md). Store-less: runs against MemBlobStore, no bucket, so
// CI can run it like unit-local.
//
//   tsx experiments/d-cold-backup.ts
//
// Covers:
//   - backup -> wipe -> restore -> assert row/byte equality (the D3 gate)
//   - backupOnce no-op on an empty primary; idempotent re-run
//   - retain(): keepLast / maxAgeDays / GFS / union / always-keep-newest, with
//     an injected clock
//   - applyRetention(): deletion + index rewrite + dryRun + the cold-tier
//     minimum-storage-duration guard

import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import {
  ColdArchiver,
  decodeBackupIndex,
  encodeBackupIndex,
  retain,
  INDEX_KEY,
  type BackupEntry,
  type BackupIndex,
} from '../packages/objectstore-fs/src/index.js'
import { ZeroPG } from '../packages/objectstore-fs/src/index.js'
import { type CostModel } from '../packages/blobstore/src/index.js'
import { MemBlobStore } from './_memstore.js'
import { section, assert, failureCount, resetFailures } from './_util.js'

const DAY_MS = 86_400_000
const NOW = Date.parse('2026-06-13T00:00:00.000Z')

/** Checksum the whole kv table so a reopen can be proven byte-identical. */
async function checksum(pg: PGlite): Promise<string> {
  const { rows } = await pg.query<{ id: number; v: string }>('SELECT id, v FROM kv ORDER BY id')
  const h = createHash('sha256')
  for (const r of rows) h.update(`${r.id} ${r.v}\n`)
  return `${rows.length}:${h.digest('hex').slice(0, 16)}`
}

async function backupRoundTrip() {
  section('cold backup: round-trip (backup -> wipe -> restore -> assert)')
  const primary = new MemBlobStore()
  const secondary = new MemBlobStore()

  const db = await ZeroPG.open({ store: primary, holder: 'writer' })
  await db.exec('CREATE TABLE kv (id int primary key, v text)')
  for (let i = 0; i < 2000; i++) await db.raw.exec(`INSERT INTO kv VALUES (${i}, 'payload-${i}')`)
  ;(db as unknown as { dirty: boolean }).dirty = true
  await db.commit()
  const srcSum = await checksum(db.raw)
  await db.close()

  const archiver = new ColdArchiver(primary, secondary)
  const entry = await archiver.backupOnce()
  assert(entry !== null, 'backupOnce produced an entry')
  assert(entry!.key.startsWith('backups/') && entry!.key.endsWith('.tar.gz'), 'backup key is a gzipped tar under backups/')

  // "Wipe": the primary is gone (second blast radius). A recovery archiver with
  // a BRAND-NEW empty primary restores using ONLY the secondary backup.
  const recovery = new ColdArchiver(new MemBlobStore(), secondary)
  const { dir, entry: restored } = await recovery.restoreFromBackup()
  assert(restored.commitSeq === entry!.commitSeq, 'restore picked the newest backup')

  const pg = await PGlite.create({ dataDir: dir })
  await pg.waitReady
  const dstSum = await checksum(pg)
  const { rows } = await pg.query<{ n: string }>('SELECT count(*)::text n FROM kv')
  await pg.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})

  assert(rows[0]!.n === '2000', `restored row count matches (2000 == ${rows[0]!.n})`)
  assert(srcSum === dstSum, `restored data byte-identical (${srcSum} == ${dstSum})`)
}

async function backupNoOpAndIdempotent() {
  section('cold backup: empty-primary no-op + idempotent re-run')
  const emptyArchiver = new ColdArchiver(new MemBlobStore(), new MemBlobStore())
  const none = await emptyArchiver.backupOnce()
  assert(none === null, 'backupOnce on an empty primary is a no-op (null), not an error')

  const primary = new MemBlobStore()
  const secondary = new MemBlobStore()
  const db = await ZeroPG.open({ store: primary, holder: 'writer' })
  await db.exec('CREATE TABLE t (id int)')
  await db.query('INSERT INTO t VALUES (1)')
  await db.close()

  const archiver = new ColdArchiver(primary, secondary)
  const first = await archiver.backupOnce()
  const again = await archiver.backupOnce()
  assert(first !== null && again !== null && first.key === again.key, 'idempotent re-run adopts the same backup key')
  const idx = decodeBackupIndex((await secondary.get(INDEX_KEY))!.bytes)
  assert(idx.backups.length === 1, 'index holds exactly one entry after a re-run (no duplicate)')
}

// --- retain(): pure, injected clock ---------------------------------------

/** One backup per day for the last `n` days, commitSeq ascending with recency.
 * createdAt == committedAt for these synthetic entries. */
function dailyBackups(n: number): BackupEntry[] {
  const out: BackupEntry[] = []
  for (let i = n - 1; i >= 0; i--) {
    const at = new Date(NOW - i * DAY_MS).toISOString()
    out.push({
      key: `backups/${String(n - i).padStart(20, '0')}-${at.replace(/[:.]/g, '-')}.tar.gz`,
      commitSeq: n - i,
      committedAt: at,
      createdAt: at,
      sizeBytes: 1000,
      codec: 'gzip',
      sourceGeneration: 'g',
      fencingToken: 1,
    })
  }
  return out
}

function retainUnit() {
  section('retain(): keepLast / maxAgeDays / GFS / union / never-delete-newest')
  const b40 = dailyBackups(40)
  const newestKey = b40[b40.length - 1].key

  assert(retain(b40, { keepLast: 5 }, NOW).length === 5, 'keepLast 5 keeps 5')
  // committedAt >= now-7d covers days 0..7 inclusive = 8 backups.
  assert(retain(b40, { maxAgeDays: 7 }, NOW).length === 8, 'maxAgeDays 7 keeps the 8 within 7 days')

  // Union, not intersection: keepLast 3 OR maxAgeDays 7 == the 8 within 7d
  // (which already contain the freshest 3).
  assert(retain(b40, { keepLast: 3, maxAgeDays: 7 }, NOW).length === 8, 'union is the larger of overlapping sets')

  const empty = retain(b40, {}, NOW)
  assert(empty.length === 1 && empty[0].key === newestKey, 'empty policy still keeps the newest backup')

  assert(retain(b40, { gfs: { daily: 7 } }, NOW).length === 7, 'GFS daily 7 keeps 7 distinct days')
  assert(retain(b40, { gfs: { weekly: 4 } }, NOW).length === 4, 'GFS weekly 4 keeps 4 distinct ISO-weeks')
  // 40 days spans 2-3 calendar months; monthly 12 keeps one per month present.
  const monthly = retain(b40, { gfs: { monthly: 12 } }, NOW).length
  assert(monthly >= 2 && monthly <= 3, `GFS monthly 12 over 40 days keeps one per month (${monthly})`)

  // GFS union keeps the newest of each granularity's buckets.
  const all = retain(b40, { gfs: { daily: 7, weekly: 4, monthly: 12 } }, NOW)
  assert(all.some((b) => b.key === newestKey), 'GFS union includes the newest backup')

  const ordered = retain(b40, { keepLast: 5 }, NOW)
  const sortedAsc = ordered.every(
    (b, i) => i === 0 || Date.parse(ordered[i - 1].committedAt) <= Date.parse(b.committedAt),
  )
  assert(sortedAsc, 'retain returns the kept subset newest-last')

  assert(retain([], { keepLast: 5 }, NOW).length === 0, 'retain on empty input is empty')
}

// --- applyRetention(): deletion + index rewrite + cold-tier guard ----------

/** A secondary whose tier bills a minimum storage duration. */
class ColdMemBlobStore extends MemBlobStore {
  readonly cost: CostModel
  constructor(minStorageDurationDays: number) {
    super()
    this.cost = {
      asOf: '2026-06',
      writeOpUsd: 0,
      readOpUsd: 0,
      storageGbMonthUsd: 0,
      internetEgressGbUsd: 0,
      minStorageDurationDays,
    }
  }
}

async function seedIndex(store: MemBlobStore, entries: BackupEntry[]) {
  for (const e of entries) await store.put(e.key, new Uint8Array(e.sizeBytes))
  const idx: BackupIndex = { version: 1, backups: entries }
  await store.put(INDEX_KEY, encodeBackupIndex(idx), { contentType: 'application/json' })
}

async function applyRetentionUnit() {
  section('applyRetention(): delete + rewrite index, dryRun, min-storage guard')

  // Standard tier: keepLast 5 over 40 deletes 35 and physically removes them.
  {
    const sec = new MemBlobStore()
    await seedIndex(sec, dailyBackups(40))
    const arch = new ColdArchiver(new MemBlobStore(), sec, { now: () => NOW, log: () => {} })
    const r = await arch.applyRetention({ keepLast: 5 })
    assert(r.kept.length === 5 && r.deleted.length === 35, 'keepLast 5 deletes 35, keeps 5')
    const idx = decodeBackupIndex((await sec.get(INDEX_KEY))!.bytes)
    assert(idx.backups.length === 5, 'index rewritten to the kept set')
    assert((await sec.get(r.deleted[0].key)) === null, 'a deleted backup object is gone from the store')
  }

  // dryRun: reports the same delete-set but touches nothing.
  {
    const sec = new MemBlobStore()
    await seedIndex(sec, dailyBackups(40))
    const arch = new ColdArchiver(new MemBlobStore(), sec, { now: () => NOW, log: () => {} })
    const r = await arch.applyRetention({ keepLast: 5 }, { dryRun: true })
    const idx = decodeBackupIndex((await sec.get(INDEX_KEY))!.bytes)
    assert(r.deleted.length === 35 && idx.backups.length === 40, 'dryRun reports 35 but leaves the index at 40')
  }

  // Cold tier, 90d minimum: every backup is younger than 90d, so a maxAgeDays:7
  // policy blocks all early deletes (deleted == 0) rather than pay the floor.
  {
    const sec = new ColdMemBlobStore(90)
    await seedIndex(sec, dailyBackups(40))
    const arch = new ColdArchiver(new MemBlobStore(), sec, { now: () => NOW, log: () => {} })
    const r = await arch.applyRetention({ maxAgeDays: 7 })
    assert(r.deleted.length === 0, 'min-storage guard blocks all deletes of objects younger than the tier minimum')
    assert(r.blocked.length === 32, '32 too-young backups reported as blocked')
    assert(r.kept.length === 40, 'nothing actually removed, so the index is unchanged')
  }

  // Cold tier, 90d minimum, but the objects are 100-140 days old: now deletable.
  {
    const sec = new ColdMemBlobStore(90)
    const old: BackupEntry[] = [140, 130, 120, 110, 100].map((d, i) => {
      const at = new Date(NOW - d * DAY_MS).toISOString()
      return {
        key: `backups/${String(i).padStart(20, '0')}-old.tar.gz`,
        commitSeq: i,
        committedAt: at,
        createdAt: at,
        sizeBytes: 1000,
        codec: 'gzip',
        sourceGeneration: 'g',
        fencingToken: 1,
      }
    })
    await seedIndex(sec, old)
    const arch = new ColdArchiver(new MemBlobStore(), sec, { now: () => NOW, log: () => {} })
    const r = await arch.applyRetention({ keepLast: 1, maxAgeDays: 90 })
    assert(r.deleted.length === 4 && r.kept.length === 1, 'objects past the tier minimum are deleted (4), newest kept')
  }
}

async function main() {
  resetFailures()
  console.log('Track D — cold-storage backups (store-less, MemBlobStore)')
  await backupRoundTrip()
  await backupNoOpAndIdempotent()
  retainUnit()
  await applyRetentionUnit()
  section(failureCount() === 0 ? '✅ d-cold-backup PASSED' : `❌ ${failureCount()} FAILURES`)
  process.exit(failureCount() === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
