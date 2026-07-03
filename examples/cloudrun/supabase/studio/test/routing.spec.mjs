// Routing: every view deep-links directly on a fresh page load (real URL per
// view), and browser back/forward navigate between views correctly.

import { authedContext } from './helpers.mjs'

const VIEWS = [
  ['/studio', 'status-grid', 'Home'],
  ['/studio/editor', 'tb-sidebar', 'Table editor'],
  ['/studio/sql', 'sql-input', 'SQL editor'],
  ['/studio/logs', 'logs-list', 'Logs'],
  ['/studio/settings', 'set-anonKey', 'Settings'],
]

export async function run({ base, browser, password, t }) {
  const ctx = await authedContext(browser, base, password)
  const page = await ctx.newPage()

  // deep-link each view directly (fresh navigation)
  for (const [route, testid, crumb] of VIEWS) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForSelector(`[data-testid="${testid}"]`, { timeout: 10000 })
      t.assert(new URL(page.url()).pathname === route, `deep-link ${route} keeps the URL`)
      t.eq(await page.textContent('#crumb'), crumb, `deep-link ${route} renders "${crumb}"`)
    } catch {
      t.fail(`deep-link ${route} did not render ${testid}`)
    }
  }

  // back/forward: home -> sql -> logs, then back/back, then forward
  await page.goto(`${base}/studio`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="status-grid"]')
  await page.click('[data-testid="nav-sql"]')
  await page.waitForSelector('[data-testid="sql-input"]')
  await page.click('[data-testid="nav-logs"]')
  await page.waitForSelector('[data-testid="logs-list"]')

  await page.goBack()
  await page.waitForSelector('[data-testid="sql-input"]', { timeout: 8000 })
  t.assert(new URL(page.url()).pathname === '/studio/sql', 'back navigates to SQL editor')

  await page.goBack()
  await page.waitForSelector('[data-testid="status-grid"]', { timeout: 8000 })
  t.assert(new URL(page.url()).pathname === '/studio', 'back again navigates to Home')

  await page.goForward()
  await page.waitForSelector('[data-testid="sql-input"]', { timeout: 8000 })
  t.assert(new URL(page.url()).pathname === '/studio/sql', 'forward navigates back to SQL editor')

  await ctx.close()
}
