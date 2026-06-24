// The zeropg "database" sidecar for the stripped Supabase stack on Cloud Run.
//
// It is the standard ZeroPGServer (GCS-backed, scale-to-zero PGlite over the
// pglite-socket Postgres wire on 127.0.0.1:5432) with two additions for this
// stack:
//
//   1. PGVECTOR PRELOADED. Supabase ships pgvector; PGlite reaches it via the
//      separate npm package `@electric-sql/pglite-pgvector` (NOT contrib/*), so
//      we import { vector } and hand it to ZeroPG.open({ extensions }). Without
//      this, `CREATE EXTENSION vector` errors with `extension "vector" is not
//      available` (PGlite only loads an extension whose JS module was injected).
//      pgcrypto is also preloaded: GoTrue's auth schema and gen_random_uuid()
//      style defaults want it, and it is cheap.
//
//   2. BUILT-IN POSTGREST ON. @zeropg/server can spawn the PostgREST Haskell
//      binary itself, pointed at the local wire, with the single-session
//      kill-switch already applied in packages/server/src/postgrest.ts:
//        PGRST_DB_PREPARED_STATEMENTS=false  (no 42P05 on the shared session)
//        PGRST_DB_POOL=1
//      So REST CRUD over the zeropg wire works with no extra container. The
//      REST API is reverse-proxied by the frontend container under /rest.
//
// Env:
//   ZEROPG_BUCKET     GCS bucket (durable home)        [required]
//   ZEROPG_PREFIX     per-app key prefix in the bucket [default 'supabase']
//   PORT              HTTP control/health + REST-proxy face (Cloud Run sets it)
//   ZEROPG_WIRE_PORT  Postgres wire port on localhost  [default 5432]
//   ZEROPG_REST_PORT  local PostgREST port             [default 3000]
//   ZEROPG_POSTGREST  'off' to disable built-in PostgREST
//   ZEROPG_REST_SCHEMAS  schemas PostgREST exposes      [default 'public']
//   ZEROPG_SCHEMA_SQL    optional bootstrap SQL run after restore

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import { vector } from '@electric-sql/pglite-pgvector'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const bucket = process.env.ZEROPG_BUCKET
if (!bucket) throw new Error('ZEROPG_BUCKET is required')
const prefix = process.env.ZEROPG_PREFIX || 'supabase'

const store = new GcsBlobStore({ bucket, prefix })

const server = await ZeroPGServer.start({
  store,
  holder: process.env.ZEROPG_HOLDER || process.env.K_REVISION || 'cloudrun',
  port: Number(process.env.PORT || 8081),
  wireHost: '127.0.0.1',
  wirePort: Number(process.env.ZEROPG_WIRE_PORT || 5432),
  restPort: Number(process.env.ZEROPG_REST_PORT || 3000),
  // Built-in PostgREST is ON unless ZEROPG_POSTGREST=off. The 42P05 kill-switch
  // (prepared-statements=false, pool=1) lives in the server package already.
  postgrest: !/^(off|false|0)$/i.test(process.env.ZEROPG_POSTGREST ?? ''),
  restSchemas: process.env.ZEROPG_REST_SCHEMAS || 'public',
  // pgvector for the Supabase vector layer; pgcrypto for auth/uuid defaults.
  extensions: { vector, pgcrypto },
  schemaSql: process.env.ZEROPG_SCHEMA_SQL || undefined,
  label: process.env.APP_LABEL || 'supabase zeropg-db',
})

console.log(
  `[zeropg-db] up: GCS=${bucket}/${prefix} wire=127.0.0.1:${process.env.ZEROPG_WIRE_PORT || 5432} ` +
    `rest=127.0.0.1:${process.env.ZEROPG_REST_PORT || 3000} control=:${process.env.PORT || 8081} ` +
    `(PGlite + pgvector + pgcrypto)`,
)

// Keep a reference so the process does not get GC-surprised; ZeroPGServer holds
// its own timers but this makes intent explicit.
void server
