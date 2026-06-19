// Run: tsx packages/client/test/client.test.ts
// Assertion-style smoke test (matches the experiments/ convention). Exits non-zero
// on the first failure so it gates "done". Covers the engines that run offline:
// memory://, file:// (round-trip + lock semantics), and the HMR instance pin.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'
import { acquireDatadirLock, LockTimeoutError } from '../src/lockfile.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

async function testMemory(): Promise<void> {
  console.log('memory://')
  const db = await connect('memory://')
  eq(db.engine, 'memory', 'engine is memory')
  await db.exec('create table t (id int primary key, name text)')
  const ins = await db.query('insert into t values (1, $1), (2, $2)', ['a', 'b'])
  eq(ins.rowCount, 2, 'insert rowCount = affected rows')
  const sel = await db.query<{ id: number; name: string }>('select * from t order by id')
  eq(sel.rows, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], 'select rows round-trip')
  eq(sel.rowCount, 2, 'select rowCount = row count')
  eq(sel.fields.map((f) => f.name), ['id', 'name'], 'select fields carry column names')
  ok(sel.fields.every((f) => typeof f.dataTypeID === 'number'), 'fields carry type OIDs')

  const tx = await db.transaction(async (t) => {
    await t.exec('insert into t values (3, \'c\')')
    const r = await t.query<{ c: string }>('select count(*)::int as c from t')
    return r.rows[0].c
  })
  eq(tx, 3, 'transaction commits and sees its own write')
  await db.ensureReady() // no-op, must not throw
  await db.end()
}

async function testFileRoundTrip(): Promise<void> {
  console.log('file:// round-trip + durability across reopen')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-client-'))
  const dataDir = join(dir, 'dev.db')

  const db1 = await connect(`file://${dataDir}`, { noHmrPin: true })
  eq(db1.engine, 'file', 'engine is file')
  await db1.exec('create table k (v text)')
  await db1.query('insert into k values ($1)', ['persisted'])
  await db1.end()

  const db2 = await connect(`file://${dataDir}`, { noHmrPin: true })
  const r = await db2.query<{ v: string }>('select v from k')
  eq(r.rows, [{ v: 'persisted' }], 'data survives close + reopen on disk')
  await db2.end()
}

async function testLockReleasedOnEnd(): Promise<void> {
  console.log('file:// lock is released on end() so the next open succeeds')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-client-'))
  const dataDir = join(dir, 'dev.db')
  const db1 = await connect(`file://${dataDir}`, { noHmrPin: true })
  await db1.end()
  // Lock file must be gone after a clean end().
  let lockExists = true
  try {
    await readFile(`${dataDir}.lock`, 'utf8')
  } catch {
    lockExists = false
  }
  ok(!lockExists, 'lock file removed on end()')
  const db2 = await connect(`file://${dataDir}`, { noHmrPin: true })
  await db2.end()
  ok(true, 'second open after end() succeeds')
}

async function testLockRejectsLiveHolder(): Promise<void> {
  console.log('lock: a LIVE holder is waited out then rejected (LockTimeoutError)')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-lock-'))
  const dataDir = join(dir, 'db')
  const held = await acquireDatadirLock(dataDir, { acquireTimeoutMs: 50 })
  let threw: unknown = null
  try {
    // Same live process holds it -> defaultIsAlive(self) is true -> must time out.
    await acquireDatadirLock(dataDir, { acquireTimeoutMs: 50, pollIntervalMs: 5 })
  } catch (e) {
    threw = e
  }
  ok(threw instanceof LockTimeoutError, 'second acquire of a live-held lock throws LockTimeoutError')
  await held.release()
  // Now free.
  const after = await acquireDatadirLock(dataDir, { acquireTimeoutMs: 50 })
  ok(after, 'acquire succeeds once the live holder releases')
  await after.release()
}

async function testLockReclaimsDeadHolder(): Promise<void> {
  console.log('lock: a DEAD holder is reclaimed immediately (no wait)')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-lock-'))
  const dataDir = join(dir, 'db')
  const lockPath = `${dataDir}.lock`
  // Forge a stale lock owned by a PID that is (almost certainly) dead, on this host.
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 2147480000, host: hostname(), acquiredAt: new Date(0).toISOString() }),
  )
  const t0 = Date.now()
  const lock = await acquireDatadirLock(dataDir, { acquireTimeoutMs: 5_000, pollIntervalMs: 100 })
  const waited = Date.now() - t0
  ok(waited < 1_000, `reclaim was immediate, not a wait-out (took ${waited}ms)`)
  // The lock file now records THIS process.
  const rec = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }
  eq(rec.pid, process.pid, 'reclaimed lock records the new owner pid')
  await lock.release()
}

async function testHmrPin(): Promise<void> {
  console.log('file:// HMR pin: two same-process opens share ONE instance + lock')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-hmr-'))
  const dataDir = join(dir, 'dev.db')
  const a = await connect(`file://${dataDir}`) // pinned
  await a.exec('create table h (n int)')
  await a.query('insert into h values (1)')
  // Second open while the first is live would EEXIST-fail the lock WITHOUT the
  // pin; with the pin it reuses the same instance and sees the same data.
  const b = await connect(`file://${dataDir}`)
  const r = await b.query<{ n: number }>('select n from h')
  eq(r.rows, [{ n: 1 }], 'second same-process open reuses the live instance')
  // Ending the reused handle must NOT tear down the shared instance/lock...
  await b.end()
  const stillThere = await a.query<{ n: number }>('select n from h')
  eq(stillThere.rows, [{ n: 1 }], 'reused-handle end() does not close the pinned instance')
  await a.end() // owner end: closes + releases + clears pin
}

async function main(): Promise<void> {
  await testMemory()
  await testFileRoundTrip()
  await testLockReleasedOnEnd()
  await testLockRejectsLiveHolder()
  await testLockReclaimsDeadHolder()
  await testHmrPin()
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
