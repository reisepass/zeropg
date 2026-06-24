// Run: tsx examples/shortlink/test/e2e.test.ts   (chromium must be installed:
//      npx playwright install chromium)
//
// Drives the REAL UI in a headless browser end-to-end (not curl + 200): boots the
// app on a temp file://, shortens a URL via the form, captures the generated short
// code, navigates to /<code> and asserts the browser actually redirects to the
// target, then loads the stats pages and asserts the click counter incremented.
// Because the redirect is a true 302, we point the link at the app's OWN /links
// page so chromium can follow it to a reachable, assertable destination.

import { chromium, type Browser } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDb } from '../db.js'
import { createApp } from '../app.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'shortlink-e2e-'))
  const { db } = await openDb(`file://${join(dir, 'sl.db')}`)
  const app = createApp(db)
  await new Promise<void>((r) => app.listen(0, r))
  const base = `http://localhost:${(app.address() as AddressInfo).port}`
  // The link target: a real, reachable page (the app's own All-links view) so the
  // browser can actually complete the redirect and we can assert on where it lands.
  const target = `${base}/links`

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()

    console.log('home loads on the file:// engine')
    await page.goto(base + '/')
    ok((await page.getByTestId('engine').textContent()) === 'file', 'engine badge shows file')
    ok(await page.getByTestId('shorten').isVisible(), 'shorten form is present')

    console.log('shorten a URL via the form -> lands on its detail page with a code')
    await page.getByTestId('new-url').fill(target)
    await page.getByTestId('shorten').click()
    await page.waitForURL('**/link/**') // POST -> 303 -> /link/<code>
    const code = (await page.getByTestId('code').textContent())?.trim() ?? ''
    ok(/^[a-z0-9]{6}$/.test(code), `generated a 6-char short code (${code})`)
    ok((await page.getByTestId('target').textContent())?.startsWith(target) ?? false, 'detail shows the target URL')
    ok((await page.getByTestId('clicks').textContent()) === '0', 'fresh link starts at 0 clicks')

    console.log('visit /<code> -> the browser is redirected to the target')
    await page.goto(`${base}/${code}`)
    await page.waitForURL('**/links') // 302 followed by the browser
    ok(page.url() === target, 'redirect landed on the target URL')
    // also assert the redirect at the protocol level (a true 302, not a meta/JS hop)
    const raw = await page.request.get(`${base}/${code}`, { maxRedirects: 0 })
    ok(raw.status() === 302, 'GET /<code> returns a 302')
    ok(raw.headers()['location'] === target, '302 Location header is the target')

    console.log('stats: the click counter incremented')
    // two follows so far (the page.goto above + the raw request); reload detail.
    await page.goto(`${base}/link/${code}`)
    ok((await page.getByTestId('clicks').textContent()) === '2', 'detail page shows 2 clicks')

    console.log('All-links list shows the code with its live click count')
    await page.goto(base + '/links')
    await page.getByTestId(`link-${code}`).waitFor()
    ok(
      (await page.getByTestId(`clicks-${code}`).textContent()) === '2 clicks',
      'list view shows the same click count',
    )

    console.log('persistence: click count survives a reload (on-disk round-trip)')
    await page.getByTestId(`detail-${code}`).click()
    await page.waitForURL(`**/link/${code}`)
    await page.reload()
    ok((await page.getByTestId('clicks').textContent()) === '2', 'click count persisted after reload')
  } finally {
    if (browser) await browser.close()
    await new Promise<void>((r) => app.close(() => r()))
    await db.end()
    await rm(dir, { recursive: true, force: true })
  }

  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
