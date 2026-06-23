// zeropg "database container": PGlite backed by a Docker volume, exposed over the
// real Postgres wire (via @zeropg/client's serveWire + pglite-socket). This is the
// drop-in replacement for a `postgres:18` service that PrivateBin would otherwise
// talk to via PDO pgsql.
//
// Unlike the Rallly example, there are NO migrations and NO contrib extensions here:
// PrivateBin's Database model auto-creates its own tables on first connection
// (paste/comment/config), using only plain CHAR/TEXT/INT columns and one index —
// all of which stock PGlite handles natively. So this server just opens the volume
// and serves the wire; PrivateBin owns the schema.

import { serveWire } from '@zeropg/client'

const DATA = process.env.ZEROPG_DATA || '/data'
const PORT = Number(process.env.PORT || 5432)

const wire = await serveWire({
  dataDir: `${DATA}/db`,
  host: '0.0.0.0', // reachable by the app container on the compose network
  port: PORT,
  maxConnections: 50, // PrivateBin's PDO connections; queries serialize through PGlite
  nativeDatadirLock: true, // sole owner of the volume; no wrapper lock needed
})

const db = wire.pglite
const tables = await db.query(
  `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
)
console.log(`[zeropg-db] schema: ${tables.rows[0].n} public tables (PrivateBin creates its own on first use)`)
console.log(`[zeropg-db] serving Postgres wire on 0.0.0.0:${PORT} (stock PGlite, no extensions)`)

const shutdown = () => wire.stop().finally(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
