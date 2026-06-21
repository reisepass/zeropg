// Run: tsx examples/poll/test/e2e.test.ts
// (setup: npx playwright install chromium + npx prisma generate --schema examples/poll/prisma/schema.prisma)
//
// Drives the real poll UI in headless chromium: create a poll, two people vote
// via the form, the results grid + "best option" update, and it all persists on
// a reload — a real Prisma app exercised through the browser against zeropg.

import { chromium, type Browser } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { boot } from '../boot.js'
import { createApp } from '../app.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'poll-e2e-'))
  const b = await boot({ dataDir: join(dir, 'db') })
  const app = createApp(b.prisma)
  await new Promise<void>((r) => app.listen(0, r))
  const base = `http://localhost:${(app.address() as AddressInfo).port}`

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()

    console.log('create a poll')
    await page.goto(base + '/')
    await page.getByTestId('title').fill('Sprint demo slot')
    await page.getByTestId('options').fill('Thu 15:00\nFri 11:00')
    await page.getByTestId('create').click()
    await page.waitForURL('**/poll/**')
    ok((await page.getByTestId('poll-title').textContent()) === 'Sprint demo slot', 'poll page shows the title')
    ok((await page.getByTestId('share').textContent())?.startsWith('/poll/') ?? false, 'share link present')
    ok((await page.getByTestId('best').textContent())?.includes('No votes yet') ?? false, 'no votes yet initially')

    console.log('first participant votes (Thu yes, Fri no)')
    await page.getByTestId('name').fill('Grace')
    await page.getByLabel('Thu 15:00').selectOption('yes')
    await page.getByLabel('Fri 11:00').selectOption('no')
    await page.getByTestId('submit-vote').click()
    await page.waitForURL('**/poll/**')
    await page.getByTestId('row-Grace').waitFor()
    ok(await page.getByTestId('row-Grace').isVisible(), "Grace's row appears in the grid")
    ok((await page.getByTestId('best').textContent())?.includes('Thu 15:00') ?? false, 'best is Thursday after one yes')

    console.log('second participant votes (Thu yes too)')
    await page.getByTestId('name').fill('Alan')
    await page.getByLabel('Thu 15:00').selectOption('yes')
    await page.getByLabel('Fri 11:00').selectOption('ifneedbe')
    await page.getByTestId('submit-vote').click()
    await page.waitForURL('**/poll/**')
    await page.getByTestId('row-Alan').waitFor()
    ok(await page.getByTestId('row-Alan').isVisible(), "Alan's row appears")
    ok((await page.getByTestId('best').textContent())?.includes('Thu 15:00') ?? false, 'Thursday still best with 2 yes')

    console.log('the results grid renders the right marks per person per slot')
    // td[0] = name, td[1] = Thu 15:00, td[2] = Fri 11:00 (option order).
    const cell = (row: string, col: number) => page.getByTestId(`row-${row}`).locator('td').nth(col).textContent()
    ok((await cell('Grace', 1))?.trim() === '✓', 'Grace × Thu = ✓ (yes)')
    ok((await cell('Grace', 2))?.trim() === '✗', 'Grace × Fri = ✗ (no)')
    ok((await cell('Alan', 1))?.trim() === '✓', 'Alan × Thu = ✓ (yes)')
    ok((await cell('Alan', 2))?.trim() === '~', 'Alan × Fri = ~ (if need be)')

    console.log('the ✓-total row and best-column highlight are correct')
    const totalRow = page.locator('tr', { hasText: '✓ total' })
    ok((await totalRow.locator('td').nth(1).textContent())?.includes('2 ✓') ?? false, 'Thu total = 2 ✓')
    ok((await totalRow.locator('td').nth(2).textContent())?.includes('0 ✓') ?? false, 'Fri total = 0 ✓')
    const bestHead = page.locator('th.best')
    ok((await bestHead.count()) === 1 && (await bestHead.textContent())?.trim() === 'Thu 15:00', 'best column header is Thu, highlighted')

    console.log('reload -> persisted')
    await page.reload()
    ok(await page.getByTestId('row-Grace').isVisible(), 'Grace persisted across reload')
    ok(await page.getByTestId('row-Alan').isVisible(), 'Alan persisted across reload')
    ok((await cell('Alan', 2))?.trim() === '~', 'Alan × Fri mark persisted across reload')

    console.log('open the share link directly (own URL)')
    const share = (await page.getByTestId('share').textContent())!
    await page.goto(base + share)
    ok((await page.getByTestId('poll-title').textContent()) === 'Sprint demo slot', 'share URL loads the poll directly')

    console.log('a bad poll id shows the 404 view')
    const resp = await page.goto(base + '/poll/does-not-exist')
    ok(resp?.status() === 404, 'unknown poll returns HTTP 404')
    ok((await page.locator('h1').textContent())?.includes('no such poll') ?? false, '404 page rendered')
  } finally {
    if (browser) await browser.close()
    await new Promise<void>((r) => app.close(() => r()))
    await b.stop()
    await rm(dir, { recursive: true, force: true })
  }
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
