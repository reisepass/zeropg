// E2d: read replicas from the bucket. A writer commits; a leaseless follower
// polls the manifest and must converge — across incremental segments AND a
// compaction — while rejecting writes and never touching the bucket.
//
//   tsx experiments/e2d-replica.ts

import { randomBytes } from 'node:crypto'
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, ZeroPGReplica } from '@zeropg/objectstore-fs'
import { BUCKET, runId, logResult, section, assert, failureCount, resetFailures, round } from './_util.js'

const prefix = `e2d/${runId()}`
const store = new GcsBlobStore({ bucket: BUCKET, prefix })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  resetFailures()
  const seed = await ZeroPG.buildEmptySnapshot()

  section('Writer up, first commits')
  const writer = await ZeroPG.open({ store, holder: 'writer', seedSnapshot: seed, commitIntervalMs: 450 })
  await writer.exec('CREATE TABLE kv (id int primary key, v text)')
  await writer.exec("INSERT INTO kv VALUES (1, 'one'), (2, 'two')")

  section('Replica opens read-only from the bucket')
  const replica = await ZeroPGReplica.open({ store, pollIntervalMs: 0 }) // manual refresh for determinism
  const r0 = await replica.query<{ n: string }>('SELECT count(*)::text n FROM kv')
  assert(r0.rows[0].n === '2', `replica sees initial rows (got ${r0.rows[0].n})`)
  console.log(`  replica restored in ${round(replica.lastRestoreMs)}ms at commitSeq=${replica.commitSeq}`)

  // Writes must be rejected by the read-only session default.
  let rejected = false
  try {
    await replica.raw.query("INSERT INTO kv VALUES (99, 'nope')")
  } catch {
    rejected = true
  }
  assert(rejected, 'replica rejects writes (default_transaction_read_only)')

  section('Convergence across incremental commits')
  await writer.exec("INSERT INTO kv VALUES (3, 'three')")
  assert((await replica.refresh()) === true, 'refresh detects the new commit')
  const r1 = await replica.query<{ n: string }>('SELECT count(*)::text n FROM kv')
  assert(r1.rows[0].n === '3', `replica converged to 3 rows (got ${r1.rows[0].n})`)
  assert((await replica.refresh()) === false, 'no-op refresh when nothing changed')

  section('Convergence across a compaction')
  // Burst past the 16MB threshold so the writer compacts, then verify the
  // replica follows the snapshot swap.
  await writer.exec('CREATE TABLE blob (id serial primary key, v bytea)')
  for (let i = 0; i < 18; i++) {
    await writer.raw.query('INSERT INTO blob (v) VALUES ($1)', [randomBytes(1024 * 1024)])
  }
  writer.markDirty()
  await writer.flush()
  await writer.exec("INSERT INTO kv VALUES (4, 'post-compaction')") // triggers compact
  await replica.refresh()
  const r2 = await replica.query<{ kv: string; blob: string }>(
    'SELECT (SELECT count(*) FROM kv)::text kv, (SELECT count(*) FROM blob)::text blob',
  )
  assert(r2.rows[0].kv === '4' && r2.rows[0].blob === '18',
    `replica converged across compaction (kv=${r2.rows[0].kv}, blob=${r2.rows[0].blob})`)
  console.log(`  post-compaction restore ${round(replica.lastRestoreMs)}ms at commitSeq=${replica.commitSeq}`)

  section('Auto-polling replica')
  const auto = await ZeroPGReplica.open({ store, pollIntervalMs: 1000 })
  await writer.exec("INSERT INTO kv VALUES (5, 'for-the-poller')")
  let converged = false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const r = await auto.query<{ n: string }>('SELECT count(*)::text n FROM kv')
    if (r.rows[0].n === '5') {
      converged = true
      break
    }
    await sleep(500)
  }
  assert(converged, 'auto-polling replica converges without manual refresh')
  await auto.close()

  // The replica must never have touched the lease.
  const lease = await store.head('lease.json')
  section('Cleanup')
  await replica.close()
  await writer.close()
  assert(lease !== null, 'writer lease untouched by replicas (still present pre-close)')

  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects under ${prefix}`)
  logResult('e2d.jsonl', { probe: 'replica', pass: failureCount() === 0 })
  section(failureCount() === 0 ? '✅ E2d PASSED' : `❌ E2d: ${failureCount()} FAILURES`)
  process.exit(failureCount() === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
