import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
for (const path of ['/auth/signup','/signup']) {
  const r = await page.goto('http://localhost:3101'+path, { waitUntil:'domcontentloaded', timeout:30000 }).catch(()=>null)
  if (r) { console.log('GET',path,'->',r.status(),'final url',page.url()); if (r.status()<400) break }
}
await page.waitForTimeout(2000)
const inputs = await page.locator('input').evaluateAll(els=>els.map(e=>({type:e.type,name:e.name,placeholder:e.placeholder})))
const buttons = await page.locator('button').evaluateAll(els=>els.map(e=>e.innerText.trim()).filter(Boolean))
console.log('inputs:', JSON.stringify(inputs))
console.log('buttons:', JSON.stringify(buttons))
await browser.close()
