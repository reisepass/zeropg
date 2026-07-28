// Prepared-statement namespacing on pg-gateway, and whether it actually unblocks
// the drivers it is supposed to.
//
// Claim: many wire connections share ONE PGlite session, prepared statements are
// session-scoped, so connection B preparing `s1` collides with connection A's and
// fails 42P05. A per-connection name rewriter on Parse/Bind/Describe/Close/Execute
// fixes it. This rebuilds that, confirms it, then goes looking for the edges.
//
// The edges tested here, because they decide whether this is a real fix or a
// demo: SQL-level PREPARE/DEALLOCATE bypass the rewriter, pg_prepared_statements
// exposes the prefixed name, and error text leaks it. Plus the question that
// actually matters for sqlx: even with names fixed, do advisory locks work?
//
// Run: npx tsx experiments/pg-gateway/e-prepared-stmts.ts

import { connect as netConnect } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { Client } from 'pg'
import { serve, type Gateway } from './lib/gateway.ts'
import { rewriteOutgoing, rewriteIncoming } from './lib/stmt-rewriter.ts'

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const fail = (m: string): void => {
  console.log(`  FAIL ${m}`)
  failures++
}
const note = (m: string): void => console.log(`  NOTE ${m}`)
const section = (m: string): void => console.log(`\n=== ${m} ===`)

async function connect(gw: Gateway): Promise<Client> {
  const c = new Client({ connectionString: `${gw.url}?sslmode=disable` })
  c.on('error', () => {})
  await c.connect()
  return c
}

// node-postgres sends a NAMED prepared statement when `name` is set on the query.
function prepared(c: Client, name: string, text: string, values: unknown[] = []) {
  return c.query({ name, text, values })
}

// Raw wire client: Describe('S', name) for a statement that was never prepared.
// Needed because node-postgres will not emit a bare Describe, and its own
// client-side duplicate-name check would mask the server's ErrorResponse.
function describeUnknownStatement(gw: Gateway, name: string): Promise<string> {
  return new Promise((resolve) => {
    const enc = new TextEncoder()
    const sock = netConnect(gw.port, '127.0.0.1', () => {
      // StartupMessage: int32 len, int32 196608, then key/value cstrings, then 0
      const params = enc.encode('user\0postgres\0database\0postgres\0\0')
      const startup = Buffer.alloc(8 + params.length)
      startup.writeInt32BE(startup.length, 0)
      startup.writeInt32BE(196608, 4)
      Buffer.from(params).copy(startup, 8)
      sock.write(startup)
    })
    let phase: 'startup' | 'described' = 'startup'
    let out = ''
    sock.on('data', (buf: Buffer) => {
      const text = buf.toString('latin1')
      if (phase === 'startup' && text.includes('Z')) {
        phase = 'described'
        // Describe 'D', len, 'S', cstring name  +  Sync 'S', len
        const n = enc.encode(`${name}\0`)
        const d = Buffer.alloc(6 + n.length)
        d.write('D', 0, 'latin1')
        d.writeInt32BE(4 + 1 + n.length, 1)
        d.write('S', 5, 'latin1')
        Buffer.from(n).copy(d, 6)
        const sync = Buffer.alloc(5)
        sync.write('S', 0, 'latin1')
        sync.writeInt32BE(4, 1)
        sock.write(Buffer.concat([d, sync]))
        return
      }
      if (phase === 'described') {
        // pull the readable text out of the ErrorResponse
        const m = text.match(/prepared statement "[^"]*" does not exist/)
        out = m ? m[0] : text.replace(/[^\x20-\x7e]+/g, ' ').trim()
        sock.destroy()
        resolve(out)
      }
    })
    sock.on('error', () => resolve(out || '<socket error>'))
    setTimeout(() => {
      sock.destroy()
      resolve(out || '<timeout>')
    }, 5000)
  })
}

async function withGw(
  rewrite: boolean,
  fn: (gw: Gateway, db: PGlite) => Promise<void>,
): Promise<void> {
  const db = await PGlite.create()
  const gw = await serve({
    serialization: 'affinity',
    db,
    onRaw: rewrite ? (data, connId) => rewriteOutgoing(data, `c${connId}_`) : undefined,
    onOut: rewrite ? (data, connId) => rewriteIncoming(data, `c${connId}_`) : undefined,
  })
  try {
    await fn(gw, db)
  } finally {
    await gw.stop()
    await db.close()
  }
}

// ---------------------------------------------------------------------------
async function testCollision(rewrite: boolean): Promise<void> {
  section(`named prepared statement collision [rewriter ${rewrite ? 'ON' : 'OFF'}]`)
  await withGw(rewrite, async (gw) => {
    const a = await connect(gw)
    const b = await connect(gw)

    const ra = await prepared(a, 's1', 'SELECT 1 AS n')
      .then((r: { rows: { n: number }[] }) => `rows=${r.rows[0].n}`)
      .catch((e: Error & { code?: string }) => `ERROR ${e.code} ${e.message}`)
    console.log(`  A prepares s1: ${ra}`)

    const rb = await prepared(b, 's1', 'SELECT 2 AS n')
      .then((r: { rows: { n: number }[] }) => `rows=${r.rows[0].n}`)
      .catch((e: Error & { code?: string }) => `ERROR ${e.code} ${e.message}`)
    console.log(`  B prepares s1: ${rb}`)

    // A's must still resolve to ITS query, not B's.
    const ra2 = await prepared(a, 's1', 'SELECT 1 AS n')
      .then((r: { rows: { n: number }[] }) => String(r.rows[0].n))
      .catch((e: Error & { code?: string }) => `ERROR ${e.code}`)
    console.log(`  A re-executes s1: ${ra2}`)

    if (rewrite) {
      if (ra.startsWith('rows=1') && rb.startsWith('rows=2') && ra2 === '1') {
        ok('both connections prepared s1 and each resolved to its own query')
      } else {
        fail(`rewriter did not isolate: A=${ra} B=${rb} A2=${ra2}`)
      }
    } else {
      if (rb.includes('42P05')) {
        ok(`collision reproduced without the rewriter: ${rb.slice(0, 70)}`)
      } else {
        fail(`expected 42P05 without the rewriter, got: ${rb}`)
      }
    }

    await a.end().catch(() => {})
    await b.end().catch(() => {})
  })
}

// ---------------------------------------------------------------------------
async function testEdges(): Promise<void> {
  section('the edges: where the rewriter does NOT reach')
  await withGw(true, async (gw) => {
    const a = await connect(gw)
    const b = await connect(gw)

    // EDGE 1: SQL-level PREPARE bypasses the rewriter entirely. It is a Query
    // ('Q') carrying SQL text, not a Parse message with a name field.
    await a.query("PREPARE p1 AS SELECT 1").catch(() => {})
    const sqlLevel = await b
      .query('PREPARE p1 AS SELECT 2')
      .then(() => 'no error')
      .catch((e: Error & { code?: string }) => `${e.code} ${e.message}`)
    console.log(`  B: SQL-level PREPARE p1 -> ${sqlLevel}`)
    if (sqlLevel.startsWith('42P05')) {
      note('CONFIRMED: SQL-level PREPARE bypasses the rewriter and still collides (42P05)')
    } else {
      note(`SQL-level PREPARE behaved unexpectedly: ${sqlLevel}`)
    }

    // EDGE 2: DEALLOCATE of a protocol-prepared name fails, because the backend
    // name is prefixed and the client asks for the unprefixed one.
    await prepared(a, 'd1', 'SELECT 9').catch(() => {})
    const dealloc = await a
      .query('DEALLOCATE d1')
      .then(() => 'no error')
      .catch((e: Error & { code?: string }) => `${e.code} ${e.message}`)
    console.log(`  A: DEALLOCATE d1 (prepared via protocol) -> ${dealloc}`)
    if (dealloc.startsWith('26000')) {
      note('CONFIRMED: DEALLOCATE cannot see protocol-prepared names (26000)')
    } else {
      note(`DEALLOCATE result: ${dealloc}`)
    }

    // EDGE 3: pg_prepared_statements shows the prefixed name AND every other
    // connection's statements, because it is all one session.
    const listed = await a.query('SELECT name FROM pg_prepared_statements ORDER BY name')
    const names = listed.rows.map((r: { name: string }) => r.name)
    console.log(`  pg_prepared_statements as seen by A: [${names.join(', ')}]`)
    if (names.some((n) => /^c\d+_/.test(n))) {
      note('CONFIRMED: pg_prepared_statements leaks the internal prefixed name')
    }
    if (names.some((n) => /^c2_/.test(n)) && names.some((n) => /^c1_/.test(n))) {
      note("CONFIRMED: connection A can see connection B's prepared statements (one session)")
    }

    // EDGE 4: does the un-prefixing of a real server ErrorResponse work?
    //
    // Care needed here: node-postgres raises its OWN client-side error
    // ("Prepared statements must be unique") for a same-name reprepare, which
    // never touches the server and would falsely pass this test. To get a genuine
    // backend ErrorResponse carrying the rewritten name, Describe a statement
    // that was never prepared - the server then says
    // `prepared statement "c4_ghost" does not exist`.
    const raw = await describeUnknownStatement(gw, 'ghost')
    console.log(`  raw server ErrorResponse for an unknown statement: ${raw}`)
    if (/c\d+_ghost/.test(raw)) {
      fail('ErrorResponse leaks the internal prefix to the client')
    } else if (/ghost/.test(raw)) {
      ok('server ErrorResponse was un-prefixed before reaching the client')
    } else {
      fail(`could not provoke the expected error, got: ${raw}`)
    }

    await a.end().catch(() => {})
    await b.end().catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// The question that decides whether this unblocks sqlx at all.
// ---------------------------------------------------------------------------
async function testAdvisoryLocks(): Promise<void> {
  section('does it unblock sqlx? advisory locks on a shared session')
  await withGw(true, async (gw) => {
    const conns = await Promise.all([connect(gw), connect(gw), connect(gw)])
    const results: boolean[] = []
    for (const c of conns) {
      const r = await c.query('SELECT pg_try_advisory_lock(42) AS got')
      results.push(r.rows[0].got)
    }
    console.log(`  pg_try_advisory_lock(42) from 3 separate connections: [${results.join(', ')}]`)

    const locks = await conns[0].query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'",
    )
    console.log(`  rows in pg_locks where locktype='advisory': ${locks.rows[0].n}`)

    const granted = results.filter(Boolean).length
    if (granted === 1) {
      ok('exactly one connection got the lock - migration tools would serialize correctly')
    } else {
      fail(
        `ALL ${granted}/3 connections got the same exclusive advisory lock. ` +
          'Migration tools that serialize on advisory locks will race.',
      )
      note('This is NOT fixed by statement namespacing. It is the one-session problem itself.')
    }

    for (const c of conns) await c.end().catch(() => {})
  })
}

// ---------------------------------------------------------------------------
// Concurrency: the rewriter must not corrupt frames under interleaving, and must
// survive split TCP segments.
// ---------------------------------------------------------------------------
async function testConcurrentPrepared(): Promise<void> {
  section('many connections, same statement names, concurrent')
  await withGw(true, async (gw) => {
    const N = 8
    const conns = await Promise.all(Array.from({ length: N }, () => connect(gw)))
    const results = await Promise.all(
      conns.map(async (c, i) => {
        try {
          for (let round = 0; round < 5; round++) {
            const r = await prepared(c, 'shared', 'SELECT $1::int AS n', [i])
            if (r.rows[0].n !== i) return `conn${i}: wrong value ${r.rows[0].n}`
          }
          return 'ok'
        } catch (e) {
          return `conn${i}: ${(e as Error & { code?: string }).code} ${(e as Error).message}`
        }
      }),
    )
    const bad = results.filter((r) => r !== 'ok')
    console.log(`  ${N} connections x 5 rounds of prepared "shared": ${bad.length} failure(s)`)
    for (const b of bad.slice(0, 3)) console.log(`    ${b}`)
    if (bad.length === 0) ok(`all ${N} connections used the name "shared" concurrently and got their own values`)
    else fail(`${bad.length}/${N} connections failed under concurrency`)

    for (const c of conns) await c.end().catch(() => {})
  })
}

async function main(): Promise<void> {
  await testCollision(false)
  await testCollision(true)
  await testEdges()
  await testConcurrentPrepared()
  await testAdvisoryLocks()
  console.log(`\n${'='.repeat(64)}\nfailures: ${failures}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
