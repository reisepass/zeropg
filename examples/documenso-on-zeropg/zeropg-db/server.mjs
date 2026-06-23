// zeropg "database container": PGlite backed by a Docker volume, exposed over the
// real Postgres wire (via @zeropg/client's serveWire + pglite-socket), with the
// pgcrypto + pg_trgm contrib extensions Documenso's migrations need. On boot it
// applies Documenso's REAL, untouched Prisma migrations IN-PROCESS (idempotent),
// then serves the wire. This is the drop-in replacement for the `postgres:15`
// service in Documenso's own self-hosting compose.

import { serveWire } from '@zeropg/client'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const DATA = process.env.ZEROPG_DATA || '/data'
const MIGRATIONS = process.env.MIGRATIONS_DIR || '/app/migrations'
const PORT = Number(process.env.PORT || 5432)

const wire = await serveWire({
  dataDir: join(DATA, 'db'),
  host: '0.0.0.0', // reachable by the app container on the compose network
  port: PORT,
  extensions: { pgcrypto, pg_trgm }, // <- what Documenso's schema requires
  maxConnections: 50, // the app's pg pool; queries still serialize through PGlite
  nativeDatadirLock: true, // sole owner of the volume; no wrapper lock needed
})

// Apply pending migrations in-process (no Prisma schema engine involved, which
// can't drive single-session PGlite). Idempotent via a marker table. The CREATE
// EXTENSION lines inside Documenso's migrations are no-ops here because serveWire
// already loaded pgcrypto/pg_trgm as PGlite contrib extensions (and they use
// `IF NOT EXISTS`).
const db = wire.pglite
await db.exec(
  `create table if not exists _zeropg_migrations (name text primary key, applied_at timestamptz default now())`,
)
const done = new Set((await db.query(`select name from _zeropg_migrations`)).rows.map((r) => r.name))
const folders = (await readdir(MIGRATIONS, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

let applied = 0
for (const f of folders) {
  if (done.has(f)) continue
  const sql = await readFile(join(MIGRATIONS, f, 'migration.sql'), 'utf8').catch(() => null)
  if (sql == null) continue
  try {
    await db.exec(sql)
  } catch (err) {
    console.error(`[zeropg-db] migration ${f} failed:`, err?.message || err)
    throw err
  }
  await db.query(`insert into _zeropg_migrations (name) values ($1)`, [f])
  applied++
}

const tables = await db.query(
  `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
)
console.log(`[zeropg-db] migrations: ${folders.length} on disk, ${applied} newly applied`)
console.log(`[zeropg-db] schema: ${tables.rows[0].n} public tables`)
console.log(`[zeropg-db] serving Postgres wire on 0.0.0.0:${PORT} (PGlite + pgcrypto + pg_trgm)`)

const shutdown = () => wire.stop().finally(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
