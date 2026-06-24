// Full-stack LOCAL integration: db sidecar (host node) + GoTrue (docker) +
// frontend ingress (host node), then asserts the end-to-end supabase-js flow over
// HTTP exactly as the browser will: /api/config -> signup -> login -> RLS todos.
//
// Runs the db sidecar and frontend in-process (the host has gcloud for GCS auth);
// GoTrue runs as the real container against the host wire. This mirrors the Cloud
// Run multi-container layout (shared localhost) closely enough to catch wiring
// bugs before deploy. A separate Playwright test drives the actual browser UI.
//
//   PGRST_BIN=$(cat /tmp/pgrst_path.txt) node examples/cloudrun/supabase/test/integration-local.mjs

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const PREFIX = process.env.ZEROPG_PREFIX || `integration-${Date.now()}`
const CTRL = 8081, WIRE = 5432, REST = 3000, GOTRUE = 9999, FRONT = 8080
const PGRST_BIN = process.env.PGRST_BIN || 'postgrest'
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const DB_HOST_FOR_CONTAINER = 'zeropg-wire'
const CONTAINER = `supabase-it-auth-${process.pid}`

const fail = (m) => { console.error(`  FAIL ${m}`); process.exitCode = 1 }
const ok = (m) => console.log(`  ok   ${m}`)

const procs = []
async function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
  await execFileP('docker', ['rm', '-f', CONTAINER]).catch(() => {})
}
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL') } catch {} } })

function waitHttp(url, pred, ms = 90_000) {
  const t0 = Date.now()
  return (async () => {
    while (Date.now() - t0 < ms) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (await pred(r)) return true } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  })()
}

try {
  // 1. db sidecar (host node) with bootstrap + in-process PostgREST.
  const dbEnv = {
    ...process.env,
    ZEROPG_BUCKET: process.env.ZEROPG_BUCKET || 'zeropg-experiments-euw1',
    ZEROPG_PREFIX: PREFIX,
    PORT: String(CTRL), ZEROPG_WIRE_PORT: String(WIRE), ZEROPG_REST_PORT: String(REST),
    ZEROPG_POSTGREST_BIN: PGRST_BIN,
    PGRST_JWT_SECRET: JWT_SECRET,
    // bind wire on 0.0.0.0 so the GoTrue container reaches it via host-gateway
    ZEROPG_WIRE_HOST: '0.0.0.0',
  }
  const db = spawn('node', [join(root, 'zeropg-db', 'server.mjs')], { env: dbEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(db)
  db.stdout.on('data', (b) => process.stdout.write(`[db] ${b}`))
  db.stderr.on('data', (b) => process.stdout.write(`[db] ${b}`))
  if (!(await waitHttp(`http://127.0.0.1:${CTRL}/ready`, async (r) => (await r.json()).ready))) {
    fail('db sidecar never ready'); throw new Error('db not ready')
  }
  ok('db sidecar ready (bootstrap applied, PostgREST up, search_path set)')

  // 2. GoTrue container against the host wire.
  const dbUrl = `postgres://postgres@${DB_HOST_FOR_CONTAINER}:${WIRE}/postgres?sslmode=disable&statement_cache_mode=describe`
  await execFileP('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-p', `${GOTRUE}:9999`,
    '--add-host', `${DB_HOST_FOR_CONTAINER}:host-gateway`,
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999',
    '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', `GOTRUE_DB_DATABASE_URL=${dbUrl}`,
    '-e', 'GOTRUE_SITE_URL=http://localhost:8080', '-e', `API_EXTERNAL_URL=http://localhost:${GOTRUE}`,
    '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
    '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role', '-e', `GOTRUE_JWT_SECRET=${JWT_SECRET}`,
    '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_DISABLE_SIGNUP=false',
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_LOG_LEVEL=warn',
    'supabase/gotrue:v2.189.0',
  ])
  if (!(await waitHttp(`http://127.0.0.1:${GOTRUE}/health`, async (r) => r.ok))) {
    const { stdout } = await execFileP('docker', ['logs', CONTAINER]).catch(() => ({ stdout: '' }))
    console.log(stdout.split('\n').slice(-10).join('\n'))
    fail('GoTrue never healthy'); throw new Error('gotrue not ready')
  }
  ok('GoTrue healthy (migrations applied over the wire)')

  // 3. frontend ingress (host node).
  const fe = spawn('node', [join(root, 'frontend', 'server.mjs')], {
    env: { ...process.env, PORT: String(FRONT), ZEROPG_DB_CONTROL: `http://127.0.0.1:${CTRL}`, GOTRUE_URL: `http://127.0.0.1:${GOTRUE}`, SUPABASE_JWT_SECRET: JWT_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(fe)
  fe.stdout.on('data', (b) => process.stdout.write(`[fe] ${b}`))
  fe.stderr.on('data', (b) => process.stdout.write(`[fe] ${b}`))
  if (!(await waitHttp(`http://127.0.0.1:${FRONT}/healthz`, async (r) => r.ok))) { fail('frontend never up'); throw new Error('fe') }
  ok('frontend ingress up')

  const base = `http://127.0.0.1:${FRONT}`
  // /api/config gives anon key + url
  const cfg = await (await fetch(`${base}/api/config`)).json()
  if (cfg.anonKey && cfg.url) ok('/api/config returns anon key + url')
  else fail(`/api/config bad: ${JSON.stringify(cfg)}`)
  const rdy = await (await fetch(`${base}/api/ready`)).json()
  if (rdy.ready) ok('/api/ready reports db+auth up')
  else fail(`/api/ready not ready: ${JSON.stringify(rdy)}`)

  // Emulate supabase-js over the Kong-style proxy: signup via /auth/v1, query via /rest/v1.
  const email = `it-${Date.now()}@example.com`, password = 'Sup3rSecret!pw'
  const su = await fetch(`${base}/auth/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: cfg.anonKey }, body: JSON.stringify({ email, password }) })
  const suBody = await su.json()
  const jwtA = suBody.access_token
  if (su.status === 200 && jwtA) ok('signup via /auth/v1 -> JWT')
  else fail(`signup failed: ${su.status} ${JSON.stringify(suBody)}`)

  // insert a todo as the user (RLS: user_id defaults to auth.uid()).
  const ins = await fetch(`${base}/rest/v1/todos`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${jwtA}`, apikey: cfg.anonKey, Prefer: 'return=representation' },
    body: JSON.stringify({ task: 'integration task' }),
  })
  const insBody = await ins.json()
  if (ins.status === 201 && insBody[0]?.task === 'integration task') ok('insert todo via /rest/v1 (RLS, user_id auto = auth.uid())')
  else fail(`insert failed: ${ins.status} ${JSON.stringify(insBody)}`)

  // read back as the user — sees own row.
  const mine = await (await fetch(`${base}/rest/v1/todos?select=task,done`, { headers: { Authorization: `Bearer ${jwtA}`, apikey: cfg.anonKey } })).json()
  if (Array.isArray(mine) && mine.length === 1 && mine[0].task === 'integration task') ok('read todos as user -> own row')
  else fail(`read-back wrong: ${JSON.stringify(mine)}`)

  // second user cannot see the first user's row (RLS isolation through the proxy).
  const email2 = `it2-${Date.now()}@example.com`
  const su2 = await (await fetch(`${base}/auth/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: cfg.anonKey }, body: JSON.stringify({ email: email2, password }) })).json()
  const userB = await (await fetch(`${base}/rest/v1/todos?select=task`, { headers: { Authorization: `Bearer ${su2.access_token}`, apikey: cfg.anonKey } })).json()
  if (Array.isArray(userB) && userB.length === 0) ok('second user sees ZERO rows (RLS isolation end to end)')
  else fail(`RLS leak: user B saw ${JSON.stringify(userB)}`)
} catch (e) {
  fail(String(e))
} finally {
  await cleanup()
}

console.log(process.exitCode ? '\n[integration-local] RESULT: FAIL' : '\n[integration-local] RESULT: PASS')
process.exit(process.exitCode || 0)
