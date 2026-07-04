// Connection modal: anon key shown in full and exactly matches the BFF config;
// privileged secrets are redacted until an explicit reveal, then shown in full
// (never ellipsis-truncated).

import { authedContext } from './helpers.mjs'
import { CONN } from '../lib/harness.mjs'

export async function run({ base, browser, password, sql, t }) {
  const ctx = await authedContext(browser, base, password)
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
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

  // copy WITHOUT reveal: exact value lands on the clipboard, screen stays redacted
  await page.click('[data-testid="copy-serviceKey"]')
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="copy-serviceKey"]')
    return b && b.textContent === 'Copied'
  }, undefined, { timeout: 8000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  t.eq(clip, CONN.serviceKey, 'copy-without-reveal puts the EXACT service key on the clipboard')
  const afterCopy = await page.textContent('[data-testid="secret-serviceKey"]')
  t.assert(!afterCopy.includes(CONN.serviceKey) && /hidden|•/.test(afterCopy), 'secret is STILL redacted on screen after copy')
  const domHasSecret = await page.evaluate((v) => document.documentElement.outerHTML.includes(v), CONN.serviceKey)
  t.assert(!domHasSecret, 'copied secret value appears NOWHERE in the DOM')
  const copyAudit = await sql(`SELECT count(*)::int c FROM studio.logs WHERE message LIKE 'secret copied%' AND meta->>'item'='serviceKey'`)
  t.assert(Number(copyAudit.rows[0].c) >= 1, 'copy is audit-logged as a distinct event (secret copied, not revealed)')
  const auditLeak = await sql(`SELECT count(*)::int c FROM studio.logs WHERE message LIKE '%' || $1 || '%' OR meta::text LIKE '%' || $1 || '%'`, [CONN.serviceKey])
  t.eq(Number(auditLeak.rows[0].c), 0, 'the secret value itself is not in any log row')

  await page.click('[data-testid="reveal-serviceKey"]')
  await page.waitForFunction((v) => document.querySelector('[data-testid="secret-serviceKey"]')?.textContent === v, CONN.serviceKey, { timeout: 8000 })
    .then(() => t.ok('service key full value present after reveal'))
    .catch(() => t.fail('service key not revealed to full value'))

  // jwt secret + db url also reveal to full value
  await page.click('[data-testid="reveal-jwtSecret"]')
  await page.waitForFunction((v) => document.querySelector('[data-testid="secret-jwtSecret"]')?.textContent === v, CONN.jwtSecret, { timeout: 8000 })
    .then(() => t.ok('jwt secret full value present after reveal'))
    .catch(() => t.fail('jwt secret not revealed'))

  // settings page has the same copy-without-reveal control
  await page.goto(`${base}/studio/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="set-copy-jwtSecret"]', { timeout: 8000 })
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await page.click('[data-testid="set-copy-jwtSecret"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="set-copy-jwtSecret"]')?.textContent === 'Copied', undefined, { timeout: 8000 })
  const clipSet = await page.evaluate(() => navigator.clipboard.readText())
  t.eq(clipSet, CONN.jwtSecret, 'settings page copy puts the EXACT jwt secret on the clipboard')
  const setBox = await page.textContent('[data-testid="set-secret-jwtSecret"]')
  t.assert(!setBox.includes(CONN.jwtSecret) && /hidden|•/.test(setBox), 'settings page secret still redacted after copy')

  await ctx.close()
}
