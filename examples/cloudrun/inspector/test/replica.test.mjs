// Replica open path against a real bucket: /open/<target> -> 302 into Adminer
// -> the loopback wire answers SQL. Needs ADC that can read the fleet bucket
// (gcloud on this VM / runtime SA on Cloud Run) and live discovery.
// Run from the repo root:  node examples/cloudrun/inspector/test/replica.test.mjs
//
// The Adminer sidecar is not running here, so the /db/ proxy 502s - the test
// asserts the redirect SHAPE and then talks to the wire directly with pg.

import { spawn } from 'node:child_process'
import assert from 'node:assert'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../../../package.json', import.meta.url))
const { Client } = require('pg')

const ROOT = new URL('../../../../', import.meta.url).pathname
const TOKEN = 'test-token-replica'
const TARGET = process.env.REPLICA_TEST_TARGET || 'supabase-zeropg'
const PORT = 48613
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok ${passed} - ${name}`)
}

// detached: teardown kills the whole process group (npx wraps tsx wraps node).
const child = spawn('npx', ['tsx', 'packages/cli/src/zeropg.ts', 'console', '--inspector'], {
  cwd: ROOT,
  env: { ...process.env, INSPECTOR_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

try {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${BASE}/livez`)).ok) break
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`inspector did not come up; output:\n${out}`)
    await new Promise((r) => setTimeout(r, 200))
  }

  // landing lists the target from LIVE discovery
  const landing = await (await fetch(`${BASE}/`, { headers: { cookie: `zpt=${TOKEN}` } })).text()
  assert(landing.includes(TARGET), `landing must list ${TARGET} via live discovery; got:\n${landing.slice(0, 500)}`)
  ok(`landing lists ${TARGET} from live discovery`)

  // /open/<target> materializes a replica and 302s into Adminer with the wire port
  const r = await fetch(`${BASE}/open/${TARGET}`, { headers: { cookie: `zpt=${TOKEN}` }, redirect: 'manual' })
  assert.strictEqual(r.status, 302, `expected 302 from /open, got ${r.status}: ${await r.text()}`)
  const loc = r.headers.get('location')
  const m = /^\/db\/\?pgsql=127\.0\.0\.1%3A(\d+)&username=postgres&db=postgres$/.exec(loc)
  assert(m, `redirect must point into /db/ with the wire address, got: ${loc}`)
  const wirePort = Number(m[1])
  ok(`/open/${TARGET} -> 302 into /db/ with wire :${wirePort}`)

  // the wire answers SQL (this IS the replica: a detached bucket snapshot)
  const pg = new Client({ host: '127.0.0.1', port: wirePort, user: 'postgres', database: 'postgres' })
  await pg.connect()
  const one = await pg.query('SELECT 1 AS one')
  assert.strictEqual(one.rows[0].one, 1)
  const tables = await pg.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
  assert(tables.rows[0].n > 0, 'snapshot must contain user tables')
  await pg.end()
  ok(`wire answers SQL; snapshot has ${tables.rows[0].n} user tables`)

  // idempotent: re-open returns the same wire (LRU manager keyed by name)
  const r2 = await fetch(`${BASE}/open/${TARGET}`, { headers: { cookie: `zpt=${TOKEN}` }, redirect: 'manual' })
  assert.strictEqual(r2.headers.get('location'), loc)
  ok('re-open reuses the same replica wire (manager is keyed)')

  // unknown target is a clean error, not a crash
  const rBad = await fetch(`${BASE}/open/does-not-exist`, { headers: { cookie: `zpt=${TOKEN}` }, redirect: 'manual' })
  assert.strictEqual(rBad.status, 500)
  assert.match(await rBad.text(), /unknown target/)
  ok('unknown target answers a clean error')

  console.log(`\nreplica.test.mjs: all ${passed} checks passed`)
} finally {
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig)
    } catch {
      /* already gone */
    }
  }
  killGroup('SIGTERM')
  await new Promise((r) => {
    const t = setTimeout(() => {
      killGroup('SIGKILL')
      r()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(t)
      r()
    })
  })
}
process.exit(0)
