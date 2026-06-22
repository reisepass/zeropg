// The ONLY zeropg-aware file. Everything else is ordinary Prisma.
//
//   DATABASE_URL=file:./pgdata      -> local in-process Postgres (default here)
//   DATABASE_URL=postgres://host/db -> a real remote Postgres, no code change
//
// Prisma talks to the resolved postgres:// URL via the @prisma/adapter-pg driver
// adapter (which works over the wire); Prisma's native migrate/db-push engine
// can't drive single-session PGlite, so schema is applied differently (see app.ts
// + README).

import { resolveDatabaseUrl } from '@zeropg/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client/index.js'

const handle = await resolveDatabaseUrl(process.env.DATABASE_URL ?? 'file:./pgdata')

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: handle.url }),
})

export async function close(): Promise<void> {
  await prisma.$disconnect()
  await handle.close() // leader: stops the wire + releases the lock; follower: no-op
}
