// Ordinary Drizzle. Nothing here knows about zeropg, locks, or PGlite - it just
// uses `db`. The schema is applied separately with `zeropg run drizzle-kit push`
// (see package.json `db:push`); run `pnpm dev` to do both.

import { eq, sql } from 'drizzle-orm'
import { db, close } from './db.ts'
import { notes } from './schema.ts'

await db.delete(notes) // reset so re-runs print the same thing

await db.insert(notes).values([
  { body: 'ship the local-postgres example' },
  { body: 'write the README', done: true },
])

const all = await db.select().from(notes).orderBy(notes.id)
console.log('all notes:')
for (const n of all) console.log(`  #${n.id} [${n.done ? 'x' : ' '}] ${n.body}`)

const [{ open }] = await db
  .select({ open: sql<number>`count(*)::int` })
  .from(notes)
  .where(eq(notes.done, false))
console.log(`open notes: ${open}`)

await close()
console.log('\nOK - Drizzle ORM over a local zeropg Postgres (resolve -> postgres:// -> pg pool)')
