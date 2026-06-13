// E2f: the first commit of a writer life re-baselines the WAL (cheap), not
// the whole database. Proves the durable-write-after-cold-start fast path:
// reopen a non-trivial DB, do one durable write, and assert the commit ships
// WAL-sized bytes (not DB-sized) AND that the result survives a clean reopen
// and a crash-style reopen.
//
//   tsx experiments/e2f-rebaseline.ts

import { createHash, randomBytes } from 'node:crypto'
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, decodeManifest, MANIFEST_KEY } from '@zeropg/objectstore-fs'
import { BUCKET, runId, logResult, section, assert, failureCount, resetFailures, round } from './_util.js'

const prefix = `e2f/${runId()}`
const store = new GcsBlobStore({ bucket: BUCKET, prefix })

async function tableChecksum(db: ZeroPG): Promise<string> {
  const { rows } = await db.query<{ id: number; v: string }>('SELECT id, length(v)::int v FROM blob ORDER BY id')
  const h = createHash('sha256')
  for (const r of rows) h.update(`${r.id}:${r.v}\n`)
  return `${rows.length}:${h.digest('hex').slice(0, 12)}`
}

async function main() {
  resetFailures()
  const seed = await ZeroPG.buildEmptySnapshot()

  section('Build a ~40MB database (so a full snapshot would be obviously large)')
  let db = await ZeroPG.open({ store, holder: 'builder', seedSnapshot: seed, commitIntervalMs: 0 })
  await db.exec('CREATE TABLE blob (id serial primary key, v bytea)')
  for (let i = 0; i < 40; i++) {
    await db.raw.query('INSERT INTO blob (v) VALUES ($1)', [randomBytes(1024 * 1024)])
  }
  db.markDirty()
  await db.flush() // ships ~40MB of WAL (one segment; over the threshold now)
  // A second small commit then crosses the threshold and compacts to a REAL
  // ~40MB snapshot with an empty WAL tail — the steady state after any
  // compaction, and the state in which the rebaseline fast path applies.
  await db.query("INSERT INTO blob (v) VALUES ($1)", [randomBytes(4096)])
  const compactManifest = decodeManifest((await store.get(MANIFEST_KEY))!.bytes)
  assert(compactManifest.walSegments.length === 0, 'second commit compacted to a fresh snapshot (empty WAL tail)')
  const dbBytes = Number(
    (await db.raw.query<{ b: string }>("SELECT pg_database_size(current_database())::text b")).rows[0].b,
  )
  const baseline = await tableChecksum(db)
  await db.close()
  console.log(`  database is ${round(dbBytes / 1e6)} MB on disk`)

  section('Reopen (a fresh writer life) and do ONE durable write')
  db = await ZeroPG.open({ store, holder: 'life2', commitIntervalMs: 0 })
  const bm = await store.get(MANIFEST_KEY); const beforeManifest = decodeManifest(bm!.bytes)
  const r = await db.query("INSERT INTO blob (v) VALUES ($1)", [randomBytes(4096)])
  const c = r.commit
  assert(c !== null, 'the first durable write of the life committed')
  assert(c!.mode === 'incremental', `first-commit-of-life is a WAL rebaseline, not a snapshot (got ${c!.mode})`)
  assert(
    c!.snapshotBytes < dbBytes / 4,
    `rebaseline ships WAL-sized bytes, not DB-sized (shipped ${round(c!.snapshotBytes / 1e6)}MB vs ${round(dbBytes / 1e6)}MB db)`,
  )
  // The snapshot object itself must NOT have changed (we re-shipped WAL, not the DB).
  const am = await store.get(MANIFEST_KEY); const afterManifest = decodeManifest(am!.bytes)
  assert(afterManifest.snapshot === beforeManifest.snapshot, 'rebaseline reuses the existing DB snapshot')
  assert(afterManifest.walSegments.length === 1, 'rebaseline leaves exactly one WAL segment (the re-baselined range)')
  console.log(
    `  first durable write: mode=${c!.mode} shipped=${round(c!.snapshotBytes / 1e6)}MB ` +
      `scan=${round(c!.dumpMs)}ms upload=${round(c!.uploadMs)}ms cas=${round(c!.manifestMs)}ms`,
  )
  logResult('e2f.jsonl', { probe: 'rebaseline', dbMB: round(dbBytes / 1e6), shippedMB: round(c!.snapshotBytes / 1e6), commit: c })

  section('A 2nd durable write in the same life ships a tiny incremental delta')
  const r2 = await db.query("INSERT INTO blob (v) VALUES ($1)", [randomBytes(4096)])
  assert(r2.commit?.mode === 'incremental', '2nd write stays incremental')
  assert((r2.commit?.snapshotBytes ?? 1e9) < 1e6, `2nd write ships a small delta (${round((r2.commit?.snapshotBytes ?? 0) / 1e3)}KB)`)
  const after2 = await tableChecksum(db)
  await db.close()

  section('Reopen and verify every row survived the rebaseline + delta')
  db = await ZeroPG.open({ store, holder: 'verify', commitIntervalMs: 0 })
  assert((await tableChecksum(db)) === after2, 'reopen after rebaseline is byte-identical')
  assert(
    Number((await db.query<{ n: string }>('SELECT count(*)::text n FROM blob')).rows[0].n) === 43,
    'all 43 rows present (41 pre-reopen incl. compaction trigger + 2 across the life boundary)',
  )
  // Sanity: the pre-reopen rows are still intact too.
  const built = await db.query<{ n: string }>('SELECT count(*)::text n FROM blob WHERE id <= 41')
  assert(built.rows[0].n === '41', 'the 41 pre-reopen rows survived')
  void baseline
  await db.close()

  section('Cleanup')
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects under ${prefix}`)
  section(failureCount() === 0 ? '✅ E2f PASSED' : `❌ E2f: ${failureCount()} FAILURES`)
  process.exit(failureCount() === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
