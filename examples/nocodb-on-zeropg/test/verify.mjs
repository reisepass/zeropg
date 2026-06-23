// End-to-end proof that NocoDB runs with its metadata DB replaced by zeropg.
// Drives the REAL NocoDB UI in a browser: signs up the super-admin, creates a
// base + a table, inserts a row — then reads it all back out of zeropg over the
// real Postgres wire with a plain `pg` client. No NocoDB source is patched.

import { chromium } from 'playwright'
import pg from 'pg'

const APP = 'http://localhost:3103'
const PGURL = 'postgres://postgres:postgres@127.0.0.1:5463/postgres'
const EMAIL = 'admin@zeropg.example.com'
const PASSWORD = 'Zeropg-Demo-1234!'
const BASE = 'Zeropg Demo Base'
const TABLE = 'Customers'
const ROW_TITLE = 'Ada Lovelace'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const fivexx = []
page.on('response', (r) => { if (r.status() >= 500) fivexx.push(`${r.status()} ${r.url()}`) })

// --- sign up (super admin) or sign in if already created ---
await page.goto(`${APP}/`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2000)
if (await page.locator('input[type="email"]').count()) {
  await page.locator('input[type="email"]').first().fill(EMAIL)
  await page.locator('input[type="password"]').first().fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|sign up/i }).first().click()
  await page.waitForTimeout(6000)
}
const skip = page.getByRole('button', { name: /^Skip$/i })
if (await skip.count()) { await skip.first().click().catch(() => {}); await page.waitForTimeout(1500) }
console.log('signed in ->', page.url())

// --- create the base (idempotent: reuse if it exists) ---
if (await page.getByText(BASE, { exact: true }).count() === 0) {
  await page.getByRole('button', { name: /New Base/i }).first().click()
  await page.waitForTimeout(1500)
  await page.locator('input[placeholder="Title"]:visible').first().fill(BASE)
  await page.getByRole('button', { name: /^Create Base$/i }).click()
  await page.waitForTimeout(6000)
} else {
  await page.getByText(BASE, { exact: true }).first().click()
  await page.waitForTimeout(3000)
}
console.log('base ready ->', page.url())

// --- create a table ---
await page.getByText('Create New Table', { exact: false }).first().click()
await page.waitForTimeout(2000)
await page.locator('input[placeholder="Enter table name"]:visible').first().fill(TABLE)
await page.getByRole('button', { name: /^Create Table$/i }).click()
await page.waitForTimeout(6000)
console.log('table created ->', page.url())
await page.screenshot({ path: new URL('./table-grid.png', import.meta.url).pathname, fullPage: true })

// --- insert a row ---
// NocoDB's grid is canvas-rendered (cells are NOT DOM nodes), so the row is
// addressed by clicking the canvas at the cell's coordinates. "New record"
// appends an empty row; click its Title cell, press Enter to edit, type, commit.
await page.getByRole('button', { name: /New record/i }).first().click()
await page.waitForTimeout(1500)
const canvas = page.locator('canvas').first()
const box = await canvas.boundingBox()
await page.mouse.click(box.x + 120, box.y + 54) // first data row, Title column
await page.waitForTimeout(400)
await page.keyboard.press('Enter')
await page.keyboard.type(ROW_TITLE)
await page.keyboard.press('Escape')
await page.waitForTimeout(3000)
await page.screenshot({ path: new URL('./row-inserted.png', import.meta.url).pathname, fullPage: true })
console.log('5xx during UI flow:', fivexx.length ? fivexx : 'none')
await browser.close()

// --- read it all back out of zeropg over the wire ---
const client = new pg.Client({ connectionString: PGURL })
await client.connect()

const ncTables = (await client.query(
  `select count(*)::int n from information_schema.tables where table_schema='public' and table_name like 'nc%'`,
)).rows[0].n
const users = (await client.query(`select email, roles from nc_users_v2 order by created_at`)).rows
const bases = (await client.query(`select id, title from nc_bases_v2 order by created_at`)).rows
const models = (await client.query(`select id, title, table_name, base_id from nc_models_v2 order by created_at`)).rows

console.log('\n=== zeropg metadata (read over the wire) ===')
console.log('nc* metadata tables:', ncTables)
console.log('users:', users)
console.log('bases:', bases.map((b) => b.title))
console.log('tables (nc_models_v2):', models.map((m) => m.title))

// NocoDB creates a dedicated Postgres SCHEMA per base (named by the base id) and
// puts each table's physical table inside it: "<base_id>"."<table_name>".
// Resolve our table's schema + physical name and read the row we inserted back.
const model = models.find((m) => m.title === TABLE)
if (model) {
  const schema = model.base_id
  const phys = model.table_name
  const cnt = (await client.query(`select count(*)::int n from "${schema}"."${phys}"`)).rows[0].n
  const sample = (await client.query(`select * from "${schema}"."${phys}" limit 5`)).rows
  console.log(`\nphysical data table "${schema}"."${phys}": ${cnt} row(s)`)
  console.log('rows:', JSON.stringify(sample, null, 2))
}
await client.end()
