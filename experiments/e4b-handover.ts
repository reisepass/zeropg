// E4b: writer-handover races, locally against real GCS (regression for E4 P2).
// S1: old writer flushes pending + releases cleanly while the successor is
//     mid-acquire-wait — successor must adopt the POST-flush manifest.
// S2: takeover with the old writer still alive — fence-stamp + zombie fenced.
//
//   tsx experiments/e4b-handover.ts
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, FencedError } from '@zeropg/objectstore-fs'

const seed = await ZeroPG.buildEmptySnapshot()

// --- Scenario 1: clean release during B's lease wait (the E4 P2 shape) ---
{
  const prefix = `_test/handover1-${Date.now()}`
  const store = new GcsBlobStore({ bucket: 'zeropg-experiments-euw1', prefix })
  const A = await ZeroPG.open({ store, holder: 'A', seedSnapshot: seed, durability: 'sleep', leaseTtlMs: 8000, commitIntervalMs: 0 })
  await A.exec('CREATE TABLE notes (id serial primary key, v text)')
  await A.exec("INSERT INTO notes (v) VALUES ('durable-1')"); await A.flush()
  await A.exec("INSERT INTO notes (v) VALUES ('durable-2')"); await A.flush()
  await A.exec("INSERT INTO notes (v) VALUES ('pending-3')") // memory only

  // B boots NOW: reads manifest (2 notes), then blocks on A's live lease.
  const bPromise = ZeroPG.open({ store, holder: 'B', acquireTimeoutMs: 30000, commitIntervalMs: 0 })
  await new Promise(r => setTimeout(r, 1500))
  // A flushes pending and closes cleanly (SIGTERM flush + lease release).
  await A.close()
  const B = await bPromise
  const n = await B.query('SELECT count(*)::int n FROM notes')
  const count = Number((n.rows[0] as {n:unknown}).n)
  console.log(`S1 clean-release handover: B sees ${count} notes (want 3)`)
  if (count !== 3) { console.log('S1 FAIL'); process.exit(1) }
  await B.close()
}

// --- Scenario 2: takeover while zombie stays alive, then zombie fenced ---
{
  const prefix = `_test/handover2-${Date.now()}`
  const store = new GcsBlobStore({ bucket: 'zeropg-experiments-euw1', prefix })
  const A = await ZeroPG.open({ store, holder: 'A', seedSnapshot: seed, durability: 'sleep', leaseTtlMs: 4000, commitIntervalMs: 0 })
  await A.exec('CREATE TABLE notes (id serial primary key, v text)')
  await A.exec("INSERT INTO notes (v) VALUES ('durable-1')"); await A.flush()
  await A.exec("INSERT INTO notes (v) VALUES ('pending-2')")
  const bPromise = ZeroPG.open({ store, holder: 'B', acquireTimeoutMs: 30000, commitIntervalMs: 0 })
  await new Promise(r => setTimeout(r, 1000))
  await A.flush() // idle-flush backstop fires while B waits; A does NOT close
  const B = await bPromise // takes over at TTL expiry, fence-stamps
  const n = await B.query('SELECT count(*)::int n FROM notes')
  console.log(`S2 takeover handover: B sees ${Number((n.rows[0] as {n:unknown}).n)} notes (want 2)`)
  if (Number((n.rows[0] as {n:unknown}).n) !== 2) { console.log('S2 FAIL'); process.exit(1) }
  let fenced = false
  try { await A.exec("INSERT INTO notes (v) VALUES ('zombie')"); await A.flush() } catch (e) { fenced = e instanceof FencedError }
  console.log(`S2 zombie fenced: ${fenced}`)
  if (!fenced) { console.log('S2 FAIL: zombie not fenced'); process.exit(1) }
  await B.close()
}
console.log('HANDOVER TESTS PASS')
process.exit(0)
