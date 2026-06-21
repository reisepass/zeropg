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

    console.log('reload -> persisted')
    await page.reload()
    ok(await page.getByTestId('row-Grace').isVisible(), 'Grace persisted across reload')
    ok(await page.getByTestId('row-Alan').isVisible(), 'Alan persisted across reload')

    console.log('open the share link directly (own URL)')
    const share = (await page.getByTestId('share').textContent())!
    await page.goto(base + share)
    ok((await page.getByTestId('poll-title').textContent()) === 'Sprint demo slot', 'share URL loads the poll directly')
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
