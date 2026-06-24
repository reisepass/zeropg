// KILL-SWITCH #1: PostgREST REST CRUD over the single-session zeropg wire.
//
// Boots ZeroPGServer with the built-in PostgREST (the 42P05 kill-switch
// PGRST_DB_PREPARED_STATEMENTS=false + pool=1 lives in @zeropg/server) and
// pgvector preloaded, against a FRESH GCS test prefix. Drives everything over
// the server's HTTP control face (so DDL via /sql auto-reloads PostgREST's
// schema cache, and REST goes through the /rest reverse proxy exactly as the
// Cloud Run frontend will use it):
//   - CREATE EXTENSION vector + a real <-> ANN query (pgvector preloaded)
//   - create a REST table + grant to anon
//   - REST CRUD: POST / GET filter / PATCH / DELETE
//   - hammer many concurrent REST writes => prove NO 42P05
//
// Run from repo root:
//   PGRST_BIN=$(cat /tmp/pgrst_path.txt) node examples/cloudrun/supabase/test/killswitch-postgrest.mjs
//
// Requires gcloud ADC (GcsBlobStore falls back to `gcloud auth print-access-token`).

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import { vector } from '@electric-sql/pglite-pgvector'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { Client } from 'pg'

const BUCKET = process.env.ZEROPG_BUCKET || 'zeropg-experiments-euw1'
const PREFIX = process.env.ZEROPG_PREFIX || `killswitch-postgrest-${Date.now()}`
const CTRL = 8599
const WIRE = 5599
const REST = 3599
const PGRST_BIN = process.env.PGRST_BIN || 'postgrest'

const fail = (m) => {
  console.error(`  FAIL ${m}`)
  process.exitCode = 1
}
const ok = (m) => console.log(`  ok   ${m}`)

const ctrl = `http://127.0.0.1:${CTRL}`
// DDL + seed go over the WIRE (node-postgres = unnamed statements, full write
// path). The /sql HTTP face is read-only by design (app writes use the wire).
let pg
async function sql(q) {
  const r = await pg.query(q)
  return { rows: r.rows }
}
async function rest(path, init) {
  const res = await fetch(`${ctrl}/rest${path}`, init)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

console.log(`[killswitch-postgrest] bucket=${BUCKET} prefix=${PREFIX} pgrst=${PGRST_BIN}`)

// Schema is created at BOOT (before PostgREST introspects) via schemaSql, the
// production-faithful path: the REST surface is correct from the first request,
// no runtime cache reload needed. (pgvector extension is preloaded; CREATE
// EXTENSION here just registers it in the catalog.)
const SCHEMA_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS items (id bigserial PRIMARY KEY, name text, embedding vector(3));
CREATE TABLE IF NOT EXISTS todos (id bigserial PRIMARY KEY, task text NOT NULL, done boolean NOT NULL DEFAULT false);
GRANT SELECT, INSERT, UPDATE, DELETE ON items, todos TO anon;
GRANT USAGE, SELECT ON SEQUENCE items_id_seq, todos_id_seq TO anon;
`

const store = new GcsBlobStore({ bucket: BUCKET, prefix: PREFIX })
await ZeroPGServer.start({
  store,
  holder: `killswitch-${process.pid}`,
  port: CTRL,
  wireHost: '127.0.0.1',
  wirePort: WIRE,
  restPort: REST,
  postgrest: true,
  postgrestBin: PGRST_BIN,
  restSchemas: 'public',
  extensions: { vector, pgcrypto },
  schemaSql: SCHEMA_SQL,
  label: 'killswitch-postgrest',
})

// Poll /ready until the DB restore + wire + PostgREST schema-cache are up.
const t0 = Date.now()
let ready = false
while (Date.now() - t0 < 120_000) {
  try {
    const r = await fetch(`${ctrl}/ready`)
    const b = await r.json()
    if (b.ready) {
      ready = true
      console.log(`[killswitch-postgrest] ready after ${Date.now() - t0}ms timings=${JSON.stringify(b.bootTimings)}`)
      break
    }
    if (b.phase === 'error') {
      fail(`boot error: ${b.error}`)
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
}
if (!ready) {
  fail('server never reached ready')
  process.exit(1)
}

pg = new Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
await pg.connect()

// Give PostgREST's async schema-cache load a moment to complete after ready.
await new Promise((r) => setTimeout(r, 3000))

try {
  // --- pgvector kill-switch: seed + ANN over the wire ---
  await sql("INSERT INTO items (name, embedding) VALUES ('a','[1,0,0]'),('b','[0,1,0]'),('c','[0.9,0.1,0]')")
  const ann = await sql("SELECT name FROM items ORDER BY embedding <-> '[1,0,0]' LIMIT 2")
  const order = ann.rows.map((r) => r.name).join(',')
  if (order === 'a,c') ok('pgvector <-> ANN ordering correct (a,c) over the wire')
  else fail(`pgvector ANN wrong order: ${JSON.stringify(ann.rows)}`)

  // The todos table + anon grants were created at BOOT via schemaSql, so
  // PostgREST already introspected them. Confirm the REST surface is live.
  const probe = await rest('/todos?limit=0')
  if (probe.status === 200) ok('PostgREST exposes the boot-created table (no runtime reload needed)')
  else fail(`PostgREST /todos not in schema cache: ${probe.status} ${JSON.stringify(probe.body)}`)

  // --- REST CRUD ---
  const ins = await rest('/todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ task: 'buy milk' }),
  })
  if (ins.status === 201 && ins.body?.[0]?.task === 'buy milk') ok('REST POST insert -> 201')
  else fail(`REST POST: ${ins.status} ${JSON.stringify(ins.body)}`)
  const id = ins.body?.[0]?.id

  const get = await rest(`/todos?id=eq.${id}&select=id,task,done`)
  if (get.status === 200 && get.body[0]?.task === 'buy milk' && get.body[0]?.done === false) ok('REST GET filter -> row')
  else fail(`REST GET: ${get.status} ${JSON.stringify(get.body)}`)

  const patch = await rest(`/todos?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ done: true }),
  })
  if (patch.status === 200 && patch.body[0]?.done === true) ok('REST PATCH update -> done=true')
  else fail(`REST PATCH: ${patch.status} ${JSON.stringify(patch.body)}`)

  const del = await rest(`/todos?id=eq.${id}`, { method: 'DELETE' })
  if (del.status === 204) ok('REST DELETE -> 204')
  else fail(`REST DELETE: ${del.status} ${JSON.stringify(del.body)}`)

  // --- 42P05 hammer: many concurrent REST writes (pool=1 / prepared=false path) ---
  const N = 60
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      rest('/todos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: `hammer ${i}` }),
      }),
    ),
  )
  const bad = results.filter((r) => r.status !== 201)
  if (bad.length === 0) ok(`REST hammer ${N} concurrent inserts, all 201 (NO 42P05)`)
  else fail(`REST hammer ${bad.length}/${N} failures, first: ${JSON.stringify(bad[0])}`)

  const count = await rest('/todos?select=count')
  ok(`final todos count via REST: ${JSON.stringify(count.body)}`)
} catch (e) {
  fail(String(e))
} finally {
  await pg?.end().catch(() => {})
}

console.log(process.exitCode ? '\n[killswitch-postgrest] RESULT: FAIL' : '\n[killswitch-postgrest] RESULT: PASS')
process.exit(process.exitCode || 0)
