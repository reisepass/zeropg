// Bring the full stack up LOCALLY and keep it running (db sidecar + GoTrue
// container + frontend ingress), for Playwright/manual testing. Prints the URL
// and stays in the foreground until SIGINT. Same wiring as integration-local.mjs.
//
//   PGRST_BIN=$(cat /tmp/pgrst_path.txt) node examples/cloudrun/supabase/test/up-local.mjs

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const PREFIX = process.env.ZEROPG_PREFIX || `uplocal-${Date.now()}`
const CTRL = 8081, WIRE = 5432, REST = 3000, GOTRUE = 9999, FRONT = 8080
const PGRST_BIN = process.env.PGRST_BIN || 'postgrest'
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const DB_HOST_FOR_CONTAINER = 'zeropg-wire'
const CONTAINER = 'supabase-uplocal-auth'

const procs = []
async function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
  await execFileP('docker', ['rm', '-f', CONTAINER]).catch(() => {})
}
process.on('SIGINT', async () => { await cleanup(); process.exit(0) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(0) })

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

await execFileP('docker', ['rm', '-f', CONTAINER]).catch(() => {})

const dbEnv = {
  ...process.env,
  ZEROPG_BUCKET: process.env.ZEROPG_BUCKET || 'zeropg-experiments-euw1',
  ZEROPG_PREFIX: PREFIX, PORT: String(CTRL), ZEROPG_WIRE_PORT: String(WIRE), ZEROPG_REST_PORT: String(REST),
  ZEROPG_POSTGREST_BIN: PGRST_BIN, PGRST_JWT_SECRET: JWT_SECRET, ZEROPG_WIRE_HOST: '0.0.0.0',
}
const db = spawn('node', [join(root, 'zeropg-db', 'server.mjs')], { env: dbEnv, stdio: ['ignore', 'inherit', 'inherit'] })
procs.push(db)
if (!(await waitHttp(`http://127.0.0.1:${CTRL}/ready`, async (r) => (await r.json()).ready))) { console.error('db not ready'); await cleanup(); process.exit(1) }
console.log('[up] db ready')

const dbUrl = `postgres://postgres@${DB_HOST_FOR_CONTAINER}:${WIRE}/postgres?sslmode=disable&statement_cache_mode=describe`
await execFileP('docker', [
  'run', '--rm', '-d', '--name', CONTAINER, '-p', `${GOTRUE}:9999`, '--add-host', `${DB_HOST_FOR_CONTAINER}:host-gateway`,
  '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'GOTRUE_API_PORT=9999', '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', `GOTRUE_DB_DATABASE_URL=${dbUrl}`,
  '-e', 'GOTRUE_SITE_URL=http://localhost:8080', '-e', `API_EXTERNAL_URL=http://localhost:${GOTRUE}`,
  '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role',
  '-e', `GOTRUE_JWT_SECRET=${JWT_SECRET}`, '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_DISABLE_SIGNUP=false',
  '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true', '-e', 'GOTRUE_LOG_LEVEL=warn', 'supabase/gotrue:v2.189.0',
])
if (!(await waitHttp(`http://127.0.0.1:${GOTRUE}/health`, async (r) => r.ok))) { console.error('gotrue not ready'); await cleanup(); process.exit(1) }
console.log('[up] gotrue ready')

const fe = spawn('node', [join(root, 'frontend', 'server.mjs')], {
  env: { ...process.env, PORT: String(FRONT), ZEROPG_DB_CONTROL: `http://127.0.0.1:${CTRL}`, GOTRUE_URL: `http://127.0.0.1:${GOTRUE}`, SUPABASE_JWT_SECRET: JWT_SECRET },
  stdio: ['ignore', 'inherit', 'inherit'],
})
procs.push(fe)
if (!(await waitHttp(`http://127.0.0.1:${FRONT}/healthz`, async (r) => r.ok))) { console.error('fe not ready'); await cleanup(); process.exit(1) }
console.log(`\n[up] STACK READY -> http://127.0.0.1:${FRONT}\n`)

// keep alive
await new Promise(() => {})
