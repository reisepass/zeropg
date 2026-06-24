import { chromium } from 'playwright'
import pg from 'pg'
const ts = Date.now()
const email = `orch2-${ts}@example.com`, user = `orch2x${ts}`
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('response', async r => {
  if (r.url().includes('/api/auth/signup') || r.url().includes('/api/trpc')) {
    let body=''; try{ body=(await r.text()).slice(0,200) }catch{}
    console.log('RESP', r.status(), r.url().split('?')[0], '|', body.replace(/\s+/g,' '))
  }
})
await page.goto('http://localhost:3101/signup', { waitUntil:'networkidle', timeout:45000 })
const hadBtn = await page.getByTestId('continue-with-email-button').count()
if (hadBtn) await page.getByTestId('continue-with-email-button').click()
await page.waitForTimeout(800)
await page.getByTestId('signup-usernamefield').fill(user)
await page.getByTestId('signup-emailfield').fill(email)
await page.getByTestId('signup-passwordfield').fill('Zeropg-Demo-1234!')
const cb = page.getByTestId('signup-cookie-content-checkbox')
console.log('cookie checkbox present:', await cb.count())
if (await cb.count()) await cb.check()
const submit = page.getByTestId('signup-submit-button')
console.log('submit disabled?', await submit.isDisabled().catch(()=>'n/a'))
await submit.click()
await page.waitForTimeout(4000)
await page.screenshot({ path:'_cal-debug.png' })
const errText = await page.locator('[role="alert"], .text-red-500, [data-testid*="error"]').allInnerTexts().catch(()=>[])
console.log('visible errors:', JSON.stringify(errText.slice(0,5)))
console.log('url after submit:', page.url())
await browser.close()
const cal = new pg.Client({ connectionString:'postgres://x:x@127.0.0.1:5461/calendso' }); await cal.connect()
console.log('total users now:', (await cal.query('select count(*)::int n from users')).rows[0].n)
console.log('my row:', JSON.stringify((await cal.query('select id,username,email from users where email=$1',[email])).rows[0]||'NOT FOUND'))
await cal.end()
