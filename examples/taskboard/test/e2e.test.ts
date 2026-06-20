// Run: tsx examples/taskboard/test/e2e.test.ts   (chromium must be installed:
//      npx playwright install chromium)
//
// Drives the REAL UI in a headless browser end-to-end (not curl + 200): boots the
// app on a temp file://, then clicks through add -> appears -> toggle -> moves to
// Done -> open the detail route -> save notes -> reload -> persisted. Asserts on
// the live DOM at each step, so it proves the forms fire, state updates, and the
// data round-trips through PGlite on disk.

import { chromium, type Browser } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDb } from '../db.js'
import { createApp } from '../app.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-e2e-'))
  const { db } = await openDb(`file://${join(dir, 'tb.db')}`)
  const app = createApp(db)
  await new Promise<void>((r) => app.listen(0, r))
  const base = `http://localhost:${(app.address() as AddressInfo).port}`

  let browser: Browser | null = null
  try {
    browser = await chromium.launch()
    const page = await browser.newPage()

    console.log('board loads on the file:// engine')
    await page.goto(base + '/')
    ok((await page.getByTestId('engine').textContent()) === 'file', 'engine badge shows file')
    ok(await page.getByTestId('add').isVisible(), 'add form is present')

    console.log('add a task via the form -> it renders under To do')
    await page.getByTestId('new-title').fill('drive the demo')
    await page.getByTestId('new-priority').selectOption('1')
    await page.getByTestId('add').click()
    await page.waitForLoadState() // form POST -> 303 -> board reload
    const todoList = page.getByTestId('todo-list')
    await todoList.getByText('drive the demo').waitFor()
    ok(await todoList.getByText('drive the demo').isVisible(), 'new task appears in To do')

    console.log('toggle -> task moves from To do to Done')
    // task id is 1 (fresh datadir); click its toggle button.
    await page.getByTestId('toggle-1').click()
    await page.waitForLoadState()
    ok(
      await page.getByTestId('done-list').getByText('drive the demo').isVisible(),
      'task now under Done',
    )
    ok(
      (await page.getByTestId('task-1').getAttribute('data-status')) === 'done',
      'task row marked data-status=done',
    )

    console.log('detail route /task/1 has its own URL + content')
    await page.getByTestId('task-1').getByText('drive the demo').click()
    await page.waitForURL('**/task/1')
    ok((await page.getByTestId('task-title').textContent()) === 'drive the demo', 'detail shows title')
    ok((await page.getByTestId('task-status').textContent()) === 'done', 'detail shows done status')

    console.log('save notes -> persisted across a reload')
    await page.getByTestId('notes').fill('record at 1080p, 30s max')
    await page.getByTestId('save-notes').click()
    await page.waitForURL('**/task/1')
    await page.reload()
    ok(
      (await page.getByTestId('notes').inputValue()) === 'record at 1080p, 30s max',
      'notes survived save + reload (on-disk round-trip)',
    )

    console.log('delete from the board -> gone')
    await page.goto(base + '/')
    await page.getByTestId('delete-1').click()
    await page.waitForLoadState()
    ok(
      (await page.getByTestId('done-list').textContent())?.includes('nothing here') ?? false,
      'Done list empty after delete',
    )
  } finally {
    if (browser) await browser.close()
    await new Promise<void>((r) => app.close(() => r()))
    await db.end()
    await rm(dir, { recursive: true, force: true })
  }

  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
