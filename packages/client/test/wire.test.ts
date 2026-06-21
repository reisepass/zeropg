// Run: tsx packages/client/test/wire.test.ts
//
// Proves the local real-wire mode: a real node-postgres client (the same driver
// Prisma/Drizzle/psql speak) connects to PGlite over the wire, runs DDL +
// parameterized queries + a transaction, and the data persists across a full
// server restart on disk. This is the foundation that makes existing ORM apps
// work locally against zeropg.

import { Client } from 'pg'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveWire } from '../src/wire.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`)
}

async function withPg<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function main(): Promise<void> {
  console.log('in-memory wire: a real pg client talks Postgres protocol to PGlite')
  const mem = await serveWire()
  ok(/^postgres:\/\/127\.0\.0\.1:\d+\/postgres$/.test(mem.url), `url looks right: ${mem.url}`)
  await withPg(mem.url, async (c) => {
    const v = await c.query('select version()')
    ok(String(v.rows[0].version).includes('PostgreSQL'), 'server reports as PostgreSQL over the wire')
    await c.query('create table t (id serial primary key, name text)')
    const ins = await c.query('insert into t (name) values ($1), ($2) returning id', ['a', 'b'])
    eq(ins.rowCount, 2, 'parameterized insert affected 2 rows')
    const sel = await c.query('select id, name from t order by id')
    eq(sel.rows, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], 'select round-trips over the wire')
    ok(sel.fields.some((f) => f.name === 'name' && typeof f.dataTypeID === 'number'), 'fields carry real type OIDs')
  })
  await mem.stop()

  console.log('file:// wire: data persists across a server restart (on-disk)')
  const dir = await mkdtemp(join(tmpdir(), 'wire-'))
  const dataDir = join(dir, 'db')
  const w1 = await serveWire({ dataDir })
  await withPg(w1.url, async (c) => {
    await c.query('create table notes (body text)')
    await c.query("insert into notes values ('survives')")
    await c.query('begin')
    await c.query("insert into notes values ('in-tx')")
    await c.query('commit')
  })
  await w1.stop()

  const w2 = await serveWire({ dataDir })
  await withPg(w2.url, async (c) => {
    const r = await c.query('select body from notes order by body')
    eq(r.rows, [{ body: 'in-tx' }, { body: 'survives' }], 'rows persisted across wire-server restart')
  })
  await w2.stop()

  console.log('lock: a second wire server on the same datadir is refused')
  const a = await serveWire({ dataDir })
  let threw = false
  try {
    await serveWire({ dataDir, acquireTimeoutMs: 300 })
  } catch {
    threw = true
  }
  ok(threw, 'second wire server on a live datadir is locked out')
  await a.stop()

  await rm(dir, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
