// 01 - basic: drive a real PGlite through @zeropg/client (installed FROM NPM).
//
//   pnpm basic
//
// Opens a file:// datadir, does CRUD + a transaction, closes. Shows the
// node-postgres-shaped surface and that data persists across a clean reopen.

import { connect } from '@zeropg/client'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'zeropg-basic-'))
const dataDir = join(dir, 'pgdata')
const url = `file://${dataDir}`
console.log(`datadir: ${dataDir}\n`)

let db = await connect(url, { noHmrPin: true })
console.log(`engine: ${db.engine}`)

await db.exec('create table todo (id serial primary key, title text not null, done boolean default false)')
const ins = await db.query('insert into todo (title) values ($1), ($2), ($3)', ['ship it', 'write tests', 'sleep'])
console.log(`inserted ${ins.rowCount} rows`)

await db.query('update todo set done = true where title = $1', ['write tests'])

await db.transaction(async (tx) => {
  await tx.query('insert into todo (title, done) values ($1, $2)', ['from a transaction', true])
})

const open = await db.query('select id, title, done from todo order by id')
console.log('rows:')
for (const r of open.rows) console.log(`  #${r.id} [${r.done ? 'x' : ' '}] ${r.title}`)

await db.end()
console.log('\nclosed. reopening to prove on-disk durability...')

db = await connect(url, { noHmrPin: true })
const again = await db.query('select count(*)::int as n, count(*) filter (where done)::int as done from todo')
console.log(`after reopen: ${again.rows[0].n} rows, ${again.rows[0].done} done`)
await db.end()

console.log('\nOK - basic CRUD + transaction + durable reopen via @zeropg/client (from npm)')
