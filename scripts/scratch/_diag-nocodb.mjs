import { chromium } from 'playwright'
const URL = 'https://nocodb-zeropg-71428757273.europe-west1.run.app/signin'
const b = await chromium.launch(); const p = await b.newPage()
const slow=[], bad=[]
p.on('response', r => { const t=r.request().timing(); if (r.status()>=400) bad.push(r.status()+' '+r.url().split('/').pop()) })
const t0=Date.now()
const resp = await p.goto(URL, { waitUntil:'domcontentloaded', timeout:60000 }).catch(e=>({status:()=>'ERR '+e.message.slice(0,40)}))
console.log('initial GET ->', typeof resp.status==='function'?resp.status():resp, 'in', ((Date.now()-t0)/1000).toFixed(1)+'s')
await p.waitForTimeout(4000)
const formVisible = await p.locator('input[type="email"], input[type="password"]').first().isVisible().catch(()=>false)
console.log('login form visible on first load:', formVisible)
console.log('4xx/5xx responses:', bad.length?bad.slice(0,8):'none')
await b.close()
