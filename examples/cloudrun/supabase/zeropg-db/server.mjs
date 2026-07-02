// The zeropg "database" sidecar for the stripped Supabase stack on Cloud Run.
//
// = standard ZeroPGServer (GCS-backed scale-to-zero PGlite + Postgres wire on
// 127.0.0.1:5432 + GCS persistence) PLUS, for this stack:
//
//   1. NO extensions. GoTrue + PostgREST + the demo schema need none (verified:
//      GoTrue migrates + signup works with zero extensions). This lets the image
//      install the PUBLISHED @zeropg/* packages directly — no vendored tarballs.
//
//   2. BUILT-IN POSTGREST ON. @zeropg/server spawns the PostgREST Haskell binary
//      against the local wire with the single-session kill-switch already applied
//      (PGRST_DB_PREPARED_STATEMENTS=false + pool=1 => no 42P05). The frontend
//      reverse-proxies REST under /rest/v1. JWT verification + the role switch are
//      configured by passing PGRST_JWT_SECRET in this container's env (PostgrestProcess
//      inherits process.env).
//
//   3. BOOTSTRAP SCHEMA from bootstrap.sql (roles, auth schema + helpers, RLS demo
//      tables). Applied via schemaSql BEFORE PostgREST introspects and before GoTrue
//      connects.
//
//   4. LIVE-SESSION search_path. ALTER ROLE/DATABASE SET search_path does NOT take
//      effect on pglite-socket's multiplexed single session (the session is opened
//      once and reused), so GoTrue's UNQUALIFIED runtime queries would miss the auth
//      schema. We set it once on the live session over the wire after boot:
//        SET search_path TO public, auth
//      which is session-global and persists for all wire connections (verified).
//      `public` first keeps PostgREST's public tables resolving on the same session.
//
// Env:
//   ZEROPG_BUCKET     GCS bucket (durable home)          [required]
//   ZEROPG_PREFIX     per-app key prefix in the bucket   [default 'supabase']
//   PORT              HTTP control/health + /rest proxy face (Cloud Run sets it)
//   ZEROPG_WIRE_PORT  Postgres wire port on localhost    [default 5432]
//   ZEROPG_REST_PORT  local PostgREST port               [default 3000]
//   ZEROPG_POSTGREST  'off' to disable built-in PostgREST
//   PGRST_JWT_SECRET  HS256 secret PostgREST verifies JWTs with (share with GoTrue)
//   ZEROPG_SEARCH_PATH  live-session search_path          [default 'public, auth']

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { Client } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

const bucket = process.env.ZEROPG_BUCKET
if (!bucket) throw new Error('ZEROPG_BUCKET is required')
const prefix = process.env.ZEROPG_PREFIX || 'supabase'
const WIRE = Number(process.env.ZEROPG_WIRE_PORT || 5432)
const CTRL = Number(process.env.PORT || 8081)
const SEARCH_PATH = process.env.ZEROPG_SEARCH_PATH || 'public, auth'

const bootstrapSql = await readFile(join(__dirname, 'bootstrap.sql'), 'utf8')

const store = new GcsBlobStore({ bucket, prefix })

await ZeroPGServer.start({
  store,
  holder: process.env.ZEROPG_HOLDER || process.env.K_REVISION || 'cloudrun',
  port: CTRL,
  wireHost: '127.0.0.1',
  wirePort: WIRE,
  restPort: Number(process.env.ZEROPG_REST_PORT || 3000),
  postgrest: !/^(off|false|0)$/i.test(process.env.ZEROPG_POSTGREST ?? ''),
  restSchemas: process.env.ZEROPG_REST_SCHEMAS || 'public',
  schemaSql: bootstrapSql,
  label: process.env.APP_LABEL || 'supabase zeropg-db',
})

// After boot, pin the search_path on the LIVE shared session so GoTrue's
// unqualified runtime queries resolve into `auth`. Poll /ready first.
async function setLiveSearchPath() {
  const t0 = Date.now()
  while (Date.now() - t0 < 120_000) {
    try {
      const b = await (await fetch(`http://127.0.0.1:${CTRL}/ready`)).json()
      if (b.ready) break
      if (b.phase === 'error') throw new Error(`db boot error: ${b.error}`)
    } catch (e) {
      if (String(e).includes('db boot error')) throw e
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  const c = new Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
  await c.connect()
  await c.query(`SET search_path TO ${SEARCH_PATH}`)
  await c.end()
  console.log(`[zeropg-db] live-session search_path set to: ${SEARCH_PATH}`)
}
setLiveSearchPath().catch((e) => {
  console.error('[zeropg-db] failed to set live-session search_path:', e)
  process.exit(1)
})

console.log(
  `[zeropg-db] up: GCS=${bucket}/${prefix} wire=127.0.0.1:${WIRE} ` +
    `rest=127.0.0.1:${process.env.ZEROPG_REST_PORT || 3000} control=:${CTRL} (PGlite, no extensions)`,
)
