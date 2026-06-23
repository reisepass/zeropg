// End-to-end proof that PrivateBin stores pastes in zeropg over the Postgres wire.
//
// 1. Browser (Playwright): open PrivateBin, type a unique secret, click Send,
//    capture the resulting paste URL, open it in a FRESH page, assert the decrypted
//    text matches. PrivateBin encrypts client-side, so a correct round-trip proves
//    the ciphertext was persisted and retrieved through zeropg.
// 2. Postgres (`pg`): connect to zeropg-db on 127.0.0.1:5464 and show the stored
//    paste row (an opaque encrypted blob — expected) and that the row count grew.

import { chromium } from 'playwright'
import pg from 'pg'

const APP = process.env.APP_URL || 'http://localhost:3104'
const PG = process.env.PG_URL || 'postgres://postgres:postgres@127.0.0.1:5464/privatebin'
const SECRET = `zeropg-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

// ---- row count BEFORE (proves the count grows by exactly our paste) ----
const before = new pg.Client({ connectionString: PG })
await before.connect()
const tableExists = async (c) =>
  (await c.query(
    `select count(*)::int n from information_schema.tables where table_schema='public' and table_name='privatebin_paste'`,
  )).rows[0].n > 0
const countBefore = (await tableExists(before))
  ? (await before.query(`select count(*)::int n from privatebin_paste`)).rows[0].n
  : 0
console.log('paste rows before:', countBefore)
await before.end()

// ---- browser round-trip ----
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const fivexx = []
page.on('response', (r) => { if (r.status() >= 500) fivexx.push(`${r.status()} ${r.url()}`) })

await page.goto(APP, { waitUntil: 'networkidle', timeout: 30000 })
await page.screenshot({ path: 'examples/privatebin-on-zeropg/test/landing.png' })

// type the secret into the paste textarea
const ta = page.locator('#message')
await ta.waitFor({ state: 'visible', timeout: 15000 })
await ta.fill(SECRET)

// #sendbutton starts hidden; typing text reveals it. Click it once visible.
const send = page.locator('#sendbutton')
await send.waitFor({ state: 'visible', timeout: 15000 })
await send.click()

// after sending, PrivateBin shows the paste URL (in #pasteurl) and navigates to it
await page.waitForFunction(() => location.hash.length > 10, { timeout: 20000 })
await page.waitForLoadState('networkidle')
const pasteUrl = page.url()
console.log('paste URL:', pasteUrl)
await page.screenshot({ path: 'examples/privatebin-on-zeropg/test/after-send.png' })

// open the paste in a fresh context (no shared JS state) and read it back
const page2 = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const fivexx2 = []
page2.on('response', (r) => { if (r.status() >= 500) fivexx2.push(`${r.status()} ${r.url()}`) })
await page2.goto(pasteUrl, { waitUntil: 'networkidle', timeout: 30000 })
// the decrypted plaintext renders into #prettyprint / .plaintext
await page2.waitForFunction(
  (secret) => document.body.innerText.includes(secret),
  SECRET,
  { timeout: 20000 },
).catch(() => {})
const decrypted = await page2.locator('#prettymessage, #prettyprint, .plaintext, pre').first().innerText().catch(() => '')
const bodyText = await page2.locator('body').innerText()
const roundTripOk = bodyText.includes(SECRET)
console.log('round-trip decrypted contains secret:', roundTripOk)
console.log('decrypted view (first 120 chars):', (decrypted || bodyText).slice(0, 120).replace(/\s+/g, ' '))
await page2.screenshot({ path: 'examples/privatebin-on-zeropg/test/reopened.png' })

console.log('5xx (create):', fivexx.length ? fivexx : 'none')
console.log('5xx (read):', fivexx2.length ? fivexx2 : 'none')
await browser.close()

// ---- read the stored row back out of zeropg ----
const after = new pg.Client({ connectionString: PG })
await after.connect()
const pubTables = (await after.query(
  `select table_name from information_schema.tables where table_schema='public' order by table_name`,
)).rows.map((r) => r.table_name)
console.log('\nzeropg public tables:', pubTables.join(', '))
const countAfter = (await after.query(`select count(*)::int n from privatebin_paste`)).rows[0].n
console.log('paste rows after:', countAfter, `(delta ${countAfter - countBefore})`)
const row = (await after.query(
  `select dataid, left(data, 80) as data_head, length(data) as data_len, expiredate from privatebin_paste order by expiredate desc nulls last limit 1`,
)).rows[0]
console.log('newest stored paste row:', JSON.stringify(row))
await after.end()

// ---- verdict ----
const pass = roundTripOk && countAfter === countBefore + 1 && fivexx.length === 0 && fivexx2.length === 0
console.log('\nRESULT:', pass ? 'PASS — paste round-tripped through zeropg' : 'FAIL')
process.exit(pass ? 0 : 1)
