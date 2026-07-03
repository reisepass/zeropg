// SQL editor: SELECT grid matches seeded rows + correct headers; bad SQL shows
// the real PG error text + code; DDL is reflected in the table list; history
// persists across reload with the exact SQL; saved-query round-trip; BEGIN
// rejected with the explanatory error; a failed query does not poison the next;
// multi-statement returns the last result set; and the per-submission reset
// baseline contains a search_path leak (verified via SHOW search_path).

import { authedContext, readGrid, readHeaders, uniq } from './helpers.mjs'

async function runSql(page, sql) {
  await page.fill('[data-testid="sql-input"]', sql)
  await page.click('[data-testid="sql-run"]')
  // wait for either a result grid, the "no rows" note, or an error
  await page.waitForFunction(() => {
    const meta = document.querySelector('[data-testid="sql-time"]')?.textContent || ''
    const err = document.querySelector('[data-testid="sql-error"]')?.textContent || ''
    return /ms/.test(meta) || err.length > 0
  }, { timeout: 15000 })
}

export async function run({ base, browser, password, sql, t }) {
  const tbl = uniq('sqlsel')
  await sql(`CREATE TABLE public.${tbl} (id int primary key, name text, n int)`)
  await sql(`INSERT INTO public.${tbl} VALUES (1,'alpha',10),(2,'beta',20),(3,'gamma',30)`)

  const ctx = await authedContext(browser, base, password)
  const page = await ctx.newPage()
  await page.goto(`${base}/studio/sql`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="sql-input"]')

  // --- SELECT grid matches seeded rows + headers ---
  await runSql(page, `select id, name, n from public.${tbl} order by id`)
  const headers = await readHeaders(page, 'sql-results')
  t.eq(headers, ['id', 'name', 'n'], 'SQL result headers match the select list order')
  const grid = await readGrid(page, 'sql-results')
  t.eq(grid.map((r) => [r.id.text, r.name.text, r.n.text]), [['1', 'alpha', '10'], ['2', 'beta', '20'], ['3', 'gamma', '30']], 'SQL result rows match seeded data exactly')

  // --- bad SQL shows the real PG error text + code ---
  const missing = uniq('nope')
  await runSql(page, `select * from public.${missing}`)
  const errText = await page.textContent('[data-testid="sql-error"]')
  const errCode = await page.getAttribute('[data-testid="sql-error"]', 'data-code')
  t.assert(/does not exist/i.test(errText || ''), `bad SQL surfaces the real PG message ("${(errText || '').slice(0, 60)}")`)
  t.eq(errCode, '42P01', 'bad SQL surfaces the PG error code 42P01')

  // --- failed query does not poison the next ---
  await runSql(page, 'select 42 as answer')
  const recover = await readGrid(page, 'sql-results')
  t.eq(recover.map((r) => r.answer.text), ['42'], 'a good query right after a failed one still works (session not poisoned)')

  // --- multi-statement submission returns the last result set ---
  const multi = uniq('multi')
  await runSql(page, `create table public.${multi} (id int); insert into public.${multi} values (1),(2),(3); select count(*)::int as c from public.${multi}`)
  const multiGrid = await readGrid(page, 'sql-results')
  t.eq(multiGrid.map((r) => r.c.text), ['3'], 'multi-statement submission returns the last result set (count=3)')

  // --- DDL reflected in the studio table list ---
  const ddl = uniq('ddl')
  await runSql(page, `create table public.${ddl} (id int primary key, label text)`)
  const listed = await page.evaluate(async () => {
    const r = await fetch('/studio/api/meta/tables?refresh=1')
    return (await r.json()).tables
  })
  t.assert(listed.some((x) => x.schema === 'public' && x.name === ddl), 'newly created table appears in the studio table list')

  // --- BEGIN rejected with the explanatory error ---
  await runSql(page, 'BEGIN; select 1')
  const beginErr = await page.textContent('[data-testid="sql-error"]')
  const beginCode = await page.getAttribute('[data-testid="sql-error"]', 'data-code')
  t.assert(/transaction-control/i.test(beginErr || '') && /shared/i.test(beginErr || ''), 'BEGIN is rejected with the shared-session explanation')
  t.eq(beginCode, 'STUDIO_TXN_BLOCKED', 'BEGIN rejection carries the STUDIO_TXN_BLOCKED code')

  // --- COPY ... FROM STDIN rejected (would desync the shared wire session) ---
  await runSql(page, `COPY public.${tbl} FROM STDIN`)
  const copyErr = await page.textContent('[data-testid="sql-error"]')
  const copyCode = await page.getAttribute('[data-testid="sql-error"]', 'data-code')
  t.assert(/copy-in|copy \.\.\. from stdin|from stdin/i.test(copyErr || ''), 'COPY FROM STDIN rejected with an explanatory error')
  t.eq(copyCode, 'STUDIO_COPY_BLOCKED', 'COPY FROM STDIN rejection carries STUDIO_COPY_BLOCKED')

  // --- search_path leak is contained by the reset baseline ---
  await runSql(page, 'SET search_path TO pg_catalog')
  await runSql(page, 'SHOW search_path')
  const sp = await readGrid(page, 'sql-results')
  t.eq(sp.map((r) => r.search_path.text), ['public'], 'reset baseline restores search_path to public after a leaking SET (verified via SHOW)')

  // --- reset baseline (DISCARD ALL) releases a session advisory lock across submissions ---
  const lockKey = 918273
  await runSql(page, `SELECT pg_advisory_lock(${lockKey})`)
  await runSql(page, `SELECT pg_advisory_unlock(${lockKey}) AS u`)
  const unlock = await readGrid(page, 'sql-results')
  t.eq(unlock.map((r) => r.u.text), ['false'], 'DISCARD ALL reset released the advisory lock from the prior submission (unlock returns false)')

  // --- history persists across reload with exact SQL text ---
  const marker = `select '${uniq('HIST')}' as marker`
  await runSql(page, marker)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="sql-history"]')
  await page.waitForFunction((m) => Array.from(document.querySelectorAll('[data-testid="history-sql"]')).some((e) => e.textContent === m), marker, { timeout: 10000 })
    .then(() => t.ok('SQL history persists across reload with the exact SQL text'))
    .catch(() => t.fail('history did not contain the exact SQL after reload'))

  // --- saved-query round-trip ---
  const savedName = uniq('saved')
  const savedSql = `select ${Math.floor(Math.random() * 1000)} as saved_val`
  page.once('dialog', (d) => d.accept(savedName))
  await page.fill('[data-testid="sql-input"]', savedSql)
  await page.click('[data-testid="sql-save"]')
  await page.waitForFunction((n) => Array.from(document.querySelectorAll('[data-testid="saved-name"]')).some((e) => e.textContent === n), savedName, { timeout: 10000 })
    .then(() => t.ok('saved query appears with its name'))
    .catch(() => t.fail('saved query name did not appear'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="sql-saved"]')
  const savedOk = await page.evaluate(({ n, s }) => {
    const items = Array.from(document.querySelectorAll('[data-testid="saved-item"]'))
    return items.some((it) => it.querySelector('[data-testid="saved-name"]').textContent === n && it.querySelector('[data-testid="saved-sql"]').textContent === s)
  }, { n: savedName, s: savedSql })
  t.assert(savedOk, 'saved query round-trips across reload with exact name + SQL')

  await ctx.close()
}
