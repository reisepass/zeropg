// zeropg "database" sidecar for nostream on Cloud Run.
//
// Same GCS-backed, scale-to-zero ZeroPGServer (PGlite + Postgres wire on
// 127.0.0.1:5432, single-writer lease, WAL-ship-to-GCS timer) as the other
// examples, but specialised for nostream:
//   - preloads the contrib extensions nostream's schema needs: uuid_ossp
//     (CREATE EXTENSION "uuid-ossp") and btree_gin (the kind/tags/created_at GIN index)
//   - applies nostream's REAL knex migrations (JS, not migration.sql folders) by
//     shelling out to the knex CLI against the wire. knex is idempotent across
//     restarts via its own knex_migrations table, and the WAL-ship timer persists
//     the applied schema to GCS.
//   - exposes /ready on $READY_PORT that returns 200 ONLY after migrations are
//     applied; nostream's Cloud Run startup-dependency probes this so the app never
//     connects before its schema exists.
//
// Env:
//   ZEROPG_BUCKET     GCS bucket (durable home)            [required]
//   ZEROPG_PREFIX     per-app key prefix                   [default "cloudrun-nostr"]
//   ZEROPG_EXTENSIONS comma list                           [default "uuid_ossp,btree_gin"]
//   ZEROPG_WIRE_PORT  Postgres wire port on localhost      [default 5432]
//   ZEROPG_CONTROL_PORT  HTTP control/health port          [default 8081]
//   READY_PORT        app's startup-probe target           [default 8082]
//   NOSTREAM_DIR      where nostream's knexfile+migrations are baked [default /nostream]

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const bucket = process.env.ZEROPG_BUCKET
if (!bucket) throw new Error('ZEROPG_BUCKET is required')
const prefix = process.env.ZEROPG_PREFIX || 'cloudrun-nostr'
const wirePort = Number(process.env.ZEROPG_WIRE_PORT || 5432)
const controlPort = Number(process.env.ZEROPG_CONTROL_PORT || 8081)
const readyPort = Number(process.env.READY_PORT || 8082)
const nostreamDir = process.env.NOSTREAM_DIR || '/nostream'

// Resolve contrib extension modules. nostream needs uuid_ossp + btree_gin.
const extNames = (process.env.ZEROPG_EXTENSIONS || 'uuid_ossp,btree_gin')
  .split(',').map((s) => s.trim()).filter(Boolean)
const extensions = {}
for (const n of extNames) {
  const mod = await import(`@electric-sql/pglite/contrib/${n}`)
  extensions[n] = mod[n] ?? Object.values(mod)[0]
}
console.log(`[nostr-db] extensions: ${extNames.join(', ') || '(none)'}`)

const store = new GcsBlobStore({ bucket, prefix })
await ZeroPGServer.start({
  store,
  extensions,
  holder: process.env.ZEROPG_HOLDER || process.env.K_REVISION || 'cloudrun',
  port: controlPort,
  wireHost: '127.0.0.1',
  wirePort,
  postgrest: false,
  label: process.env.APP_LABEL || 'nostream db sidecar',
})

// Wait until the engine reports ready before applying migrations.
async function waitReady() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${controlPort}/up`)
      if ((await r.json()).ok) return
    } catch {}
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error('engine not ready in time')
}
await waitReady()

// Apply nostream's knex migrations over the wire. knex tracks applied migrations
// in knex_migrations, so this is idempotent across restarts.
function runKnexMigrate() {
  return new Promise((resolve, reject) => {
    const dbUri = `postgres://postgres:postgres@127.0.0.1:${wirePort}/postgres?sslmode=disable`
    const child = spawn(
      'node',
      ['./node_modules/.bin/knex', 'migrate:latest', '--knexfile', 'knexfile.js'],
      { cwd: nostreamDir, env: { ...process.env, DATABASE_URI: dbUri }, stdio: 'inherit' },
    )
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`knex migrate exited ${code}`))))
    child.on('error', reject)
  })
}

try {
  await runKnexMigrate()
  console.log('[nostr-db] migrations applied')
} catch (e) {
  console.error('[nostr-db] migration failed:', e?.message || e)
  process.exit(1)
}

// Only NOW is the DB usable by nostream — expose the readiness the app waits on.
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}).listen(readyPort, () => {
  console.log(`[nostr-db] READY: GCS=${bucket}/${prefix} wire=127.0.0.1:${wirePort} ready=:${readyPort}`)
})
