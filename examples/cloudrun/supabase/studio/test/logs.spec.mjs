// Logs: a seeded log row displays with exact source/level/message; filters match
// the SQL equivalent; error rows carry error styling; and no secret material
// (e.g. an Authorization header sent with a request) ever appears in any log row.

import { authedContext, readLogs, uniq } from './helpers.mjs'

export async function run({ base, browser, password, sql, t }) {
  const src = uniq('logsrc')
  const warnMsg = uniq('warnmsg')
  const errMsg = uniq('errmsg')
  await sql(`INSERT INTO studio.logs (source, level, message) VALUES ($1,'warn',$2)`, [src, warnMsg])
  await sql(`INSERT INTO studio.logs (source, level, message) VALUES ($1,'error',$2)`, [src, errMsg])
  await sql(`INSERT INTO studio.logs (source, level, message) VALUES ($1,'info',$2)`, [src, uniq('infomsg')])

  const ctx = await authedContext(browser, base, password)
  const page = await ctx.newPage()
  await page.goto(`${base}/studio/logs`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="logs-list"]')

  // filter by our unique source -> exactly our 3 rows
  await page.fill('[data-testid="logs-source"]', src)
  await page.click('[data-testid="logs-apply"]')
  await page.waitForFunction((s) => {
    const rows = document.querySelectorAll('[data-testid="log-row"]')
    return rows.length > 0 && Array.from(rows).every((r) => r.dataset.source === s)
  }, src, { timeout: 8000 })
  let rows = await readLogs(page)
  const dbAll = Number((await sql(`SELECT count(*)::int c FROM studio.logs WHERE source=$1`, [src])).rows[0].c)
  t.eq(rows.length, dbAll, `logs filtered by source show exactly the DB count (${dbAll})`)

  // exact display of the seeded warn row
  const warnRow = rows.find((r) => r.message === warnMsg)
  t.assert(warnRow && warnRow.source === src && warnRow.level === 'warn', 'seeded log row displays exact source/level/message')

  // error styling only on error rows
  const errRow = rows.find((r) => r.message === errMsg)
  t.assert(errRow && /log-lvl error/.test(errRow.levelClass), 'error-level row carries error styling')
  t.assert(warnRow && !/log-lvl error/.test(warnRow.levelClass), 'warn-level row does NOT carry error styling')

  // filter source + level = error -> matches WHERE
  const dbErr = Number((await sql(`SELECT count(*)::int c FROM studio.logs WHERE source=$1 AND level='error'`, [src])).rows[0].c)
  await page.selectOption('[data-testid="logs-level"]', 'error')
  await page.click('[data-testid="logs-apply"]')
  // wait for the list to settle on EXACTLY the expected error rows (avoids
  // reading a mid-render empty state, where every() would be vacuously true)
  await page.waitForFunction(({ s, n }) => {
    const r = Array.from(document.querySelectorAll('[data-testid="log-row"]'))
    return r.length === n && r.every((x) => x.dataset.level === 'error' && x.dataset.source === s)
  }, { s: src, n: dbErr }, { timeout: 8000 })
  rows = await readLogs(page)
  t.eq(rows.length, dbErr, `logs filtered by source+level=error match WHERE (${dbErr})`)
  t.assert(rows.every((r) => r.level === 'error'), 'level filter shows only error rows')

  // no secret material: send a request carrying an Authorization header, then
  // assert the secret never lands in any log row (message or meta).
  const secret = `SECRET_${uniq('bearer')}`
  await ctx.request.post(`${base}/studio/api/login`, { data: { password: 'wrong-on-purpose' }, headers: { authorization: `Bearer ${secret}` } })
  const leak = Number((await sql(`SELECT count(*)::int c FROM studio.logs WHERE message ILIKE $1 OR coalesce(meta::text,'') ILIKE $1`, [`%${secret}%`])).rows[0].c)
  t.eq(leak, 0, 'an Authorization header secret never appears in any log row')

  await ctx.close()
}
