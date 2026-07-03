// Concurrency (zeropg's sharp edge - one shared PGlite session): two SQL
// submissions issued at the same time both complete with correct results, and a
// long-running SQL statement does not stop the table browser from paginating.

import { authedContext, readGrid, uniq } from './helpers.mjs'

async function csrfFor(ctx, base) {
  const r = await ctx.request.get(`${base}/studio/api/session`)
  return (await r.json()).csrfToken
}

export async function run({ base, browser, password, sql, t }) {
  const ctx = await authedContext(browser, base, password)
  const csrf = await csrfFor(ctx, base)
  const post = (q) => ctx.request.post(`${base}/studio/api/query`, { data: { sql: q }, headers: { 'x-csrf-token': csrf } })

  // --- two SQL submissions at once, one slow one fast: both correct ---
  const [slow, fast] = await Promise.all([
    post('select pg_sleep(1); select 111 as a'),
    post('select 222 as b'),
  ])
  t.assert(slow.ok() && fast.ok(), `both concurrent submissions returned 200 (slow=${slow.status()} fast=${fast.status()})`)
  const slowBody = await slow.json()
  const fastBody = await fast.json()
  t.eq(slowBody.rows, [{ a: 111 }], 'slow submission returned its own correct result (a=111)')
  t.eq(fastBody.rows, [{ b: 222 }], 'fast submission returned its own correct result (b=222) - no cross-talk')

  // --- long SQL running while the table browser paginates ---
  const sch = uniq('cc')
  await sql(`CREATE SCHEMA ${sch}`)
  await sql(`CREATE TABLE ${sch}.nums (id int primary key)`)
  await sql(`INSERT INTO ${sch}.nums SELECT g FROM generate_series(1,80) g`)

  const page = await ctx.newPage()
  await page.goto(`${base}/studio/editor`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(`[data-testid="tb-table"][data-key="${sch}.nums"]`, { timeout: 10000 })
  await page.click(`[data-testid="tb-table"][data-key="${sch}.nums"]`)
  await page.waitForSelector('[data-testid="tb-grid"]')
  await page.click('[data-testid="tb-grid"] th[data-col="id"]') // deterministic order
  await page.waitForFunction(() => document.querySelector('[data-testid="tb-pageinfo"]')?.textContent?.startsWith('1-'))

  // fire a long autocommit query in the background, then paginate the UI
  const bg = post('select pg_sleep(2), 1')
  await page.click('[data-testid="tb-next"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="tb-pageinfo"]')?.textContent === '51-80 of 80', { timeout: 8000 })
    .then(() => t.ok('table browser paginated (page 2) while a long SQL query was running'))
    .catch(() => t.fail('pagination stalled while a long query ran'))
  const g2 = await readGrid(page, 'tb-grid')
  t.eq(g2.map((r) => Number(r.id.text)), Array.from({ length: 30 }, (_, i) => i + 51), 'page 2 rows are correct under concurrency (ids 51..80)')
  const bgRes = await bg
  t.assert(bgRes.ok(), 'the long background query also completed successfully')

  await ctx.close()
}
