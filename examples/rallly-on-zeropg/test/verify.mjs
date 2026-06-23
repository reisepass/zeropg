import { chromium } from 'playwright'
import pg from 'pg'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const fivexx = []
page.on('response', (r) => { if (r.status() >= 500) fivexx.push(`${r.status()} ${r.url()}`) })

await page.goto('http://localhost:3000/register', { waitUntil: 'networkidle', timeout: 30000 })
await page.locator('input[name="name"]').fill('Zeropg Demo')
await page.locator('input[name="email"]').fill('zeropg-demo@example.com')
await page.locator('input[name="password"]').fill('demo-password-1234')
await page.getByRole('button', { name: /continue/i }).click()
await page.waitForLoadState('networkidle')
await page.waitForTimeout(2000)
console.log('after register -> url:', page.url())
console.log('page says:', (await page.locator('body').innerText()).slice(0, 200).replace(/\s+/g, ' '))
await page.screenshot({ path: 'examples/rallly-on-zeropg/test/after-register.png' })
console.log('5xx:', fivexx.length ? fivexx : 'none')
await browser.close()

const client = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5450/rallly' })
await client.connect()
const tables = (await client.query(`select table_name from information_schema.tables where table_schema='public'`)).rows.map((r) => r.table_name)
const rows = {}
for (const t of tables) rows[t] = (await client.query(`select count(*)::int n from "${t}"`)).rows[0].n
console.log('\nnon-empty zeropg tables:', Object.entries(rows).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`).join(', '))
// show user rows if any
for (const t of tables) if (/^user/i.test(t)) {
  const r = await client.query(`select id, name, email from "${t}" limit 3`).catch(() => null)
  if (r) console.log(`${t} rows:`, JSON.stringify(r.rows))
}
await client.end()
