// End-to-end proof: register a user through Documenso's REAL signup UI (served on
// zeropg), then read the written rows back from zeropg-db via a raw pg client.
import { chromium } from 'playwright'
import pg from 'pg'

const APP = 'http://localhost:3102'
const PG = 'postgres://postgres:postgres@127.0.0.1:5462/documenso?sslmode=disable'
const EMAIL = `zeropg-demo-${Date.now()}@example.com`
const NAME = 'Zeropg Demo'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
const fivexx = []
page.on('response', (r) => { if (r.status() >= 500) fivexx.push(`${r.status()} ${r.url()}`) })

await page.goto(`${APP}/signup`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(1000)

await page.locator('input[name="name"]').fill(NAME)
await page.locator('input[name="email"]').fill(EMAIL)
await page.locator('input[name="password"]').fill('Zeropg-Demo-Passw0rd!')

// Signature is required client-side. Open the signature pad by clicking inside
// the "Sign Here" box (the box's onClick opens the dialog), switch to the "Type"
// tab, type a signature, confirm with "Next".
const labelBox = await page.locator('text=Sign Here').first().boundingBox()
await page.mouse.click(labelBox.x + 100, labelBox.y + 80)
await page.locator('[role="dialog"]').waitFor({ timeout: 10000 })

await page.getByRole('tab', { name: /type/i }).click()
await page.waitForTimeout(300)
const typeInput = page.getByPlaceholder(/type your signature/i)
await typeInput.waitFor({ timeout: 5000 })
await typeInput.fill('Zeropg Demo')
await page.waitForTimeout(300)

// Confirm the signature dialog (button reads "Next").
await page.locator('[role="dialog"]').getByRole('button', { name: /next/i }).click()
await page.waitForTimeout(800)

// Submit the registration.
await page.getByRole('button', { name: /create account/i }).click()
await page.waitForLoadState('networkidle').catch(() => {})
await page.waitForTimeout(3000)

console.log('after submit -> url:', page.url())
console.log('page says:', (await page.locator('body').innerText()).slice(0, 240).replace(/\s+/g, ' '))
await page.screenshot({ path: '/Users/user/workspace/zeropg/examples/documenso-on-zeropg/test/after-register.png', fullPage: true })
console.log('5xx during signup:', fivexx.length ? fivexx : 'none')
await browser.close()

// Read the written rows back from zeropg.
const client = new pg.Client({ connectionString: PG })
await client.connect()
const u = await client.query(
  `select id, name, email, "emailVerified", "createdAt" from "User" where email = $1`, [EMAIL.toLowerCase()])
console.log('\n=== zeropg "User" row for', EMAIL, '===')
console.log(JSON.stringify(u.rows, null, 2))

// Personal organisation created by onCreateUserHook for the new user.
const org = await client.query(
  `select o.id, o.name, o.type from "Organisation" o
   join "OrganisationMember" m on m."organisationId" = o.id
   join "User" usr on usr.id = m."userId"
   where usr.email = $1`, [EMAIL.toLowerCase()]).catch((e) => ({ rows: [], err: e.message }))
console.log('\n=== personal Organisation(s) for the new user ===')
console.log(JSON.stringify(org.rows, null, 2))
if (org.err) console.log('org query note:', org.err)

const counts = {}
for (const t of ['User', 'Organisation', 'OrganisationMember', 'Account', 'Team']) {
  const r = await client.query(`select count(*)::int n from "${t}"`).catch(() => ({ rows: [{ n: 'n/a' }] }))
  counts[t] = r.rows[0].n
}
console.log('\n=== table counts in zeropg ===')
console.log(JSON.stringify(counts))

const ok = u.rows.length === 1 && u.rows[0].email === EMAIL.toLowerCase()
console.log('\nRESULT:', ok ? 'PASS — user row written to zeropg via Documenso over the wire' : 'FAIL — no user row found')
await client.end()
process.exit(ok ? 0 : 1)
