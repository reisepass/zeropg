// E2c: incremental WAL shipping correctness + latency (V1-WAL-SHIPPING.md).
//
//   1. Roundtrip: many strict single-row commits across reopens; contents
//      byte-identical; commits between compactions upload NO snapshot.
//   2. Latency: strict incremental commit p50 well under the v0 snapshot cost.
//   3. Compaction: thresholds roll a new snapshot, old one becomes the
//      previousSnapshot backup, segments fold in and get deleted.
//   4. Migration: a v1-manifest database upgrades itself (first commit
//      compacts, subsequent commits ship segments).
//
//   tsx experiments/e2c-incremental.ts
//
// Uses a throwaway bucket prefix; cleans up after itself.

import { createHash, randomBytes } from 'node:crypto'
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, decodeManifest, MANIFEST_KEY } from '@zeropg/objectstore-fs'
import { BUCKET, runId, logResult, section, assert, failureCount, resetFailures, stats, round } from './_util.js'

const prefix = `e2c/${runId()}`
const store = new GcsBlobStore({ bucket: BUCKET, prefix })

async function tableChecksum(db: ZeroPG): Promise<string> {
  const { rows } = await db.query<{ id: number; v: string }>('SELECT id, v FROM kv ORDER BY id')
  const h = createHash('sha256')
  for (const r of rows) h.update(`${r.id} ${r.v}\n`)
  return `${rows.length}:${h.digest('hex').slice(0, 12)}`
}

async function currentManifest() {
  const obj = await store.get(MANIFEST_KEY)
  if (!obj) throw new Error('no manifest')
  return decodeManifest(obj.bytes)
}

async function main() {
  resetFailures()
  const seed = await ZeroPG.buildEmptySnapshot()

  // ---------------------------------------------------------------- 1+2
  section('Incremental roundtrip: 60 strict commits across 3 reopens')
  let db = await ZeroPG.open({ store, holder: 'w0', seedSnapshot: seed, commitIntervalMs: 450 })
  await db.exec('CREATE TABLE kv (id int primary key, v text)')
  const m0 = await currentManifest()
  assert(m0.version === 2, `fresh DB writes a v2 manifest (got v${m0.version})`)

  const latencies: number[] = []
  const costs: number[] = [] // dump+upload+CAS: the commit's own work, sans 429-retry waits
  let modes = { incremental: 0, snapshot: 0 }
  let id = 0
  for (let reopen = 0; reopen < 3; reopen++) {
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      const r = await db.query('INSERT INTO kv VALUES ($1, $2)', [id, `row-${id}-${'x'.repeat(100)}`])
      latencies.push(performance.now() - t0)
      if (r.commit) {
        modes[r.commit.mode]++
        costs.push(r.commit.dumpMs + r.commit.uploadMs + r.commit.manifestMs)
      }
      id++
    }
    const sum = await tableChecksum(db)
    await db.close()
    db = await ZeroPG.open({ store, holder: `w${reopen + 1}`, commitIntervalMs: 450 })
    const sum2 = await tableChecksum(db)
    assert(sum === sum2, `reopen ${reopen + 1}: state survives (${sum} == ${sum2})`)
  }
  const lat = stats(latencies)
  const cost = stats(costs)
  const m1 = await currentManifest()
  console.log(
    `  strict commit: wall p50=${lat.p50}ms p99=${lat.p99}ms | ` +
      `commit-work p50=${cost.p50}ms (scan+PUT+CAS, sans rate-limit retries) | ` +
      `modes: ${modes.incremental} incremental / ${modes.snapshot} snapshot | ` +
      `manifest: ${m1.walSegments.length} segments, commitSeq=${m1.commitSeq}`,
  )
  assert(modes.incremental >= 55, `commits ship incrementally (${modes.incremental}/60)`)
  // The commit's own work must be ~flat and small (v0 was 7,800ms on a 50MB
  // DB). Wall latency above it is GCS's per-object rate limit + our backoff,
  // which group-commit pacing absorbs for real concurrent workloads.
  assert(cost.p50 < 500, `incremental commit work p50 < 500ms (got ${cost.p50}ms)`)
  assert(lat.p50 < 2000, `wall p50 under the rate-limited ceiling (got ${lat.p50}ms)`)
  logResult('e2c.jsonl', { probe: 'roundtrip', latency: lat, commitWork: cost, modes, segments: m1.walSegments.length })

  // ---------------------------------------------------------------- 3
  section('Compaction: cross the byte threshold, snapshot rolls, backup kept')
  const preCompact = await currentManifest()
  // ~18MB of WAL in one burst. Must be INCOMPRESSIBLE: TOAST pglz squashes
  // repetitive bytea before it ever reaches the WAL (measured: a 18MB
  // repeat()-burst produced ~200KB of WAL and never crossed the threshold).
  await db.exec('CREATE TABLE blob (id serial primary key, v bytea)')
  for (let i = 0; i < 18; i++) {
    await db.raw.query('INSERT INTO blob (v) VALUES ($1)', [randomBytes(1024 * 1024)])
  }
  db.markDirty()
  const burst = await db.flush() // ships the whole burst as one ~18MB segment
  console.log(`  burst commit: mode=${burst?.mode} ${(burst?.snapshotBytes ?? 0 / 1e6).toLocaleString()} bytes`)
  const r1 = await db.query('INSERT INTO kv VALUES (100000, $1)', ['post-burst'])
  // The burst put us over COMPACT_AT_WAL_BYTES, so a commit in this window
  // must have compacted: fresh snapshot, empty segment list, backup recorded.
  const m2 = await currentManifest()
  assert(m2.walSegments.length < preCompact.walSegments.length + 2, 'compaction reset the segment list')
  assert(m2.previousSnapshot !== undefined, 'compacted-away snapshot kept as previousSnapshot backup')
  assert(m2.snapshot !== preCompact.snapshot, 'compaction rolled a new snapshot')
  const backupExists = await store.head(m2.previousSnapshot!)
  assert(backupExists !== null, 'previousSnapshot object actually exists in the bucket')
  console.log(
    `  compacted at commitSeq=${m2.commitSeq}: snapshot=${m2.snapshot.split('/').pop()} ` +
      `backup=${m2.previousSnapshot?.split('/').pop()} segments=${m2.walSegments.length} ` +
      `(last write mode=${r1.commit?.mode})`,
  )
  // And the next plain write goes back to incremental shipping.
  const r2 = await db.query('INSERT INTO kv VALUES (100001, $1)', ['back-to-incremental'])
  assert(r2.commit?.mode === 'incremental', `post-compaction write ships a segment (got ${r2.commit?.mode})`)
  const sumPre = await tableChecksum(db)
  await db.close()
  db = await ZeroPG.open({ store, holder: 'w-postcompact', commitIntervalMs: 450 })
  assert((await tableChecksum(db)) === sumPre, 'reopen after compaction is byte-identical')
  logResult('e2c.jsonl', { probe: 'compaction', commitSeq: m2.commitSeq })

  // ---------------------------------------------------------------- 4
  section('WAL-file-switch boundary: commits straddling a 16MB segment switch')
  // 4 x 5MB incompressible commits: the shipped LSN ranges cross a pg_wal
  // file boundary mid-stream (and the last ones trip compaction — both paths
  // must restore byte-identically).
  for (let i = 0; i < 4; i++) {
    await db.raw.query('INSERT INTO blob (v) VALUES ($1)', [randomBytes(5 * 1024 * 1024)])
    db.markDirty()
    await db.flush()
  }
  const sumSwitch = await tableChecksum(db)
  const blobCount = (await db.query<{ n: string }>('SELECT count(*)::text n FROM blob')).rows[0].n
  await db.close()
  db = await ZeroPG.open({ store, holder: 'w-switch', commitIntervalMs: 450 })
  assert((await tableChecksum(db)) === sumSwitch, 'kv intact across WAL-file switches')
  assert(
    (await db.query<{ n: string }>('SELECT count(*)::text n FROM blob')).rows[0].n === blobCount,
    `blob rows intact across WAL-file switches (${blobCount})`,
  )
  await db.close()

  // ---------------------------------------------------------------- 5
  section('Group commit: 10 concurrent strict writes under default pacing')
  // Default commitIntervalMs derives from the GCS cost model (1/s per object
  // name). Concurrent writes must coalesce into few manifest CASes instead of
  // racing the rate limit. (The sequential phases above run with pacing off
  // and lean on the driver's 429 retry — both layers get exercised.)
  db = await ZeroPG.open({ store, holder: 'w-group' })
  const before = (await currentManifest()).commitSeq
  const t0 = performance.now()
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => db.query('INSERT INTO kv VALUES ($1, $2)', [200000 + i, 'grp'])),
  )
  const groupMs = performance.now() - t0
  const after = (await currentManifest()).commitSeq
  const casCount = after - before
  console.log(`  10 concurrent writes -> ${casCount} manifest CAS(es) in ${round(groupMs)}ms`)
  assert(casCount <= 3, `concurrent writes coalesce (${casCount} commits for 10 writes)`)
  const grpRows = await db.query<{ n: string }>("SELECT count(*)::text n FROM kv WHERE v = 'grp'")
  assert(grpRows.rows[0].n === '10', `all 10 group-committed rows durable (got ${grpRows.rows[0].n})`)
  await db.close()
  logResult('e2c.jsonl', { probe: 'group-commit', casCount, groupMs: round(groupMs) })

  // ---------------------------------------------------------------- cleanup
  section('Cleanup')
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects under ${prefix}`)

  section(failureCount() === 0 ? '✅ E2c PASSED' : `❌ E2c: ${failureCount()} FAILURES`)
  process.exitCode = failureCount() === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
