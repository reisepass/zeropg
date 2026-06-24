// Boot the reading-list board on zeropg — the Drizzle path, which (per
// ORM-ADAPTER-NOTES.md §"Drizzle (the natural fit)") needs NO special handling:
//
//   1. serveWire() stands up a localhost postgres:// wire over one PGlite
//      (file:// datadir, held under the E1 lock — one writer).
//   2. We connect Drizzle the ORDINARY way: a `pg` Pool on the wire url, fed to
//      drizzle-orm/node-postgres. No driver adapter, no ?sslmode hacks, no user
//      override — a plain `pg` Pool speaks the wire directly.
//   3. Drizzle's own migrate() applies the committed SQL under ./drizzle to that
//      single writer, tracking applied files in __drizzle_migrations. There is
//      NO shadow database and NO advisory-lock/multi-session orchestration (the
//      things that make Prisma's `migrate dev` fail on a single PGlite), so the
//      stock Drizzle migrator runs end to end over zeropg, unchanged.
//
// Swap the dataDir for a bucket-backed zeropg and this same code is a
// scale-to-zero Postgres app; graduate by pointing the Pool at a real
// postgres:// — no app change.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWire, type WireServer } from '@zeropg/client'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import * as schema from './schema.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(HERE, 'drizzle')

export type DB = NodePgDatabase<typeof schema>

export interface Booted {
  db: DB
  wire: WireServer
  pool: Pool
  stop: () => Promise<void>
}

export async function boot(opts: { dataDir?: string } = {}): Promise<Booted> {
  const wire = await serveWire({ dataDir: opts.dataDir ?? join(HERE, 'data', 'board') })
  // A plain node-postgres Pool on the wire url — exactly what you'd use against
  // RDS. PGlite serializes everything onto one backend session, so cap the pool
  // at one connection (the single-writer model made literal).
  const pool = new Pool({ connectionString: wire.url, max: 1 })
  const db = drizzle(pool, { schema })
  // Stock Drizzle migrator over the zeropg wire: applies ./drizzle/*.sql in
  // journal order, tracked in __drizzle_migrations. No shadow DB.
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return {
    db,
    wire,
    pool,
    stop: async () => {
      await pool.end()
      await wire.stop()
    },
  }
}
