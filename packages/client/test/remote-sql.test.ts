// Run: tsx packages/client/test/remote-sql.test.ts
//
// The HTTP /sql surface has to carry what a real app actually sends: bound
// parameters ($1/$2, which every repository layer emits) and multi-statement
// SQL (which is what a migration file is). Both were rejected once:
//
//   params      -> 'bind message supplies 0 parameters, but prepared statement
//                   "" requires 2'   (the handler parsed only `sql` and dropped
//                   `params`), and the client threw a claim that bound params
//                   were impossible over HTTP, suggesting callers inline values.
//                   Inlining is an injection hazard, so that was a hard block.
//   multi-stmt  -> 'cannot insert multiple commands into a prepared statement'
//                   (query() is the extended protocol, single-statement only).
//
// These cases drive a real ZeroPGServer over real HTTP through the unified
// client, so they cover the whole path rather than the handler in isolation.

import { ZeroPGServer } from '@zeropg/server'
import { connect } from '../src/index.js'
// The in-process BlobStore the experiments use: this test is about the HTTP
// surface, not about storage, so it needs a store with no cloud credentials.
import { MemBlobStore } from '../../../experiments/_memstore.js'

const PORT = 8871
const WIRE_PORT = 5671

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`)
}

async function waitReady(base: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const r = (await fetch(`${base}/ready`)
      .then((x) => x.json())
      .catch(() => null)) as { ready?: boolean; phase?: string; error?: string } | null
    if (r?.ready) return
    if (r?.phase === 'error') throw new Error(`server boot error: ${r.error}`)
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error('server never became ready')
}

/** POST /sql directly, for the cases about the raw response shape. */
async function post(base: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/sql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function main(): Promise<void> {
  const srv = await ZeroPGServer.start({
    store: new MemBlobStore(),
    port: PORT,
    wirePort: WIRE_PORT,
    postgrest: false,
  })
  const base = `http://127.0.0.1:${PORT}`
  try {
    await waitReady(base)
    const db = await connect(base)

    // A migration: several statements, one request. exec() routes to the simple
    // protocol, the only path that accepts more than one statement.
    console.log('multi-statement migration over HTTP')
    await db.exec(`
      create table users (id serial primary key, email text unique not null, age int);
      create table posts (id serial primary key, user_id int references users(id), title text);
      create index posts_user on posts(user_id);
    `)
    const tables = await db.query<{ n: string }>(
      "select tablename n from pg_tables where schemaname='public' order by tablename",
    )
    eq(tables.rows.map((r) => r.n), ['posts', 'users'], 'migration created both tables in one request')

    console.log('bound parameters ($1/$2), the shape every repository layer emits')
    const ins = await db.query<{ id: number }>(
      'insert into users (email, age) values ($1, $2) returning id',
      ['a@b.c', 30],
    )
    eq(ins.rows, [{ id: 1 }], 'parameterized INSERT ... RETURNING')

    await db.query('insert into users (email, age) values ($1, $2)', ['d@e.f', 41])
    const sel = await db.query('select email, age from users where age > $1 order by age', [20])
    eq(
      sel.rows,
      [{ email: 'a@b.c', age: 30 }, { email: 'd@e.f', age: 41 }],
      'parameterized SELECT filters server-side',
    )

    const upd = await db.query('update users set age = $1 where age = $2', [31, 30])
    ok(upd.rowCount === 1, `UPDATE reports a real rowCount (got ${upd.rowCount})`)

    // The point of binding: a value containing quotes and a statement separator
    // must arrive as DATA. This is exactly what inlining would have executed.
    console.log('a bound value is data, never SQL')
    const evil = "o'brien@x.com'; drop table users; --"
    await db.query('insert into users (email, age) values ($1, $2)', [evil, 7])
    const back = await db.query<{ email: string }>('select email from users where age = $1', [7])
    eq(back.rows, [{ email: evil }], 'quote-laden value round-trips verbatim')
    const count = await db.query<{ c: number }>('select count(*)::int c from users')
    eq(count.rows, [{ c: 3 }], 'the users table survived the injection attempt')

    // Response shape: exec() genuinely returns no rows, so the response says so
    // rather than faking an empty array a caller would read as "0 results".
    console.log('response shape is explicit about the protocol used')
    const multi = await post(base, { sql: 'create table z1 (i int); create table z2 (i int);', multi: true })
    ok(multi.status === 200, `multi request succeeded (${multi.status})`)
    ok(multi.body.multi === true, 'multi response is flagged multi:true')
    ok(multi.body.rows === null, 'multi response returns rows:null, not a fake empty array')

    // The two are mutually exclusive; saying so beats mis-running the request.
    const conflict = await post(base, { sql: 'select $1::int', params: [1], multi: true })
    ok(conflict.status === 400, `multi + params is rejected (${conflict.status})`)
    ok(
      /cannot bind parameters/i.test(String(conflict.body.error)),
      `and the error explains why: ${String(conflict.body.error)}`,
    )

    await db.end()
  } finally {
    await srv.shutdown()
  }

  console.log(`\nPASS - ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
