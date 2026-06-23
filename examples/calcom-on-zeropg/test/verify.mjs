// End-to-end proof: drive the REAL, unmodified Cal.com (official prebuilt image)
// through its signup UI to a DB write, then read the row back from zeropg-db over
// a plain `pg` wire. No app source patched; no DB stubbed.
//
//   APP=http://localhost:3101  PG=postgres://postgres:postgres@127.0.0.1:5461/calendso
import { chromium } from 'playwright'
import pg from 'pg'

const APP = process.env.APP || 'http://localhost:3101'
const PG = process.env.PG || 'postgres://postgres:postgres@127.0.0.1:5461/calendso'
const stamp = Date.now()
const user = {
  username: `zeropg-demo-${stamp}`,
  email: `zeropg-demo-${stamp}@example.com`,
  password: 'Demo-Password-1234',
  name: 'Zeropg Demo',
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const fivexx = []
const signupResponses = []
page.on('response', (r) => {
  if (r.status() >= 500) fivexx.push(`${r.status()} ${r.url()}`)
  if (r.url().includes('/api/auth/signup')) signupResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`)
})

console.log(`[verify] signup as ${user.email}`)
await page.goto(`${APP}/signup`, { waitUntil: 'networkidle', timeout: 60000 })
// Cal.com gates the email/password form behind a "Continue with Email" button.
await page.getByTestId('continue-with-email-button').click()
// Cal.com's real signup form (stable data-testid selectors, not patched by us).
await page.getByTestId('signup-usernamefield').waitFor({ state: 'visible', timeout: 30000 })
await page.getByTestId('signup-usernamefield').fill(user.username)
await page.getByTestId('signup-emailfield').fill(user.email)
await page.getByTestId('signup-passwordfield').fill(user.password)
await page.getByTestId('signup-cookie-content-checkbox').check().catch(() => {})
await page.getByTestId('signup-submit-button').click()

// Wait for the signup POST to return (the row write happens server-side here).
await page.waitForResponse((r) => r.url().includes('/api/auth/signup'), { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(3000)

console.log('[verify] signup API responses:', signupResponses.length ? signupResponses : '(none captured)')
console.log('[verify] url after submit:', page.url())
console.log('[verify] body:', (await page.locator('body').innerText()).slice(0, 200).replace(/\s+/g, ' '))
await page.screenshot({ path: new URL('./after-signup.png', import.meta.url).pathname }).catch(() => {})
console.log('[verify] 5xx:', fivexx.length ? fivexx : 'none')
await browser.close()

// Read the row back from zeropg-db over the real Postgres wire.
const client = new pg.Client({ connectionString: PG })
await client.connect()
const tableCount = (await client.query(
  `select count(*)::int n from information_schema.tables where table_schema='public'`,
)).rows[0].n
const userRows = await client.query(
  `select id, username, email, created, "identityProvider", "creationSource" from "users" where email = $1`,
  [user.email],
)
const totalUsers = (await client.query(`select count(*)::int n from "users"`)).rows[0].n
// The hashed password lands in a separate UserPassword table — prove it too.
const pwRows = userRows.rows.length
  ? await client.query(
      `select "userId", hash as bcrypt_hash from "UserPassword" where "userId" = $1`,
      [userRows.rows[0].id],
    )
  : { rows: [] }

console.log('\n[verify] zeropg-db public tables:', tableCount)
console.log('[verify] total users in zeropg:', totalUsers)
console.log('[verify] the row Cal.com wrote for our signup:')
console.log(JSON.stringify(userRows.rows, null, 2))
console.log('[verify] the matching UserPassword row (hashed password):')
console.log(JSON.stringify(pwRows.rows, null, 2))
await client.end()

const wrote = userRows.rows.length === 1
console.log(`\n[verify] RESULT: ${wrote && fivexx.length === 0 ? 'PASS' : 'FAIL'}` +
  ` (row written=${wrote}, 5xx=${fivexx.length})`)
process.exit(wrote && fivexx.length === 0 ? 0 : 1)
