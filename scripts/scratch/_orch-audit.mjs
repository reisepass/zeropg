import { chromium } from 'playwright'
import pg from 'pg'
const ts = Date.now()

// 1) INDEPENDENT Cal.com signup (drive it myself; a NEW row must appear with MY email)
const email = `orch-audit-${ts}@example.com`
const user = `orchaudit${ts}`
const browser = await chromium.launch()
const page = await browser.newPage()
const fivexx = []
page.on('response', r => { if (r.status() >= 500) fivexx.push(r.status()+' '+r.url()) })
await page.goto('http://localhost:3101/signup', { waitUntil:'networkidle', timeout:45000 })
await page.getByTestId('continue-with-email-button').click().catch(()=>{})
await page.waitForTimeout(800)
await page.getByTestId('signup-usernamefield').fill(user)
await page.getByTestId('signup-emailfield').fill(email)
await page.getByTestId('signup-passwordfield').fill('Zeropg-Demo-1234!')
await page.getByTestId('signup-cookie-content-checkbox').check().catch(()=>{})
await page.getByTestId('signup-submit-button').click()
await page.waitForTimeout(3500)
console.log('[cal] submitted; 5xx:', fivexx.length?fivexx:'none')
await browser.close()
const cal = new pg.Client({ connectionString:'postgres://x:x@127.0.0.1:5461/calendso' }); await cal.connect()
const calRow = await cal.query('select id,username,email from users where email=$1',[email])
console.log('[cal] my signup row in zeropg:', JSON.stringify(calRow.rows[0]||'NOT FOUND'))
await cal.end()

// 2) Documenso: confirm the agent's claimed user row exists (written by native Prisma engine)
const doc = new pg.Client({ connectionString:'postgres://x:x@127.0.0.1:5462/documenso?sslmode=disable' }); await doc.connect()
const docRows = await doc.query(`select id,name,email from "User" order by id`)
console.log('[documenso] User rows:', JSON.stringify(docRows.rows))
await doc.end()

// 3) NocoDB: confirm admin + the per-base physical row
const nc = new pg.Client({ connectionString:'postgres://x:x@127.0.0.1:5463/postgres' }); await nc.connect()
const ncAdmin = await nc.query(`select email,roles from nc_users_v2`)
console.log('[nocodb] nc_users_v2:', JSON.stringify(ncAdmin.rows))
const baseSchemas = await nc.query(`select schema_name from information_schema.schemata where schema_name not in ('public','pg_catalog','information_schema','pg_toast')`)
for (const s of baseSchemas.rows) {
  const cust = await nc.query(`select * from "${s.schema_name}"."Customers" limit 3`).catch(()=>null)
  if (cust) console.log(`[nocodb] ${s.schema_name}.Customers:`, JSON.stringify(cust.rows.map(r=>({id:r.id,title:r.title}))))
}
await nc.end()
