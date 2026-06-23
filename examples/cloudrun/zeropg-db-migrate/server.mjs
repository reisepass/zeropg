// zeropg "database" sidecar for apps that need migrations and/or contrib
// extensions (Cal.com, Documenso, Rallly). Same as the basic sidecar, plus:
//   - loads PGlite contrib extensions named in ZEROPG_EXTENSIONS (e.g. "citext,pgcrypto")
//   - after the engine is ready, applies the app's REAL migrations from
//     MIGRATIONS_DIR over the wire, marker-gated (idempotent across restarts) —
//     the WAL-ship timer persists them to GCS
//   - exposes a /ready endpoint on $READY_PORT that returns 200 ONLY after
//     migrations are applied; the app's Cloud Run startup-dependency probes this,
//     so the app never connects before its schema exists.

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import pg from 'pg'

const bucket = process.env.ZEROPG_BUCKET
if (!bucket) throw new Error('ZEROPG_BUCKET is required')
const prefix = process.env.ZEROPG_PREFIX || 'app'
const wirePort = Number(process.env.ZEROPG_WIRE_PORT || 5432)
const controlPort = Number(process.env.ZEROPG_CONTROL_PORT || 8081)
const readyPort = Number(process.env.READY_PORT || 8082) // the app's startup-probe target
const migDir = process.env.MIGRATIONS_DIR || '/app/migrations'

// Resolve contrib extension modules named in ZEROPG_EXTENSIONS.
const extNames = (process.env.ZEROPG_EXTENSIONS || '').split(',').map((s) => s.trim()).filter(Boolean)
const extensions = {}
for (const n of extNames) {
  const mod = await import(`@electric-sql/pglite/contrib/${n}`)
  extensions[n] = mod[n] ?? Object.values(mod)[0]
}
console.log(`[zeropg-db] extensions: ${extNames.join(', ') || '(none)'}`)

const store = new GcsBlobStore({ bucket, prefix })
await ZeroPGServer.start({
  store,
  extensions,
  holder: process.env.ZEROPG_HOLDER || process.env.K_REVISION || 'cloudrun',
  port: controlPort,
  wireHost: '127.0.0.1',
  wirePort,
  postgrest: false,
  label: process.env.APP_LABEL || 'zeropg migrate sidecar',
})

// ZeroPGServer.start() returns once its HTTP face is up; boot/restore runs in the
// background. Wait until /up reports ready before touching the wire.
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

// Apply the app's real migrations over the wire, marker-gated.
let applied = 0
try {
  const folders = (await readdir(migDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  const c = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${wirePort}/postgres?sslmode=disable` })
  await c.connect()
  await c.query(`create table if not exists _zeropg_migrations (name text primary key, applied_at timestamptz default now())`)
  const done = new Set((await c.query(`select name from _zeropg_migrations`)).rows.map((r) => r.name))
  for (const f of folders) {
    if (done.has(f)) continue
    const sql = await readFile(join(migDir, f, 'migration.sql'), 'utf8').catch(() => null)
    if (sql == null) continue
    await c.query(sql)
    await c.query(`insert into _zeropg_migrations (name) values ($1)`, [f])
    applied++
  }
  await c.end()
  console.log(`[zeropg-db] migrations: ${folders.length} on disk, ${applied} newly applied`)
} catch (e) {
  if (e?.code === 'ENOENT') console.log(`[zeropg-db] no migrations dir at ${migDir}; skipping`)
  else { console.error('[zeropg-db] migration failed:', e?.message || e); process.exit(1) }
}

// Only NOW is the DB usable by the app — expose the readiness the app waits on.
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
}).listen(readyPort, () => {
  console.log(`[zeropg-db] READY: GCS=${bucket}/${prefix} wire=127.0.0.1:${wirePort} ready=:${readyPort}`)
})
