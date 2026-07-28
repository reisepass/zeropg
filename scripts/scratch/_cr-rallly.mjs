import { chromium } from 'playwright'
const URL = 'https://rallly-zeropg-71428757273.europe-west1.run.app'
const email = `cloudrun-${Math.floor(Math.random()*1e9)}@example.com`
const b = await chromium.launch(); const p = await b.newPage()
const fivexx=[]; p.on('response', r=>{ if(r.status()>=500) fivexx.push(r.status()+' '+r.url().slice(0,70)) })
await p.goto(URL+'/register', { waitUntil:'networkidle', timeout:60000 })
await p.locator('input[name="name"]').fill('Cloudrun Demo')
await p.locator('input[name="email"]').fill(email)
await p.locator('input[name="password"]').fill('demo-password-1234')
await p.getByRole('button',{name:/continue/i}).click()
await p.waitForLoadState('networkidle'); await p.waitForTimeout(2500)
console.log('after register -> url:', p.url())
console.log('page:', (await p.locator('body').innerText()).slice(0,120).replace(/\s+/g,' '))
console.log('5xx:', fivexx.length?fivexx:'none')
await b.close()
