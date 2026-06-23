import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
const errs = []
page.on('response', (r) => { if (r.status() >= 500) errs.push(`${r.status()} ${r.url()}`) })

await page.goto('http://localhost:3102/signup', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(1500)
console.log('url:', page.url())
console.log('title:', await page.title())

// dump named inputs
const inputs = await page.locator('input').evaluateAll((els) =>
  els.map((e) => ({ name: e.name, type: e.type, placeholder: e.placeholder })))
console.log('inputs:', JSON.stringify(inputs))

// dump button texts
const buttons = await page.locator('button').evaluateAll((els) =>
  els.map((e) => (e.textContent || '').trim()).filter(Boolean))
console.log('buttons:', JSON.stringify(buttons))

await page.screenshot({ path: '/Users/user/workspace/zeropg/examples/documenso-on-zeropg/test/signup-page.png', fullPage: true })
console.log('5xx:', errs.length ? errs : 'none')
await browser.close()
