// Live verification of the deployed inspector, exactly the flow
// docs/EDITOR-AUTH-SECURITY.md describes: token link -> landing (live
// discovery) -> open supabase-zeropg -> inside Adminer with no typing ->
// todos grid renders -> SQL query returns.
//
//   node examples/cloudrun/inspector/test/live-verify.mjs "<url>/?t=<token>"
//
// (Or set INSPECTOR_LINK.) Needs playwright + chromium from the repo root.

import { chromium } from 'playwright'
import assert from 'node:assert'

const LINK = process.argv[2] || process.env.INSPECTOR_LINK
if (!LINK) throw new Error('pass the token link: node live-verify.mjs "https://.../?t=<token>"')
const origin = new URL(LINK).origin

let passed = 0
const ok = (name) => {
  passed++
  console.log(`  ok ${passed} - ${name}`)
}

const browser = await chromium.launch()
const page = await browser.newPage()
try {
  // 1. tokenless is a 403
  const r403 = await page.request.get(origin + '/', { maxRedirects: 0 })
  assert.strictEqual(r403.status(), 403)
  ok('no token -> 403')

  // 2. token link lands on the landing page; token is stripped from the URL
  await page.goto(LINK, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  assert(!page.url().includes('t='), `token must be stripped, url: ${page.url()}`)
  await page.waitForSelector('h1:has-text("zeropg inspector")')
  ok('token link -> landing, token stripped from the URL (cookie set)')

  // 3. landing lists targets from LIVE discovery (several fleet services)
  const body = await page.textContent('body')
  for (const name of ['supabase-zeropg', 'rallly-zeropg', 'nocodb-zeropg']) {
    assert(body.includes(name), `landing must list ${name} (live discovery)`)
  }
  assert(body.includes('live fleet discovery'), 'landing must say targets come from live discovery')
  ok('landing lists fleet targets from live discovery')

  // 4. open supabase-zeropg -> lands INSIDE Adminer with no typing
  await Promise.all([
    page.waitForURL(/\/db\//, { timeout: 180_000 }),
    page.click('a[href="/open/supabase-zeropg"]'),
  ])
  // Adminer auto-login: wait for a logged-in marker (breadcrumb or table list),
  // never a login form.
  await page.waitForSelector('#tables, .breadcrumb, #menu', { timeout: 60_000 })
  const loggedOut = await page.$('input[name="auth[password]"]:visible')
  assert(!loggedOut, 'must not be looking at a login form')
  ok('open supabase-zeropg -> inside Adminer, no typing')

  // 5. todos grid renders
  await page.goto(`${origin}/db/?pgsql=${encodeURIComponent(await wireHost())}&username=postgres&db=postgres&select=todos`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await page.waitForSelector('table', { timeout: 60_000 })
  const grid = await page.textContent('body')
  assert(/todos/i.test(grid), 'todos page must render')
  assert(await page.$('table tr'), 'data grid must have rows')
  ok('todos grid renders')

  // 6. SQL query returns (ns=public: without a namespace Adminer shows the
  // "Select database" page instead of the SQL command form)
  await page.goto(`${origin}/db/?pgsql=${encodeURIComponent(await wireHost())}&username=postgres&db=postgres&ns=public&sql=`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  // Adminer's jush editor overlays the real textarea (not "visible" to
  // Playwright's fill), so set the value in the DOM and submit the form.
  await page.waitForSelector('textarea', { state: 'attached', timeout: 60_000 })
  await page.evaluate(() => {
    const ta = document.querySelector('textarea')
    ta.value = 'SELECT count(*) AS todo_count FROM todos'
  })
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.evaluate(() => document.querySelector('textarea').form.submit()),
  ])
  await page.waitForSelector('table', { timeout: 60_000 })
  const sqlOut = await page.textContent('body')
  assert(/todo_count/.test(sqlOut), 'SQL result must show the aliased column')
  ok('SQL query executes and returns')

  console.log(`\nlive-verify: all ${passed} checks passed against ${origin}`)
} finally {
  await browser.close()
}

// The Adminer deep links need the wire host:port the service opened for the
// target - scrape it from the current /db/ URL after the /open redirect.
async function wireHost() {
  const u = new URL(page.url())
  const pgsql = u.searchParams.get('pgsql')
  assert(pgsql, `expected pgsql= in the Adminer URL, got ${page.url()}`)
  return pgsql
}
