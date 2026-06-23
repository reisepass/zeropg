// zeropg "database container": PGlite backed by a Docker volume, exposed over the
// real Postgres wire (via @zeropg/client's serveWire + pglite-socket). This is the
// drop-in replacement for the `postgres:16` service in NocoDB's compose.
//
// Unlike the Rallly example, NocoDB OWNS its metadata schema: pointed at a fresh
// Postgres via NC_DB, NocoDB runs its own Knex migrations over the wire on first
// boot to create every metadata table. So this container applies NO migrations —
// it just serves an empty database and lets NocoDB self-migrate over the wire.

import { serveWire } from '@zeropg/client'

const DATA = process.env.ZEROPG_DATA || '/data'
const PORT = Number(process.env.PORT || 5432)

const wire = await serveWire({
  dataDir: `${DATA}/db`,
  host: '0.0.0.0', // reachable by the nocodb container on the compose network
  port: PORT,
  maxConnections: 100, // NocoDB's metadata pool; queries still serialize through PGlite
  nativeDatadirLock: true, // sole owner of the volume; no wrapper lock needed
})

const db = wire.pglite
const tables = await db.query(
  `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
)
console.log(`[zeropg-db] schema: ${tables.rows[0].n} public tables (NocoDB self-migrates on first boot)`)
console.log(`[zeropg-db] serving Postgres wire on 0.0.0.0:${PORT} (PGlite)`)

const shutdown = () => wire.stop().finally(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
