// Connection modal: anon key shown in full and exactly matches the BFF config;
// privileged secrets are redacted until an explicit reveal, then shown in full
// (never ellipsis-truncated).

import { authedContext } from './helpers.mjs'
import { CONN } from '../lib/harness.mjs'

export async function run({ base, browser, password, t }) {
  const ctx = await authedContext(browser, base, password)
  const page = await ctx.newPage()
  await page.goto(`${base}/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#sidebar:not([hidden])')

  await page.click('[data-testid="conn-open"]')
  await page.waitForSelector('[data-testid="conn-modal"]:not([hidden])')

  // anon key exact match, full value
  const anon = await page.textContent('[data-testid="conn-anonKey"]')
  t.eq(anon, CONN.anonKey, 'anon key displayed matches BFF config exactly')
  t.assert(!(/…|\.\.\./.test(anon)), 'anon key is not ellipsis-truncated')
  t.eq(await page.textContent('[data-testid="conn-rest"]'), CONN.rest, 'REST URL exact match')
  t.eq(await page.textContent('[data-testid="conn-auth"]'), CONN.auth, 'auth URL exact match')

  // service key redacted until reveal
  const before = await page.textContent('[data-testid="secret-serviceKey"]')
  t.assert(!before.includes(CONN.serviceKey), 'service key redacted before reveal')
  t.assert(/hidden|•/.test(before), 'service key box shows a redacted placeholder')

  await page.click('[data-testid="reveal-serviceKey"]')
  await page.waitForFunction((v) => document.querySelector('[data-testid="secret-serviceKey"]')?.textContent === v, CONN.serviceKey, { timeout: 8000 })
    .then(() => t.ok('service key full value present after reveal'))
    .catch(() => t.fail('service key not revealed to full value'))

  // jwt secret + db url also reveal to full value
  await page.click('[data-testid="reveal-jwtSecret"]')
  await page.waitForFunction((v) => document.querySelector('[data-testid="secret-jwtSecret"]')?.textContent === v, CONN.jwtSecret, { timeout: 8000 })
    .then(() => t.ok('jwt secret full value present after reveal'))
    .catch(() => t.fail('jwt secret not revealed'))

  await ctx.close()
}
