import { chromium } from 'playwright'
const URL = 'https://nocodb-zeropg-4sowr32yyq-ew.a.run.app'
const email = `cloudrun-${Math.floor(Math.random()*1e9)}@zeropg.example.com`
const b = await chromium.launch(); const p = await b.newPage()
const fivexx = []; p.on('response', r => { if (r.status() >= 500) fivexx.push(r.status()+' '+r.url().slice(0,60)) })
await p.goto(URL + '/', { waitUntil:'networkidle', timeout:60000 })
await p.waitForTimeout(2000)
console.log('landed at:', p.url())
await p.locator('input[type="email"]').first().fill(email)
await p.locator('input[type="password"]').first().fill('Zeropg-Demo-1234!')
await p.getByRole('button', { name: /sign ?up/i }).first().click().catch(async()=>{ await p.locator('button[type="submit"]').first().click() })
await p.waitForTimeout(4000)
console.log('after signup url:', p.url(), '| 5xx:', fivexx.length?fivexx:'none')
await b.close()
