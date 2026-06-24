// Run: tsx examples/drizzle-board/test/e2e.test.ts
// (setup: npx playwright install chromium)
//
// Drives the real reading-list board UI in headless chromium: add a bookmark,
// see it render, change its status, add and remove tags, filter the list, and
// confirm everything persists on reload — a real Drizzle ORM app exercised
// through the browser against zeropg.

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
  const dir = await mkdtemp(join(tmpdir(), 'drizzle-board-e2e-'))
  const b = await boot({ dataDir: join(dir, 'db') })
  const app = createApp(b.db)
  await new Promise<void>((r) => app.listen(0, r))
  const base = `http://localhost:${(app.address() as AddressInfo).port}`

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()

    console.log('empty state')
    await page.goto(base + '/')
    ok((await page.getByTestId('empty').textContent())?.includes('Nothing here yet') ?? false, 'empty list shown initially')

    console.log('add a bookmark')
    await page.getByTestId('title').fill('Designing Data-Intensive Applications')
    await page.getByTestId('url').fill('https://dataintensive.net')
    await page.getByTestId('note').fill('the red book')
    await page.getByTestId('create').click()
    await page.waitForURL('**/bookmark/**')
    ok(
      (await page.getByTestId('bm-title').textContent()) === 'Designing Data-Intensive Applications',
      'detail page shows the title',
    )
    ok((await page.getByTestId('bm-url').textContent())?.includes('dataintensive.net') ?? false, 'url rendered')
    ok((await page.getByTestId('bm-note').textContent())?.includes('the red book') ?? false, 'note rendered')
    ok((await page.getByTestId('bm-status').textContent())?.trim() === 'unread', 'starts as unread')

    const detailUrl = page.url()
    const id = detailUrl.split('/bookmark/')[1]

    console.log('change status to reading')
    await page.getByTestId('set-reading').click()
    await page.waitForURL('**/bookmark/**')
    ok((await page.getByTestId('bm-status').textContent())?.trim() === 'reading', 'status now reading')
    ok(await page.getByTestId('set-reading').isDisabled(), 'current status button is disabled')

    console.log('add two tags')
    await page.getByTestId('tag-input').fill('databases')
    await page.getByTestId('add-tag').click()
    await page.waitForURL('**/bookmark/**')
    await page.getByTestId('tag-databases').waitFor()
    ok(await page.getByTestId('tag-databases').isVisible(), 'databases tag appears')
    await page.getByTestId('tag-input').fill('must-read')
    await page.getByTestId('add-tag').click()
    await page.getByTestId('tag-must-read').waitFor()
    ok(await page.getByTestId('tag-must-read').isVisible(), 'must-read tag appears')

    console.log('remove one tag')
    await page.getByTestId('untag-databases').click()
    await page.waitForURL('**/bookmark/**')
    ok((await page.getByTestId('tag-databases').count()) === 0, 'databases tag removed')
    ok(await page.getByTestId('tag-must-read').isVisible(), 'must-read tag remains')

    console.log('it shows on the home list with status + tag')
    await page.goto(base + '/')
    await page.getByTestId(`item-${id}`).waitFor()
    ok(await page.getByTestId(`title-${id}`).isVisible(), 'bookmark listed on home')
    ok((await page.getByTestId(`tags-${id}`).textContent())?.includes('must-read') ?? false, 'home list shows the tag')

    console.log('status filter')
    await page.getByTestId('filter-reading').click()
    await page.waitForURL('**/?status=reading')
    ok(await page.getByTestId(`item-${id}`).isVisible(), 'reading filter shows the bookmark')
    await page.getByTestId('filter-done').click()
    await page.waitForURL('**/?status=done')
    ok((await page.getByTestId(`item-${id}`).count()) === 0, 'done filter hides the reading bookmark')
    ok((await page.getByTestId('empty').textContent())?.includes('Nothing here yet') ?? false, 'done filter empty state')

    console.log('reload -> persisted')
    await page.goto(detailUrl)
    await page.reload()
    ok((await page.getByTestId('bm-status').textContent())?.trim() === 'reading', 'status persisted across reload')
    ok(await page.getByTestId('tag-must-read').isVisible(), 'tag persisted across reload')

    console.log('open the bookmark URL directly (own route)')
    await page.goto(detailUrl)
    ok(
      (await page.getByTestId('bm-title').textContent()) === 'Designing Data-Intensive Applications',
      'detail URL loads the bookmark directly',
    )

    console.log('delete')
    await page.getByTestId('delete').click()
    await page.waitForURL((u) => u.pathname === '/')
    ok((await page.getByTestId('empty').textContent())?.includes('Nothing here yet') ?? false, 'list empty after delete')

    console.log('a bad bookmark id shows the 404 view')
    const resp = await page.goto(base + '/bookmark/999999')
    ok(resp?.status() === 404, 'unknown bookmark returns HTTP 404')
    ok((await page.locator('h1').textContent())?.includes('no such bookmark') ?? false, '404 page rendered')
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
