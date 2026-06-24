import { chromium } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDb } from '../db.js'
import { createApp } from '../app.js'

const dir = await mkdtemp(join(tmpdir(), 'sl-dbg-'))
const { db } = await openDb(`file://${join(dir, 'sl.db')}`)
const app = createApp(db)
await new Promise<void>((r) => app.listen(0, r))
const base = `http://localhost:${(app.address() as AddressInfo).port}`
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(base + '/')
await page.getByTestId('new-url').fill(base + '/links')
await page.getByTestId('shorten').click()
await page.waitForLoadState()
console.log('URL after submit:', page.url())
console.log('has code testid:', await page.getByTestId('code').count())
await browser.close()
await app.close()
await db.end()
await rm(dir, { recursive: true, force: true })
