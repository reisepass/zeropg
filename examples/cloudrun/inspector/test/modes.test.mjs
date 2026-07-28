// Console trust-mode tests: structural pruning, token gate, both surfaces up.
// Run from the repo root:  node examples/cloudrun/inspector/test/modes.test.mjs
//
// Spawns the real CLI (tsx) in both modes and asserts over HTTP - no mocks.
// The replica open path (needs bucket access) lives in replica.test.mjs.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import assert from 'node:assert'

const ROOT = new URL('../../../../', import.meta.url).pathname
const CLI = 'packages/cli/src/zeropg.ts'
const TOKEN = 'test-token-abc123'

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok ${passed} - ${name}`)
}

function startCli(args, env) {
  // detached: npx/tsx wrap the real node process, so tear down the whole
  // process group - killing only the wrapper orphans the server (and the
  // orphan's stdout pipe would keep this test process alive forever).
  const child = spawn('npx', ['tsx', CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  return { child, output: () => out }
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`server at ${url} did not come up in ${timeoutMs}ms`)
}

async function stop(child) {
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

// ---- 0. structural pruning is grep-provable in the source -------------------
{
  const src = readFileSync(`${ROOT}packages/cli/src/console/inspector.ts`, 'utf8')
  // Actual code references (imports/calls), not prose in comments.
  const code = src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  for (const forbidden of ['./serve.js', 'localdbs', 'probe.js', 'serveLocal', 'serveReplica', 'launchStudio', 'wakeAndWait', 'listLocalDbs']) {
    assert(!code.includes(forbidden), `inspector.ts code must not reference ${forbidden}`)
  }
  ok('inspector.ts has no import of serve/localdbs/probe machinery (structural pruning)')
}

// ---- 1. inspector refuses to start without INSPECTOR_TOKEN ------------------
{
  const { child, output } = startCli(['console', '--inspector'], { INSPECTOR_TOKEN: '' })
  const code = await new Promise((r) => child.once('exit', r))
  assert.notStrictEqual(code, 0, 'must exit non-zero')
  assert.match(output(), /INSPECTOR_TOKEN is required/)
  ok('inspector refuses to start without INSPECTOR_TOKEN')
}

// ---- 2. inspector mode: token gate + pruned routes ---------------------------
{
  const port = 48611
  const base = `http://127.0.0.1:${port}`
  const { child } = startCli(['console', '--inspector'], { INSPECTOR_TOKEN: TOKEN, PORT: String(port) })
  try {
    await waitFor(`${base}/livez`)

    // livez needs no token (startup probe)
    assert.strictEqual((await fetch(`${base}/livez`)).status, 200)
    ok('livez answers without a token')

    // 403 without token, exact text preserved from the old server.mjs
    const r403 = await fetch(base)
    assert.strictEqual(r403.status, 403)
    assert.match(await r403.text(), /missing or wrong token - open the link your fleet console gave you/)
    ok('403 without token (exact text)')

    assert.strictEqual((await fetch(`${base}/?t=wrong`)).status, 403)
    ok('403 with a wrong token')

    // ?t= once -> 302 + zpt cookie, token stripped from the URL
    const r302 = await fetch(`${base}/open/x?t=${TOKEN}&foo=1`, { redirect: 'manual' })
    assert.strictEqual(r302.status, 302)
    const cookie = r302.headers.get('set-cookie')
    assert.match(cookie, /zpt=test-token-abc123/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /Secure/)
    assert.match(cookie, /SameSite=Lax/)
    assert.strictEqual(r302.headers.get('location'), '/open/x?foo=1')
    ok('?t= -> 302, zpt cookie (HttpOnly/Secure/SameSite=Lax), token stripped from URL')

    // cookie path works
    const rCookie = await fetch(base, { headers: { cookie: `zpt=${TOKEN}` } })
    assert.strictEqual(rCookie.status, 200)
    assert.match(await rCookie.text(), /zeropg inspector/)
    ok('zpt cookie grants access')

    // pruned routes: the console's write/wake/export/local/studio API does not exist
    for (const path of ['/api/serve', '/api/wake', '/api/studio/launch', '/api/local', '/api/fleet', '/api/unserve', '/api/editor/pgweb']) {
      for (const method of ['GET', 'POST']) {
        const r = await fetch(`${base}${path}`, { method, headers: { cookie: `zpt=${TOKEN}` } })
        assert.strictEqual(r.status, 404, `${method} ${path} must be 404 in inspector mode, got ${r.status}`)
      }
    }
    ok('write/wake/export/local/studio routes are 404 in inspector mode')
  } finally {
    await stop(child)
  }
}

// ---- 3. normal mode: those routes exist, no auth, loopback ------------------
{
  const port = 48612
  const base = `http://127.0.0.1:${port}`
  const { child } = startCli(['console', '--port', String(port)], {})
  try {
    await waitFor(base)

    assert.strictEqual((await fetch(base)).status, 200)
    ok('normal console serves the landing page with no token')

    // /api/local is registered and answers
    const rLocal = await fetch(`${base}/api/local`)
    assert.strictEqual(rLocal.status, 200)
    assert('dbs' in (await rLocal.json()))
    ok('normal console serves /api/local')

    // registered-but-invalid input answers 400, NOT 404 - proves the handler exists
    const rServe = await fetch(`${base}/api/serve`, { method: 'POST', body: '{}' })
    assert.strictEqual(rServe.status, 400)
    const rWake = await fetch(`${base}/api/wake`, { method: 'POST' })
    assert.strictEqual(rWake.status, 400)
    const rStudio = await fetch(`${base}/api/studio/launch`, { method: 'POST', body: '{}' })
    assert.strictEqual(rStudio.status, 400)
    ok('normal console registers /api/serve, /api/wake, /api/studio/launch (400 on bad input, not 404)')

    // inspector's token endpoints do not exist here
    assert.strictEqual((await fetch(`${base}/livez`)).status, 404)
    ok('normal console has no /livez (modes do not bleed into each other)')
  } finally {
    await stop(child)
  }
}

console.log(`\nmodes.test.mjs: all ${passed} checks passed`)
process.exit(0)
