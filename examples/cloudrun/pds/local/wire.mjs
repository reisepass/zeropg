// Local zeropg wire for cocoon (AT Protocol PDS) testing. cocoon's schema is
// created by GORM AutoMigrate at boot and needs NO contrib extensions (all
// vanilla text/bytea/timestamptz/bool/int columns + composite PKs/indexes).
//
// The cocoon app connects over the Postgres wire with
//   ?default_query_exec_mode=simple_protocol
// so jackc/pgx uses the SIMPLE protocol (no named server-side prepared
// statements) and never hits the 42P05 collision that blocks sqlx/Diesel on the
// shared single-session PGlite wire.
//
// Run from the zeropg repo root so @zeropg/client resolves:
//   WIRE_PORT=5602 npx tsx examples/cloudrun/pds/local/wire.mjs
import { serveWire } from '@zeropg/client'

const dataDir = process.env.WIRE_DATADIR || '/tmp/pds-zeropg-data'
const port = Number(process.env.WIRE_PORT || 5602)
const srv = await serveWire({
  dataDir,
  host: '0.0.0.0',
  port,
  maxConnections: 20,
})
console.log(`[pds-wire] up on 0.0.0.0:${port} datadir=${dataDir}`)
