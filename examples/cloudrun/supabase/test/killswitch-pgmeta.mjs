// KILL-SWITCH: supabase/postgres-meta over the single-session zeropg wire.
//
// postgres-meta is the introspection + run-SQL engine behind Supabase Studio,
// and the engine we plan to use for the zeropg Console admin frontend
// (docs/DIY-zeropg ConsoleFrontend.md). This proves it works against
// zeropg's ONE shared PGlite session (pglite-socket multiplexes every wire
// connection onto a single serialized PGlite), and pins the exact adversarial
// behaviors the SQL editor has to design around.
//
// It boots a LOCAL zeropg wire server (serveWire, NO GCS needed - the single
// shared session, not persistence, is what postgres-meta stresses), seeds a
// demo schema, starts postgres-meta (Docker by default), and asserts:
//   P0 surface: /schemas, /tables (+columns), /columns, POST /query
//   1. concurrency: 20 mixed + 50x same query => NO 42P05 / 26000 / interleave
//   2. session poisoning: bad SQL 400 => next query + /tables still OK (no
//      "current transaction is aborted": POST /query does not wrap in a txn)
//   3. session-state contamination: a `SET` on one request LEAKS to the next
//      (single shared session) and introspection stays immune (schema-qualified);
//      `SET search_path TO public` restores
//   4. statement_timeout is a NO-OP on PGlite (single-threaded WASM cannot
//      cancel a running query) AND a long AUTOCOMMIT query does NOT block other
//      wire clients, while an idle-open EXPLICIT transaction DOES block them.
//
// Run from repo root (Docker running):
//   node examples/cloudrun/supabase/test/killswitch-pgmeta.mjs
// Or against an already-running postgres-meta (skips Docker):
//   PG_META_URL=http://127.0.0.1:8080 node examples/cloudrun/supabase/test/killswitch-pgmeta.mjs
//
// Env knobs: ZEROPG_WIRE_PORT (default 5620), PG_META_PORT (8090),
//   PG_META_IMAGE (supabase/postgres-meta:v0.96.6), PG_META_URL (external).

import { serveWire } from '@zeropg/client'
import pg from 'pg'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(_execFile)

const WIRE = Number(process.env.ZEROPG_WIRE_PORT || 5620)
const META_PORT = Number(process.env.PG_META_PORT || 8090)
const IMAGE = process.env.PG_META_IMAGE || 'supabase/postgres-meta:v0.96.6'
const EXTERNAL = process.env.PG_META_URL || null // if set, skip Docker
const CONTAINER = `pgmeta-killswitch-${process.pid}`

let failed = 0
const fail = (m) => {
  failed++
  console.error(`  FAIL ${m}`)
}
const ok = (m) => console.log(`  ok   ${m}`)

const SEED = `
CREATE ROLE app_reader NOLOGIN;
CREATE SCHEMA demo;
CREATE TABLE demo.authors (id bigserial PRIMARY KEY, name text NOT NULL);
CREATE TABLE demo.books (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  author_id bigint REFERENCES demo.authors(id),
  published_at timestamptz DEFAULT now()
);
CREATE INDEX books_title_idx ON demo.books (title);
GRANT USAGE ON SCHEMA demo TO app_reader;
GRANT SELECT ON demo.authors, demo.books TO app_reader;
ALTER TABLE demo.books ENABLE ROW LEVEL SECURITY;
CREATE POLICY books_read ON demo.books FOR SELECT USING (true);
CREATE FUNCTION demo.touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.published_at := now(); RETURN NEW; END $$;
CREATE TRIGGER books_touch BEFORE UPDATE ON demo.books
  FOR EACH ROW EXECUTE FUNCTION demo.touch();
INSERT INTO demo.authors (name) VALUES ('Ursula'), ('Ted');
INSERT INTO demo.books (title, author_id) VALUES ('A Wizard of Earthsea', 1), ('Story of Your Life', 2);
`

console.log(`[killswitch-pgmeta] wire=${WIRE} meta=${EXTERNAL || `docker:${META_PORT}`} image=${IMAGE}`)

// --- boot the local single-session zeropg wire server + seed ---
const wire = await serveWire({ host: '0.0.0.0', port: WIRE })
await wire.pglite.exec(SEED)
console.log(`[killswitch-pgmeta] wire up + demo schema seeded`)

// --- start postgres-meta (Docker) unless PG_META_URL points at an external one ---
const metaBase = EXTERNAL || `http://127.0.0.1:${META_PORT}`
let usingDocker = false
if (!EXTERNAL) {
  await execFile('docker', ['rm', '-f', CONTAINER]).catch(() => {})
  await execFile('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-p', `${META_PORT}:8080`,
    '-e', 'PG_META_PORT=8080',
    '-e', `PG_META_DB_URL=postgresql://postgres:postgres@host.docker.internal:${WIRE}/postgres?sslmode=disable`,
    IMAGE,
  ]).catch(async (e) => {
    console.error('[killswitch-pgmeta] docker run failed. Is Docker running? Or pass PG_META_URL=... to skip Docker.')
    console.error(String(e))
    await wire.stop()
    process.exit(1)
  })
  usingDocker = true
}

async function waitHealth(ms = 45000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${metaBase}/health`); if (r.ok) return true } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}
if (!(await waitHealth())) {
  fail('postgres-meta never became healthy')
  if (usingDocker) {
    const logs = await execFile('docker', ['logs', CONTAINER]).catch(() => ({ stdout: '', stderr: '' }))
    console.error(logs.stdout, logs.stderr)
    await execFile('docker', ['rm', '-f', CONTAINER]).catch(() => {})
  }
  await wire.stop()
  process.exit(1)
}
console.log(`[killswitch-pgmeta] postgres-meta healthy at ${metaBase}\n`)

async function meta(path, init) {
  const t0 = Date.now()
  const r = await fetch(`${metaBase}${path}`, init)
  const text = await r.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body, ms: Date.now() - t0 }
}
const query = (q, qs = '') =>
  meta(`/query${qs}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT>${ms}ms`)), ms))])

try {
  // ---------------- P0 SURFACE ----------------
  console.log('--- P0 surface ---')
  {
    const s = await meta('/schemas')
    if (s.status === 200 && Array.isArray(s.body) && s.body.some((x) => x.name === 'demo')) ok('GET /schemas lists demo')
    else fail(`GET /schemas: ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`)

    const t = await meta('/tables?included_schemas=demo')
    const books = Array.isArray(t.body) ? t.body.find((x) => x.name === 'books') : null
    if (t.status === 200 && books && Array.isArray(books.columns) && books.columns.length >= 4) ok('GET /tables includes demo.books with columns')
    else fail(`GET /tables: ${t.status} ${JSON.stringify(t.body).slice(0, 200)}`)

    const c = await meta('/columns?included_schemas=demo')
    if (c.status === 200 && Array.isArray(c.body) && c.body.some((x) => x.table === 'books' && x.name === 'title')) ok('GET /columns includes demo.books.title')
    else fail(`GET /columns: ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`)

    const q = await query('select count(*)::int as n from demo.books')
    if (q.status === 200 && Array.isArray(q.body) && q.body[0]?.n === 2) ok('POST /query runs arbitrary SQL (count=2)')
    else fail(`POST /query: ${q.status} ${JSON.stringify(q.body).slice(0, 200)}`)

    const w = await query('create table demo.scratch (id int); insert into demo.scratch values (1),(2); select count(*)::int as n from demo.scratch')
    if (w.status === 200 && Array.isArray(w.body) && w.body[0]?.n === 2) ok('POST /query runs multi-statement DDL+DML (returns last result set)')
    else fail(`POST /query multi-statement: ${w.status} ${JSON.stringify(w.body).slice(0, 200)}`)
  }

  // ---------------- P1 SURFACE (nice-to-have; extensions may partial-fail) ----------------
  console.log('--- P1 surface ---')
  for (const [label, path, pred] of [
    ['/roles', '/roles', (b) => b.some((x) => x.name === 'app_reader')],
    ['/policies', '/policies', (b) => b.some((x) => x.name === 'books_read')],
    ['/functions', '/functions?included_schemas=demo', (b) => b.some((x) => x.name === 'touch')],
    ['/triggers', '/triggers', (b) => b.some((x) => x.name === 'books_touch')],
    // /indexes rows have no `name`; the index name is inside index_definition (the CREATE INDEX text).
    // NOTE: /indexes is PARTIAL on zeropg - see the documented-gap assertion below. It reliably returns
    // the primary-key index, so that is all we require here.
    ['/indexes', '/indexes?included_schemas=demo', (b) => b.some((x) => String(x.index_definition || '').includes('books_pkey'))],
    ['/extensions', '/extensions', (b) => Array.isArray(b)],
  ]) {
    const r = await meta(path)
    if (r.status === 200 && Array.isArray(r.body) && pred(r.body)) ok(`GET ${label} works`)
    else fail(`GET ${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`)
  }

  // Documented P1 gap: postgres-meta's /indexes SQL joins pg_attribute on the index oid with
  // `attnum = ANY(indkey)`, which under PGlite's catalog only matches when the index's leading
  // column aligns with the table column ordinal. A secondary index on a later column
  // (books_title_idx on the 2nd column) is therefore OMITTED from /indexes - but the underlying
  // data is present and correct via `pg_indexes`. The Studio "indexes" view should query
  // pg_indexes directly (over POST /query) rather than rely on postgres-meta /indexes.
  console.log('--- P1 documented gap: /indexes drops non-first-column secondary indexes ---')
  {
    const idx = await meta('/indexes?included_schemas=demo')
    const hasSecondaryViaMeta = Array.isArray(idx.body) && idx.body.some((x) => String(x.index_definition || '').includes('books_title_idx'))
    const viaPgIndexes = await query(`select indexname from pg_indexes where schemaname='demo' order by indexname`)
    const hasSecondaryViaSql = Array.isArray(viaPgIndexes.body) && viaPgIndexes.body.some((r) => r.indexname === 'books_title_idx')
    if (!hasSecondaryViaMeta && hasSecondaryViaSql)
      ok('confirmed: /indexes omits books_title_idx, but POST /query over pg_indexes returns it (workaround for Studio)')
    else
      fail(`indexes-gap unexpected: viaMeta=${hasSecondaryViaMeta} viaPgIndexes=${hasSecondaryViaSql} (${JSON.stringify(viaPgIndexes.body).slice(0, 120)})`)
  }

  // ---------------- ADVERSARIAL 1: concurrency / prepared-statement collision ----------------
  console.log('--- adversarial 1: concurrency (no 42P05 / 26000 / interleave) ---')
  {
    const mixed = await Promise.all([
      ...Array.from({ length: 7 }, () => meta('/tables?included_schemas=demo')),
      ...Array.from({ length: 7 }, () => meta('/columns?included_schemas=demo')),
      ...Array.from({ length: 6 }, () => query('select count(*) from demo.books')),
    ])
    const bad = mixed.filter((r) => r.status !== 200)
    if (bad.length === 0) ok('20 concurrent mixed requests: all 200')
    else fail(`20 concurrent: ${bad.length} non-200, first: ${bad[0].status} ${JSON.stringify(bad[0].body).slice(0, 160)}`)

    const rep = await Promise.all(Array.from({ length: 50 }, () => query('select 1 as x')))
    const badr = rep.filter((r) => r.status !== 200 || r.body?.[0]?.x !== 1)
    if (badr.length === 0) ok('50x identical query: all 200 (no prepared-statement 42P05)')
    else fail(`50x query: ${badr.length} bad, first: ${badr[0].status} ${JSON.stringify(badr[0].body).slice(0, 160)}`)
  }

  // ---------------- ADVERSARIAL 2: session poisoning (aborted-transaction check) ----------------
  console.log('--- adversarial 2: session poisoning ---')
  {
    const bad = await query('select * from does_not_exist_table')
    if (bad.status >= 400 && (bad.body?.code === '42P01' || String(bad.body?.error || '').includes('42P01'))) ok('invalid SQL -> 4xx with 42P01 (error surfaced, not swallowed)')
    else fail(`invalid SQL: ${bad.status} ${JSON.stringify(bad.body).slice(0, 160)}`)

    const recover = await query('select 1 as x')
    if (recover.status === 200 && recover.body?.[0]?.x === 1) ok('query right after error works (no "current transaction is aborted")')
    else fail(`recovery query: ${recover.status} ${JSON.stringify(recover.body).slice(0, 160)}`)

    const tb = await meta('/tables?included_schemas=demo')
    if (tb.status === 200 && Array.isArray(tb.body)) ok('/tables right after error works (session not poisoned)')
    else fail(`/tables after error: ${tb.status} ${JSON.stringify(tb.body).slice(0, 160)}`)
  }

  // ---------------- ADVERSARIAL 3: session-state contamination (SET leaks; introspection immune) ----------------
  console.log('--- adversarial 3: session-state contamination (single shared session) ---')
  {
    // request A sets search_path so ONLY demo is on it (drops public)
    const setA = await query('SET search_path TO demo')
    if (setA.status === 200) ok('SET search_path TO demo accepted')
    else fail(`SET search_path: ${setA.status} ${JSON.stringify(setA.body).slice(0, 160)}`)

    // request B is a SEPARATE postgres-meta request (new pool/connection). If the
    // SET leaked, an UNQUALIFIED select of a demo table resolves -> proves ONE
    // shared backend session across connections.
    const leak = await query('select count(*)::int as n from books')
    if (leak.status === 200 && leak.body?.[0]?.n === 2) ok('SET from a prior request LEAKS to the next (confirms single shared session)')
    else fail(`leak probe (expected demo.books via leaked search_path): ${leak.status} ${JSON.stringify(leak.body).slice(0, 160)}`)

    // introspection endpoints are fully schema-qualified -> immune to a polluted search_path
    const tb = await meta('/tables?included_schemas=demo')
    if (tb.status === 200 && Array.isArray(tb.body) && tb.body.some((x) => x.name === 'books')) ok('/tables still correct under a polluted search_path (introspection is schema-qualified)')
    else fail(`/tables under polluted search_path: ${tb.status} ${JSON.stringify(tb.body).slice(0, 160)}`)

    // restore
    const restore = await query('SET search_path TO public')
    const gone = await query('select count(*) from books') // should now FAIL (books is in demo, not public)
    if (restore.status === 200 && gone.status >= 400) ok('SET search_path TO public restores the session (leak is reversible)')
    else fail(`restore: restore=${restore.status} gone=${gone.status} ${JSON.stringify(gone.body).slice(0, 120)}`)

    // SET ROLE leaks too, and crucially RESET ALL does NOT clear it - only RESET ROLE
    // does. This pins the exact reset baseline the BFF must use per SQL-editor submission.
    await query('SET ROLE app_reader')
    const asRole = await query('select current_user as u')
    if (asRole.body?.[0]?.u === 'app_reader') ok('SET ROLE app_reader leaks onto the shared session (current_user=app_reader)')
    else fail(`SET ROLE leak: ${JSON.stringify(asRole.body).slice(0, 120)}`)
    await query('RESET ALL')
    const afterResetAll = await query('select current_user as u')
    if (afterResetAll.body?.[0]?.u === 'app_reader') ok('RESET ALL does NOT clear SET ROLE (current_user still app_reader) - baseline needs explicit RESET ROLE')
    else fail(`expected RESET ALL to leave role set, got ${JSON.stringify(afterResetAll.body).slice(0, 120)}`)
    await query('RESET ROLE')
    const afterResetRole = await query('select current_user as u')
    if (afterResetRole.body?.[0]?.u === 'postgres') ok('RESET ROLE restores current_user=postgres (correct reset baseline: RESET ROLE; RESET ALL; SET search_path TO public)')
    else fail(`RESET ROLE did not restore: ${JSON.stringify(afterResetRole.body).slice(0, 120)}`)
    await query('SET search_path TO public')
  }

  // ---------------- ADVERSARIAL 4: statement_timeout no-op + blast radius ----------------
  console.log('--- adversarial 4: statement_timeout + long-query blast radius ---')
  {
    // 4a: statement_timeout is a NO-OP on PGlite (cannot cancel a running query).
    const t0 = Date.now()
    const r = await query(`SET statement_timeout='500ms'; select pg_sleep(2)`)
    const dur = Date.now() - t0
    if (r.status === 200 && dur > 1800) ok(`statement_timeout ineffective (does not fire): pg_sleep(2) ran full ${dur}ms despite 500ms timeout (SQL-editor timeouts must be client-side)`)
    else fail(`statement_timeout probe: status=${r.status} dur=${dur}ms body=${JSON.stringify(r.body).slice(0, 120)}`)
    await query('SET statement_timeout = 0')

    // 4b: a long AUTOCOMMIT query does NOT head-of-line block other wire clients.
    // Fire several probes (reads AND writes) at a fixed cadence during a long query
    // and require each to return promptly. (Single-point timing can race the long
    // query's start; a cadence of probes across its whole duration cannot.)
    await wire.pglite.exec('CREATE TABLE IF NOT EXISTS demo._probe (id serial primary key)')
    const direct = new pg.Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
    await direct.connect()
    const sleeping = query('select pg_sleep(2)') // long autocommit statement, via meta
    const lats = []
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 250))
      const ps = Date.now()
      // alternate read / write probes
      if (i % 2 === 0) await direct.query('select 1')
      else await direct.query('insert into demo._probe default values')
      lats.push(Date.now() - ps)
    }
    await sleeping
    const maxLat = Math.max(...lats)
    if (maxLat < 1000) ok(`long AUTOCOMMIT query does NOT freeze other clients (6 read+write probes during pg_sleep(2), max ${maxLat}ms)`)
    else fail(`autocommit blast radius: a probe took ${maxLat}ms (expected < 1000ms); latencies=[${lats.join(',')}]`)

    // 4c: an idle-open EXPLICIT transaction DOES block other clients (this is the
    // serialization that makes RLS BEGIN;SET LOCAL;...;COMMIT atomic).
    const a = new pg.Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
    const b = new pg.Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
    await a.connect()
    await b.connect()
    await a.query('BEGIN')
    await a.query('select 1') // transaction now OPEN and IDLE
    let blocked = false
    try { await withTimeout(b.query('select 42'), 1500) } catch { blocked = true }
    if (blocked) ok('idle-open EXPLICIT transaction BLOCKS other clients until COMMIT (the RLS-isolation guarantee)')
    else fail('idle-open explicit transaction did NOT block another client (transaction isolation broken)')
    await a.query('COMMIT')
    const after = await withTimeout(b.query('select 43 as v'), 2000).catch(() => null)
    if (after && after.rows?.[0]?.v === 43) ok('other client unblocks immediately after COMMIT')
    else fail('client did not unblock after COMMIT')
    await direct.end().catch(() => {})
    await a.end().catch(() => {})
    await b.end().catch(() => {})
  }
} catch (e) {
  fail(`unexpected: ${e && e.stack ? e.stack : String(e)}`)
} finally {
  if (usingDocker) await execFile('docker', ['rm', '-f', CONTAINER]).catch(() => {})
  await wire.stop().catch(() => {})
}

console.log(failed ? `\n[killswitch-pgmeta] RESULT: FAIL (${failed})` : '\n[killswitch-pgmeta] RESULT: PASS')
process.exit(failed ? 1 : 0)
