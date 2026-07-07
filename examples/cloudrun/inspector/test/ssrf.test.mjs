// Regression test for the /db proxy SSRF: stripping the /db prefix from a path
// that begins with a double slash used to leave a protocol-relative "//host"
// that new URL() resolved to a DIFFERENT authority (GCP metadata server ->
// service-account token theft). resolveUpstream must pin every proxied request
// to the intended upstream origin.
//
// Run from the repo root:  npx tsx examples/cloudrun/inspector/test/ssrf.test.mjs

import assert from 'node:assert'
import { resolveUpstream } from '../../../../packages/cli/src/console/inspector.ts'

const ADMINER = 'http://127.0.0.1:8081'
const PGWEB = 'http://127.0.0.1:9999'
let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok ${passed} - ${name}`)
}

// --- attacks: every one must NOT reach an off-upstream host ------------------
const attacks = [
  '/db//169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
  '/db///169.254.169.254/x',
  '/db//evil.com/x',
  '/db/%2F%2Fevil.com/x', // encoded slashes: pathname keeps %2F literally
  '/db//attacker@evil.com/x',
]
for (const path of attacks) {
  const u = new URL(path, 'http://localhost')
  const upstream = resolveUpstream(u.pathname, u.search, ADMINER, '/db')
  // Either refused (null) or safely pinned to the loopback Adminer host.
  const safe = upstream === null || upstream.host === '127.0.0.1:8081'
  assert(safe, `SSRF not contained for ${path}: host=${upstream && upstream.host}`)
}
ok('no /db path can redirect the proxy off the Adminer loopback origin')

// --- normal Adminer paths still resolve correctly ----------------------------
{
  const u = new URL('/db/?pgsql=127.0.0.1:6001&username=postgres&db=postgres&select=todos', 'http://localhost')
  const upstream = resolveUpstream(u.pathname, u.search, ADMINER, '/db')
  assert(upstream, 'normal /db path must resolve')
  assert.strictEqual(upstream.host, '127.0.0.1:8081')
  assert.strictEqual(upstream.pathname, '/')
  assert(upstream.search.includes('select=todos'), 'query preserved')
  ok('normal /db path resolves to Adminer with query intact')
}
{
  const u = new URL('/db', 'http://localhost')
  const upstream = resolveUpstream(u.pathname, u.search, ADMINER, '/db')
  assert.strictEqual(upstream.host, '127.0.0.1:8081')
  assert.strictEqual(upstream.pathname, '/')
  ok('/db (no trailing slash) resolves to Adminer root')
}

// --- pgweb branch (stripPrefix null) was never vulnerable; confirm it stays so
{
  const u = new URL('/pgweb//evil.com/x', 'http://localhost')
  const upstream = resolveUpstream(u.pathname, u.search, PGWEB, null)
  assert(upstream === null || upstream.host === '127.0.0.1:9999', 'pgweb proxy must stay on loopback')
  ok('pgweb proxy stays on its loopback origin')
}

console.log(`\nssrf.test.mjs: all ${passed} checks passed`)
process.exit(0)
