// E7: does pg-gateway preserve transaction isolation?
//
// This gates the whole wire swap. PostgREST enforces RLS with a per-request
//   BEGIN; SET LOCAL ROLE ...; SELECT set_config('request.jwt.claims', ..., true); <query>; COMMIT
// on a shared backend. If another connection's statements can land inside that
// transaction, the SET LOCAL role and claims of one user apply to another user's
// query. That is a cross-user data leak, not a performance nit.
//
// Both server shapes below put the SAME pg-gateway handshake in front of the SAME
// single PGlite. The only difference is serialization:
//   naive    - db.runExclusive(execProtocolRaw) per message (the existing spike)
//   affinity - the QueryQueueManager ported from pglite-socket 0.2.2
//
// Run: npx tsx experiments/pg-gateway/e7-tx-isolation.ts

import { PGlite } from '@electric-sql/pglite'
import { Client } from 'pg'
import { serve, type Serialization, type Gateway } from './lib/gateway.ts'

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const fail = (m: string): void => {
  console.log(`  FAIL ${m}`)
  failures++
}
const section = (m: string): void => console.log(`\n=== ${m} ===`)

async function withGateway<T>(
  serialization: Serialization,
  fn: (gw: Gateway) => Promise<T>,
): Promise<T> {
  const db = await PGlite.create()
  const gw = await serve({ serialization, db })
  try {
    return await fn(gw)
  } finally {
    await gw.stop()
    await db.close()
  }
}

function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: `${url}?sslmode=disable` })
  // Test 3 deliberately RSTs a connection; without this, node-postgres rethrows
  // 'Connection terminated unexpectedly' as an unhandled 'error' event.
  c.on('error', () => {})
  return c.connect().then(() => c)
}

// ---------------------------------------------------------------------------
// TEST 1: the SET LOCAL bleed. This is the exact shape from the prior finding.
//
// Two clients each run, concurrently:
//   BEGIN; SET LOCAL myapp.uid='X'; SELECT pg_sleep(n); SELECT current_setting('myapp.uid'); COMMIT
// Correct behaviour: each sees its own uid. Broken behaviour: one client's COMMIT
// ends the other's transaction, discarding its SET LOCAL, so it reads back empty.
// ---------------------------------------------------------------------------
async function testSetLocalBleed(serialization: Serialization): Promise<void> {
  section(`TEST 1 SET LOCAL isolation [${serialization}]`)
  await withGateway(serialization, async (gw) => {
    const a = await connect(gw.url)
    const b = await connect(gw.url)

    const runTx = async (c: Client, uid: string, sleep: number): Promise<string> => {
      await c.query('BEGIN')
      await c.query(`SET LOCAL myapp.uid = '${uid}'`)
      await c.query(`SELECT pg_sleep(${sleep})`)
      const r = await c.query("SELECT current_setting('myapp.uid', true) AS uid")
      await c.query('COMMIT')
      return r.rows[0].uid ?? '<null>'
    }

    // A starts first and sleeps longer, so B's whole transaction lands inside
    // A's if nothing serializes them.
    const [sawA, sawB] = await Promise.all([
      runTx(a, 'AAA', 0.6).catch((e: Error) => `<error: ${e.message}>`),
      (async () => {
        await new Promise((r) => setTimeout(r, 100))
        return runTx(b, 'BBB', 0.1).catch((e: Error) => `<error: ${e.message}>`)
      })(),
    ])

    console.log(`  AAA saw ${sawA || '<empty>'} | BBB saw ${sawB || '<empty>'}`)
    if (sawA === 'AAA' && sawB === 'BBB') ok('each transaction kept its own SET LOCAL')
    else fail(`SET LOCAL bled across connections: AAA saw "${sawA}", BBB saw "${sawB}"`)

    await a.end().catch(() => {})
    await b.end().catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// TEST 2: the PostgREST/RLS shape end to end, with real roles and real RLS.
// A slow authenticated read as user A held open while N reads as user B fire.
// ---------------------------------------------------------------------------
const RLS_SQL = `
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public TO authenticated;
CREATE TABLE items (id serial PRIMARY KEY, owner text NOT NULL, body text NOT NULL);
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON items USING (owner = current_setting('request.uid', true));
GRANT SELECT ON items TO authenticated;
INSERT INTO items (owner, body) VALUES ('A','A-secret-1'),('A','A-secret-2'),('B','B-secret-1');
`

async function testRlsBleed(serialization: Serialization): Promise<void> {
  section(`TEST 2 RLS cross-user bleed [${serialization}]`)
  const db = await PGlite.create()
  await db.exec(RLS_SQL)
  const gw = await serve({ serialization, db })
  try {
    const a = await connect(gw.url)
    const b = await connect(gw.url)

    // One PostgREST-style request: BEGIN, assume role + claims LOCALly, read, COMMIT.
    const request = async (c: Client, uid: string, sleep: number): Promise<string[]> => {
      await c.query('BEGIN')
      await c.query('SET LOCAL ROLE authenticated')
      await c.query(`SELECT set_config('request.uid', '${uid}', true)`)
      if (sleep > 0) await c.query(`SELECT pg_sleep(${sleep})`)
      const r = await c.query('SELECT body FROM items ORDER BY body')
      await c.query('COMMIT')
      return r.rows.map((x: { body: string }) => x.body)
    }

    const slowA = request(a, 'A', 0.6).catch((e: Error) => [`<error: ${e.message}>`])
    await new Promise((r) => setTimeout(r, 100))
    const N = 20
    const bReads: string[][] = []
    for (let i = 0; i < N; i++) {
      bReads.push(await request(b, 'B', 0).catch((e: Error) => [`<error: ${e.message}>`]))
    }
    const aRows = await slowA

    console.log(`  A saw [${aRows.join(', ')}]`)
    console.log(`  B saw [${bReads[0].join(', ')}] (first of ${N})`)

    if (aRows.length === 2 && aRows.every((r) => r.startsWith('A-'))) {
      ok("A's slow request saw exactly its own 2 rows")
    } else {
      fail(`A's request was contaminated: [${aRows.join(', ')}]`)
    }

    const bleed = bReads.filter((rows) => rows.some((r) => r.startsWith('A-'))).length
    const wrong = bReads.filter(
      (rows) => !(rows.length === 1 && rows[0] === 'B-secret-1'),
    ).length
    if (bleed === 0) ok(`zero cross-user bleed across ${N} B-reads during A's open transaction`)
    else fail(`CROSS-USER BLEED: ${bleed}/${N} B-reads saw user A's rows`)
    if (wrong === 0) ok(`all ${N} B-reads returned exactly B's row`)
    else fail(`${wrong}/${N} B-reads returned the wrong row set`)

    await a.end().catch(() => {})
    await b.end().catch(() => {})
  } finally {
    await gw.stop()
    await db.close()
  }
}

// ---------------------------------------------------------------------------
// TEST 3: abrupt disconnect mid-transaction. PGlite swallows Terminate, so a
// client can BEGIN, SET ROLE, then RST. If the transaction is never rolled back,
// the NEXT connection inherits an open transaction with someone else's role.
// ---------------------------------------------------------------------------
async function testAbruptDisconnect(serialization: Serialization): Promise<void> {
  section(`TEST 3 abrupt disconnect mid-transaction [${serialization}]`)
  const db = await PGlite.create()
  await db.exec(RLS_SQL)
  const gw = await serve({ serialization, db })
  try {
    const a = await connect(gw.url)
    await a.query('BEGIN')
    await a.query('SET LOCAL ROLE authenticated')
    await a.query("SELECT set_config('request.uid', 'A', true)")
    // hard RST, no COMMIT, no Terminate handshake
    ;(a as unknown as { connection: { stream: { destroy: () => void } } }).connection.stream.destroy()
    await new Promise((r) => setTimeout(r, 300))

    console.log(`  after RST: db.isInTransaction() = ${db.isInTransaction()}`)

    const b = await connect(gw.url)
    const who = await b.query(
      "SELECT current_user AS u, current_setting('request.uid', true) AS uid",
    ).catch((e: Error) => ({ rows: [{ u: `<error: ${e.message}>`, uid: null }] }))
    console.log(`  new connection sees: current_user=${who.rows[0].u} request.uid=${who.rows[0].uid ?? '<null>'}`)

    if (who.rows[0].u === 'postgres') ok('new connection is NOT stuck in the dead transaction role')
    else fail(`new connection inherited role ${who.rows[0].u} from the abandoned transaction`)

    if (!db.isInTransaction()) ok('abandoned transaction was rolled back')
    else fail('abandoned transaction is STILL OPEN after the client vanished')

    await b.end().catch(() => {})
  } finally {
    await gw.stop()
    await db.close()
  }
}

// ---------------------------------------------------------------------------
// TEST 4: a transaction left in the failed Z(E) state must not leak either, and
// must not wedge the queue.
// ---------------------------------------------------------------------------
async function testFailedTxState(serialization: Serialization): Promise<void> {
  section(`TEST 4 failed-transaction (Z(E)) state [${serialization}]`)
  await withGateway(serialization, async (gw) => {
    const a = await connect(gw.url)
    const b = await connect(gw.url)

    await a.query('BEGIN')
    await a.query("SET LOCAL myapp.uid = 'AAA'")
    await a.query('SELECT 1/0').catch(() => {}) // puts A in the failed state
    // A now sits in Z(E). B must still be able to work once A finishes.
    const bPromise = b
      .query('SELECT 42 AS n')
      .then((r: { rows: { n: number }[] }) => String(r.rows[0].n))
      .catch((e: Error) => `<error: ${e.message}>`)

    await new Promise((r) => setTimeout(r, 200))
    await a.query('ROLLBACK')
    const bResult = await Promise.race([
      bPromise,
      new Promise<string>((r) => setTimeout(() => r('<timeout>'), 3000)),
    ])
    console.log(`  B's concurrent query returned: ${bResult}`)
    if (bResult === '42') ok('B completed after A rolled back its failed transaction')
    else fail(`B did not complete cleanly: ${bResult}`)

    const after = await a.query("SELECT current_setting('myapp.uid', true) AS uid")
    if (!after.rows[0].uid) ok("A's SET LOCAL was discarded by the ROLLBACK")
    else fail(`SET LOCAL survived the rollback: ${after.rows[0].uid}`)

    await a.end().catch(() => {})
    await b.end().catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// TEST 5: extended-protocol concurrency. node-postgres sends parameterized
// queries as Parse/Bind/Describe/Execute/Sync. A transaction spans many messages,
// so the affinity rule has to hold at message granularity, not statement.
// ---------------------------------------------------------------------------
async function testExtendedProtocol(serialization: Serialization): Promise<void> {
  section(`TEST 5 extended-protocol concurrency [${serialization}]`)
  const db = await PGlite.create()
  await db.exec(RLS_SQL)
  const gw = await serve({ serialization, db })
  try {
    const a = await connect(gw.url)
    const b = await connect(gw.url)

    const txParam = async (c: Client, uid: string, sleep: number): Promise<string> => {
      await c.query('BEGIN')
      await c.query('SELECT set_config($1, $2, true)', ['request.uid', uid])
      if (sleep > 0) await c.query('SELECT pg_sleep($1)', [sleep])
      const r = await c.query('SELECT current_setting($1, true) AS uid', ['request.uid'])
      await c.query('COMMIT')
      return r.rows[0].uid ?? '<null>'
    }

    const [sawA, sawB] = await Promise.all([
      txParam(a, 'AAA', 0.6).catch((e: Error) => `<error: ${e.message}>`),
      (async () => {
        await new Promise((r) => setTimeout(r, 100))
        return txParam(b, 'BBB', 0).catch((e: Error) => `<error: ${e.message}>`)
      })(),
    ])
    console.log(`  AAA saw ${sawA || '<empty>'} | BBB saw ${sawB || '<empty>'}`)
    if (sawA === 'AAA' && sawB === 'BBB') ok('extended protocol kept per-connection state')
    else fail(`extended-protocol bleed: AAA saw "${sawA}", BBB saw "${sawB}"`)

    await a.end().catch(() => {})
    await b.end().catch(() => {})
  } finally {
    await gw.stop()
    await db.close()
  }
}

async function main(): Promise<void> {
  for (const mode of ['naive', 'affinity'] as Serialization[]) {
    console.log(`\n${'#'.repeat(70)}\n# SERIALIZATION: ${mode}\n${'#'.repeat(70)}`)
    const before = failures
    await testSetLocalBleed(mode)
    await testRlsBleed(mode)
    await testAbruptDisconnect(mode)
    await testFailedTxState(mode)
    await testExtendedProtocol(mode)
    console.log(`\n  [${mode}] ${failures - before} failure(s)`)
  }
  console.log(`\n${'='.repeat(70)}`)
  console.log(`E7 total failures across BOTH modes: ${failures}`)
  console.log('(naive is EXPECTED to fail; affinity is expected to pass)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
