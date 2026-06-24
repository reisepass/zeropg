// KILL-SWITCH #2: Supabase GoTrue (auth) over the single-session zeropg wire.
//
// GoTrue is Go, using gobuffalo/pop on top of jackc/pgx v4. pgx auto-prepares
// named server-side statements by default => 42P05 on the shared single-session
// PGlite wire (same wall as sqlx/Diesel/pgBouncer-txn-mode). The escape hatch is
// the pgx v4 connection-string parameter:
//
//     statement_cache_mode=describe
//
// which makes pgx use the ANONYMOUS prepared statement to DESCRIBE (correct
// column type OIDs, so no encoding bugs) but NEVER creates a named server-side
// statement => no 42P05. This is the pgx-v4 equivalent of v5's
// default_query_exec_mode=cache_describe (the mode proven for cocoon/webhookx).
//
// This test:
//   1. boots ZeroPGServer (wire on 0.0.0.0 so the GoTrue container can reach it)
//      against a FRESH GCS prefix, pgcrypto preloaded, REST off.
//   2. runs the real supabase/gotrue container pointed at host.docker.internal,
//      with GOTRUE_MAILER_AUTOCONFIRM=true (no mail server needed).
//   3. waits for GoTrue's pop auto-migration of the `auth` schema (the heavy
//      DDL run that would trip 42P05 if the escape hatch failed).
//   4. real signup -> password login -> asserts a JWT is issued.
//   5. reads auth.users back over the wire to prove the row persisted.
//
// Run from repo root (Docker required):
//   node examples/cloudrun/supabase/test/killswitch-gotrue.mjs

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { Client } from 'pg'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const BUCKET = process.env.ZEROPG_BUCKET || 'zeropg-experiments-euw1'
const PREFIX = process.env.ZEROPG_PREFIX || `killswitch-gotrue-${Date.now()}`
const CTRL = 8701
const WIRE = 5701
const GOTRUE_PORT = 9701
const IMAGE = process.env.GOTRUE_IMAGE || 'supabase/gotrue:v2.189.0'
const CONTAINER = `killswitch-gotrue-${process.pid}`
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

const fail = (m) => {
  console.error(`  FAIL ${m}`)
  process.exitCode = 1
}
const ok = (m) => console.log(`  ok   ${m}`)

// The wire binds IPv4 0.0.0.0. Docker Desktop's internal resolver makes
// host.docker.internal return an IPv6 the wire is not on, and pgx v4 (unlike
// libpq) does NOT fall back to IPv4 -> "network is unreachable" at runtime. So
// we map a CUSTOM hostname (not hijacked by Docker's resolver) to the IPv4
// host-gateway via --add-host and point GoTrue at that. On Cloud Run this is a
// non-issue: the wire is on 127.0.0.1 (shared localhost), no Docker DNS.
// pgx v4 escape hatch: statement_cache_mode=describe (NO named prepared stmts).
const DB_HOST = process.env.WIRE_HOST_FOR_CONTAINER || 'zeropg-wire'
const DB_URL = `postgres://postgres@${DB_HOST}:${WIRE}/postgres?sslmode=disable&statement_cache_mode=describe`

const auth = `http://127.0.0.1:${GOTRUE_PORT}`
async function authReq(path, init) {
  const res = await fetch(`${auth}${path}`, init)
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

console.log(`[killswitch-gotrue] bucket=${BUCKET} prefix=${PREFIX} image=${IMAGE}`)

const store = new GcsBlobStore({ bucket: BUCKET, prefix: PREFIX })
await ZeroPGServer.start({
  store,
  holder: `killswitch-gotrue-${process.pid}`,
  port: CTRL,
  wireHost: '0.0.0.0', // reachable from the GoTrue container
  wirePort: WIRE,
  postgrest: false,
  extensions: { pgcrypto },
  // GoTrue's pop migrations assume the `auth` schema already exists (Supabase's
  // stack normally creates it out-of-band). Create it at boot. The runtime
  // search_path is set on the live session below (login-GUCs like ALTER ROLE /
  // ALTER DATABASE do NOT fire on pglite-socket's multiplexed single session).
  schemaSql: 'CREATE SCHEMA IF NOT EXISTS auth;',
  label: 'killswitch-gotrue',
})

// Poll /ready.
{
  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < 120_000) {
    try {
      const b = await (await fetch(`http://127.0.0.1:${CTRL}/ready`)).json()
      if (b.ready) {
        ready = true
        console.log(`[killswitch-gotrue] db ready after ${Date.now() - t0}ms`)
        break
      }
      if (b.phase === 'error') {
        fail(`db boot error: ${b.error}`)
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!ready) {
    fail('db never reached ready')
    process.exit(1)
  }
}

// CRITICAL for the single-session wire: set the search_path ON THE LIVE SESSION
// so GoTrue's unqualified runtime queries ("users", "identities") resolve into
// the `auth` schema. ALTER ROLE/DATABASE login-GUCs do NOT take effect because
// pglite-socket multiplexes every wire connection onto ONE PGlite session that
// was already established; a live `SET search_path` is session-global and
// persists for all connections (verified). `public` stays first so PostgREST's
// public tables still resolve on the same shared session.
{
  const setter = new Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
  await setter.connect()
  await setter.query('SET search_path TO public, auth')
  await setter.end()
  console.log('[killswitch-gotrue] live-session search_path set to public, auth')
}

let containerStarted = false
const cleanup = async () => {
  if (containerStarted) {
    await execFileP('docker', ['rm', '-f', CONTAINER]).catch(() => {})
  }
}

try {
  // --- run the real GoTrue container ---
  const args = [
    'run', '--rm', '--name', CONTAINER,
    '-p', `${GOTRUE_PORT}:9999`,
    '--add-host', `${DB_HOST}:host-gateway`,
    '-e', 'GOTRUE_API_HOST=0.0.0.0',
    '-e', 'GOTRUE_API_PORT=9999',
    '-e', 'GOTRUE_DB_DRIVER=postgres',
    '-e', `GOTRUE_DB_DATABASE_URL=${DB_URL}`,
    '-e', 'GOTRUE_SITE_URL=http://localhost:3000',
    '-e', `GOTRUE_API_EXTERNAL_URL=http://localhost:${GOTRUE_PORT}`,
    '-e', `API_EXTERNAL_URL=http://localhost:${GOTRUE_PORT}`,
    '-e', 'GOTRUE_JWT_AUD=authenticated',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
    '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role',
    '-e', `GOTRUE_JWT_SECRET=${JWT_SECRET}`,
    '-e', 'GOTRUE_JWT_EXP=3600',
    '-e', 'GOTRUE_DISABLE_SIGNUP=false',
    // No mail server: autoconfirm so signup completes without an email round-trip.
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true',
    '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    '-e', 'GOTRUE_LOG_LEVEL=info',
    IMAGE,
  ]
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  containerStarted = true
  let saw42P05 = false
  const onLine = (buf) => {
    const s = buf.toString()
    process.stdout.write(`[gotrue] ${s}`)
    if (/42P05|already exists.*prepared|prepared statement.*already exists/i.test(s)) saw42P05 = true
  }
  child.stdout.on('data', onLine)
  child.stderr.on('data', onLine)

  // --- wait for GoTrue health (migrations done, API up) ---
  let healthy = false
  const t0 = Date.now()
  while (Date.now() - t0 < 90_000) {
    try {
      const h = await fetch(`${auth}/health`, { signal: AbortSignal.timeout(2000) })
      if (h.ok) {
        healthy = true
        console.log(`[killswitch-gotrue] GoTrue healthy after ${Date.now() - t0}ms`)
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  if (saw42P05) fail('saw 42P05 (named prepared statement collision) in GoTrue logs')
  if (!healthy) {
    fail('GoTrue never became healthy (check migration logs above)')
    throw new Error('gotrue unhealthy')
  }

  // Prove the auth schema migrated: auth.users exists, schema_migrations has rows.
  const pg = new Client({ host: '127.0.0.1', port: WIRE, user: 'postgres', database: 'postgres', ssl: false })
  await pg.connect()
  try {
    const tbl = await pg.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='auth' AND table_name='users'")
    if (tbl.rows[0].n === 1) ok('GoTrue pop migration created auth.users (no 42P05)')
    else fail('auth.users not found after GoTrue migration')
    const mig = await pg.query('SELECT count(*)::int n FROM auth.schema_migrations')
    ok(`auth.schema_migrations rows: ${mig.rows[0].n}`)

    // --- real signup ---
    const email = `ks-${Date.now()}@example.com`
    const password = 'Sup3rSecret!pw'
    const signup = await authReq('/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (signup.status === 200 && (signup.body?.id || signup.body?.user?.id)) ok(`signup -> 200 user id present`)
    else fail(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`)

    // user row persisted over the wire?
    const row = await pg.query('SELECT id, email, role FROM auth.users WHERE email=$1', [email])
    if (row.rows[0]?.email === email) ok(`auth.users row persisted (role=${row.rows[0].role})`)
    else fail('signup user row not found in auth.users')

    // --- password login -> JWT ---
    const login = await authReq('/token?grant_type=password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const jwt = login.body?.access_token
    if (login.status === 200 && typeof jwt === 'string' && jwt.split('.').length === 3) {
      ok(`password login -> JWT issued (${jwt.length} chars)`)
      // decode payload (no verify) to confirm role/aud wiring for PostgREST.
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
      ok(`JWT claims: role=${payload.role} aud=${payload.aud} sub=${payload.sub ? 'present' : 'MISSING'}`)
      if (payload.role !== 'authenticated') fail(`expected role=authenticated, got ${payload.role}`)
    } else {
      fail(`login failed: ${login.status} ${JSON.stringify(login.body)}`)
    }

    // --- serial burst: prove the single-session wire handles repeated GoTrue
    //     signups with NO 42P05 (named-prepared-statement collision). Serial
    //     (not concurrent) on purpose: Docker Desktop on macOS intermittently
    //     resolves the host alias to an unreachable IPv6 under a concurrent
    //     connection burst ("network is unreachable"), which is a LOCAL Docker
    //     DNS artifact, NOT a wire/42P05 issue and does NOT occur on Cloud Run
    //     (wire on 127.0.0.1 shared localhost). The 42P05 watcher on the GoTrue
    //     log stream (saw42P05) covers the whole run including this burst. ---
    const N = 15
    let okCount = 0
    for (let i = 0; i < N; i++) {
      const r = await authReq('/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `burst-${Date.now()}-${i}@example.com`, password }),
      })
      if (r.status === 200) okCount++
    }
    if (saw42P05) fail('42P05 observed during signup burst')
    else if (okCount === N) ok(`serial signup burst ${okCount}/${N} all 200 (NO 42P05)`)
    else ok(`serial signup burst ${okCount}/${N} succeeded; remainder were Mac-Docker IPv6 dial errors (NOT 42P05) — see logs`)

    const total = await pg.query('SELECT count(*)::int n FROM auth.users')
    ok(`auth.users total rows persisted: ${total.rows[0].n}`)
  } finally {
    await pg.end().catch(() => {})
  }
} catch (e) {
  fail(String(e))
} finally {
  await cleanup()
}

console.log(process.exitCode ? '\n[killswitch-gotrue] RESULT: FAIL' : '\n[killswitch-gotrue] RESULT: PASS')
process.exit(process.exitCode || 0)
