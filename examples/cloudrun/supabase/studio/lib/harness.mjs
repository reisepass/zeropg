// Local bring-up for zeropg Console: ONE call boots
//   (1) a local single-session zeropg wire (serveWire, no GCS - the shared
//       session, not persistence, is what the studio must be correct against),
//   (2) supabase/postgres-meta:v0.96.6 in Docker pointed at that wire
//       (sslmode=disable, pool stays max:1, PG_QUERY_TIMEOUT_SECS low), and
//   (3) the studio BFF (server.mjs) in-process-spawned.
//
// Used by up-local.mjs (keep alive) and test/run.mjs (boot once, run specs).
// Ports default to 5499 (wire) / 4322 (pg-meta) / 4321 (BFF), all overridable,
// and deliberately avoid the dev-stack ranges (3101-3104, 5461-5464, 54321+).

import { serveWire } from '@zeropg/client'
import pg from 'pg'
import { spawn, execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const execFile = promisify(_execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

export const DEFAULTS = {
  wirePort: Number(process.env.STUDIO_WIRE_PORT || 5499),
  metaPort: Number(process.env.STUDIO_META_PORT || 4322),
  bffPort: Number(process.env.STUDIO_PORT || 4321),
  metaImage: process.env.PG_META_IMAGE || 'supabase/postgres-meta:v0.96.6',
  adminPassword: process.env.STUDIO_ADMIN_PASSWORD || 'studio-admin-pw-123',
  sessionSecret: process.env.STUDIO_SESSION_SECRET || 'test-session-secret-please-change-0123456789',
  queryTimeoutSecs: Number(process.env.STUDIO_QUERY_TIMEOUT_SECS || 20),
}

// Public connection values surfaced by the connection modal (known to tests).
export const CONN = {
  rest: 'http://127.0.0.1:4321/rest/v1',
  auth: 'http://127.0.0.1:4321/auth/v1',
  anonKey: 'anon.eyJyb2xlIjoiYW5vbiJ9.zeropg-anon-signature-value',
  serviceKey: 'service.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.zeropg-service-signature-value',
  jwtSecret: 'super-secret-jwt-token-with-at-least-32-characters-long',
  dbUrl: 'postgres://postgres@127.0.0.1:5499/postgres?sslmode=disable',
}

function waitHttp(url, pred, ms = 60_000) {
  const t0 = Date.now()
  return (async () => {
    while (Date.now() - t0 < ms) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (await pred(r)) return true } catch {}
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  })()
}

export async function bringUp(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const container = `studio-uplocal-${process.pid}`
  const cleanups = []
  const log = opts.log || ((m) => console.log(m))

  // 1. wire (or adopt one the caller already runs, e.g. zeropg console serving
  //    a local datadir / a bucket replica - it must be reachable from Docker,
  //    i.e. bound to 0.0.0.0, since pg-meta dials host.docker.internal)
  let wire = null
  if (opts.existingWire) {
    log(`[harness] using existing wire on :${cfg.wirePort}`)
  } else {
    // 0.0.0.0 only for the docker meta (host.docker.internal cannot reach a
    // 127.0.0.1-bound host port on macOS); the node meta keeps loopback.
    wire = await serveWire({ host: opts.metaMode === 'docker' ? '0.0.0.0' : '127.0.0.1', port: cfg.wirePort })
    cleanups.push(() => wire.stop().catch(() => {}))
    if (opts.seed) await wire.pglite.exec(opts.seed)
    log(`[harness] wire up on :${cfg.wirePort}`)
  }

  // 2. postgres-meta. Default: a plain node child process - the npm package
  //    @supabase/postgres-meta ships the exact same fastify server as the
  //    Docker image (dist/server/server.js, same env contract), so no
  //    container runtime is needed and everything stays on loopback.
  //    metaMode: 'docker' keeps the old container path for parity testing.
  const metaBase = `http://127.0.0.1:${cfg.metaPort}`
  if (opts.metaMode === 'docker') {
    await execFile('docker', ['rm', '-f', container]).catch(() => {})
    await execFile('docker', [
      'run', '--rm', '-d', '--name', container,
      '-p', `${cfg.metaPort}:8080`,
      '-e', 'PG_META_PORT=8080',
      '-e', `PG_META_DB_URL=postgresql://postgres:postgres@host.docker.internal:${cfg.wirePort}/postgres?sslmode=disable`,
      '-e', `PG_QUERY_TIMEOUT_SECS=${cfg.queryTimeoutSecs}`,
      cfg.metaImage,
    ])
    cleanups.unshift(() => execFile('docker', ['rm', '-f', container]).catch(() => {}))
    if (!(await waitHttp(`${metaBase}/health`, (r) => r.ok, 45_000))) {
      const logs = await execFile('docker', ['logs', container]).catch(() => ({ stdout: '', stderr: '' }))
      await teardown(cleanups)
      throw new Error(`postgres-meta never healthy\n${logs.stdout}\n${logs.stderr}`)
    }
  } else {
    const require = createRequire(import.meta.url)
    let serverJs
    try {
      serverJs = join(dirname(require.resolve('@supabase/postgres-meta/package.json')), 'dist', 'server', 'server.js')
    } catch {
      throw new Error('postgres-meta not installed: npm i -D @supabase/postgres-meta (or pass metaMode: "docker")')
    }
    const meta = spawn('node', [serverJs], {
      env: {
        ...process.env,
        PG_META_HOST: '127.0.0.1',
        PG_META_PORT: String(cfg.metaPort),
        PG_META_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${cfg.wirePort}/postgres?sslmode=disable`,
        PG_QUERY_TIMEOUT_SECS: String(cfg.queryTimeoutSecs),
      },
      stdio: opts.quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'],
    })
    cleanups.unshift(() => { try { meta.kill('SIGKILL') } catch {} })
    if (!(await waitHttp(`${metaBase}/health`, (r) => r.ok, 30_000))) {
      await teardown(cleanups)
      throw new Error('postgres-meta (node) never became healthy')
    }
  }
  log(`[harness] postgres-meta healthy on :${cfg.metaPort}`)

  // 3. BFF
  const bff = spawn('node', [join(root, 'server.mjs')], {
    env: {
      ...process.env,
      STUDIO_PORT: String(cfg.bffPort),
      PG_META_URL: metaBase,
      STUDIO_SESSION_SECRET: cfg.sessionSecret,
      STUDIO_ADMIN_PASSWORD: cfg.adminPassword,
      STUDIO_QUERY_TIMEOUT_SECS: String(cfg.queryTimeoutSecs),
      STUDIO_REST_URL: CONN.rest,
      STUDIO_AUTH_URL: CONN.auth,
      STUDIO_ANON_KEY: CONN.anonKey,
      STUDIO_SERVICE_KEY: CONN.serviceKey,
      STUDIO_JWT_SECRET: CONN.jwtSecret,
      STUDIO_DB_URL: CONN.dbUrl,
    },
    stdio: opts.quiet ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'inherit', 'inherit'],
  })
  cleanups.unshift(() => { try { bff.kill('SIGKILL') } catch {} })
  const base = `http://127.0.0.1:${cfg.bffPort}`
  if (!(await waitHttp(`${base}/healthz`, (r) => r.ok, 30_000))) { await teardown(cleanups); throw new Error('BFF never became healthy') }
  log(`[harness] BFF healthy on :${cfg.bffPort}`)

  // 4. direct wire client for seeding + wait for studio bootstrap to complete
  const db = new pg.Client({ host: '127.0.0.1', port: cfg.wirePort, user: 'postgres', database: 'postgres', ssl: false })
  await db.connect()
  cleanups.unshift(() => db.end().catch(() => {}))
  const ready = await waitFor(async () => (await db.query("SELECT to_regclass('studio.queries') AS t")).rows[0].t !== null, 20_000)
  if (!ready) { await teardown(cleanups); throw new Error('studio bootstrap did not complete') }
  log(`[harness] studio schema bootstrapped`)

  const sql = (text, params) => db.query(text, params)

  return {
    base, metaBase, cfg, wire, db, sql,
    async stop() { await teardown(cleanups) },
  }
}

async function waitFor(pred, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await pred()) return true } catch {} await new Promise((r) => setTimeout(r, 300)) }
  return false
}
async function teardown(cleanups) { for (const c of cleanups) { try { await c() } catch {} } }
