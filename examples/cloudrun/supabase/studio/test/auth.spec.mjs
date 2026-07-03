// Auth: unauthenticated routes redirect to login, wrong password rejected, login
// rate limit fires, session survives reload, logout kills it, and mutating API
// calls without a CSRF token are rejected.

import { authedContext } from './helpers.mjs'

export async function run({ base, browser, password, t }) {
  // --- every studio route unauthenticated -> login ---
  for (const route of ['/studio', '/studio/sql', '/studio/editor', '/studio/logs', '/studio/settings']) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForSelector('[data-testid="login"]', { timeout: 8000 })
      const url = new URL(page.url())
      t.assert(url.pathname === '/studio/login', `unauthenticated ${route} -> login (url now ${url.pathname})`)
    } catch {
      t.fail(`unauthenticated ${route} did not show login`)
    }
    await ctx.close()
  }

  // --- wrong password rejected (via UI) ---
  {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${base}/studio`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="login"]')
    await page.fill('[data-testid="login-password"]', 'definitely-wrong')
    await page.click('[data-testid="login-submit"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="login-error"]')?.textContent?.length > 0, { timeout: 8000 }).catch(() => {})
    const err = await page.textContent('[data-testid="login-error"]')
    t.assert(/invalid password/i.test(err || ''), `wrong password shows error ("${err}")`)
    // still on login
    t.assert(await page.isVisible('[data-testid="login"]'), 'still on login after wrong password')
    await ctx.close()
  }

  // --- rate limit fires after N failures (isolated fake IP so it does not
  //     pollute 127.0.0.1's counter that other specs log in from) ---
  {
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.77' } })
    let sawLimit = false, limitAt = 0
    for (let i = 1; i <= 8; i++) {
      const r = await ctx.request.post(`${base}/studio/api/login`, { data: { password: 'nope' } })
      if (r.status() === 429) { sawLimit = true; limitAt = i; break }
    }
    t.assert(sawLimit, `login rate limit fired (429) after repeated failures (at attempt ${limitAt})`)
    await ctx.close()
  }

  // --- correct login works, session survives reload ---
  {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${base}/studio`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="login"]')
    await page.fill('[data-testid="login-password"]', password)
    await page.click('[data-testid="login-submit"]')
    await page.waitForSelector('#sidebar:not([hidden])', { timeout: 10000 })
    t.ok('correct password logs in (sidebar visible)')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sidebar:not([hidden])', { timeout: 10000 }).then(() => t.ok('session survives reload')).catch(() => t.fail('session lost after reload'))

    // --- logout kills the session ---
    await page.click('[data-testid="logout-btn"]')
    await page.waitForSelector('[data-testid="login"]', { timeout: 8000 }).then(() => t.ok('logout returns to login')).catch(() => t.fail('logout did not return to login'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="login"]', { timeout: 8000 }).then(() => t.ok('after logout + reload still logged out')).catch(() => t.fail('still authed after logout+reload'))
    await ctx.close()
  }

  // --- mutation without CSRF token is rejected (has valid session cookie) ---
  {
    const ctx = await authedContext(browser, base, password)
    const r = await ctx.request.post(`${base}/studio/api/query`, { data: { sql: 'select 1' } })
    t.assert(r.status() === 403, `POST /query with session cookie but no CSRF token -> 403 (got ${r.status()})`)
    await ctx.close()
  }
}
