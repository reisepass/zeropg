import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)
const inputs = await page.locator('input').evaluateAll((els) =>
  els.map((e) => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder })))
const buttons = await page.locator('button').evaluateAll((els) => els.map((e) => e.innerText.trim()).filter(Boolean))
console.log('inputs:', JSON.stringify(inputs))
console.log('buttons:', JSON.stringify(buttons))
console.log('forms:', await page.locator('form').count())
await browser.close()
