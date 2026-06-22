// Ordinary Prisma. Nothing here knows about zeropg, locks, or PGlite - it just
// uses `prisma`. Run: pnpm dev
//
// Schema: applied here via $executeRawUnsafe so the example is self-contained.
// In a real project you'd author migrations with `zeropg migrate dev` and apply
// them with `zeropg migrate deploy` - Prisma's native db-push/migrate engine
// can't drive single-session PGlite (it needs a separate wire it can't get).

import { prisma, close } from './db.ts'

await prisma.$executeRawUnsafe(`create table if not exists "Note" (
  "id" serial primary key,
  "body" text not null,
  "done" boolean not null default false,
  "createdAt" timestamp(3) not null default now()
)`)

await prisma.note.deleteMany() // reset so re-runs print the same thing

await prisma.note.createMany({
  data: [
    { body: 'ship the local-postgres example' },
    { body: 'write the README', done: true },
  ],
})

const all = await prisma.note.findMany({ orderBy: { id: 'asc' } })
console.log('all notes:')
for (const n of all) console.log(`  #${n.id} [${n.done ? 'x' : ' '}] ${n.body}`)

const open = await prisma.note.count({ where: { done: false } })
console.log(`open notes: ${open}`)

await close()
console.log('\nOK - Prisma ORM over a local zeropg Postgres (resolve -> postgres:// -> adapter-pg)')
