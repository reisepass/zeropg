import { chromium } from 'playwright'
import pg from 'pg'

const SECRET = 'zeropg-orchestrator-audit-' + Math.floor(Math.random()*1e9)
const browser = await chromium.launch()
const page = await browser.newPage()
const fivexx = []
page.on('response', r => { if (r.status() >= 500) fivexx.push(r.status()+' '+r.url()) })

await page.goto('http://localhost:3104/', { waitUntil: 'networkidle', timeout: 30000 })
await page.locator('#message').fill(SECRET)
// send button
await page.locator('#sendbutton, button:has-text("Create"), button:has-text("Send")').first().click()
await page.waitForTimeout(2500)
const pasteUrl = page.url()
console.log('paste URL:', pasteUrl)
// open it fresh and read back the decrypted text
const p2 = await browser.newPage()
await p2.goto(pasteUrl, { waitUntil: 'networkidle', timeout: 30000 })
await p2.waitForTimeout(2000)
const shown = await p2.locator('#prettyprint, #cleartext, .prettyprint, pre').first().innerText().catch(()=> '')
const match = shown.includes(SECRET)
console.log('round-trip match:', match, '| shown snippet:', shown.slice(0,60))
console.log('5xx:', fivexx.length ? fivexx : 'none')
await browser.close()

// read back from zeropg directly
const client = new pg.Client({ connectionString: 'postgres://x:x@127.0.0.1:5464/privatebin' })
await client.connect()
const t = await client.query(`select table_name from information_schema.tables where table_schema='public' order by table_name`)
console.log('zeropg tables:', t.rows.map(r=>r.table_name).join(', '))
for (const row of t.rows) {
  if (/paste|data/i.test(row.table_name)) {
    const c = await client.query(`select count(*)::int n from "${row.table_name}"`)
    console.log(`  ${row.table_name}: ${c.rows[0].n} rows`)
  }
}
await client.end()
console.log(match && fivexx.length===0 ? '\nAUDIT PASS: PrivateBin paste round-trips through zeropg' : '\nAUDIT FAIL')
