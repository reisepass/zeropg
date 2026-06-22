// The ONLY zeropg-aware file. Everything else is ordinary Drizzle + node-postgres.
//
//   DATABASE_URL=file:./pgdata      -> local in-process Postgres (default here)
//   DATABASE_URL=postgres://host/db -> a real remote Postgres, no code change
//
// resolveDatabaseUrl() returns a real postgres:// URL either way; for file:/pglite:
// it elects (or attaches to) a local single-writer Postgres over the datadir.

import { resolveDatabaseUrl } from '@zeropg/client'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.ts'

const handle = await resolveDatabaseUrl(process.env.DATABASE_URL ?? 'file:./pgdata')

export const pool = new Pool({ connectionString: handle.url })
export const db = drizzle(pool, { schema })

export async function close(): Promise<void> {
  await pool.end()
  await handle.close() // leader: stops the wire + releases the lock; follower: no-op
}
