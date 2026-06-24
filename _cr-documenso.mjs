import { chromium } from 'playwright'
const URL='https://documenso-zeropg-71428757273.europe-west1.run.app'
const email=`cloudrun-${Math.floor(Math.random()*1e9)}@example.com`
const b=await chromium.launch(); const p=await b.newPage()
const fivexx=[]; p.on('response',r=>{if(r.status()>=500)fivexx.push(r.status())})
await p.goto(URL+'/signup',{waitUntil:'networkidle',timeout:60000})
await p.locator('input[name="name"]').fill('Cloudrun Demo')
await p.locator('input[name="email"]').fill(email)
await p.locator('input[name="password"]').fill('demo-password-1234')
// signature: click below "Sign Here", Type tab, fill, Next
try {
  const sign = p.getByText('Sign Here'); await sign.scrollIntoViewIfNeeded()
  const box = await sign.boundingBox(); if (box) await p.mouse.click(box.x+box.width/2, box.y+80)
  await p.waitForTimeout(500)
  await p.getByRole('tab',{name:/type/i}).click().catch(()=>{})
  await p.getByPlaceholder(/type your signature/i).fill('Cloudrun Demo').catch(()=>{})
  await p.getByRole('button',{name:/next/i}).click().catch(()=>{})
} catch(e){ console.log('signature step note:', e.message.slice(0,50)) }
await p.waitForTimeout(800)
await p.getByRole('button',{name:/create account/i}).click().catch(()=>{})
await p.waitForLoadState('networkidle'); await p.waitForTimeout(2500)
console.log('after signup url:', p.url(), '| 5xx:', fivexx.length?fivexx:'none')
await b.close()
