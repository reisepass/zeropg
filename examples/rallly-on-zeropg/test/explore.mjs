import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const errors = []
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`) })
const resp = await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 30000 })
console.log('GET / ->', resp.status())
console.log('title:', await page.title())
console.log('url after load:', page.url())
console.log('visible text (first 400 chars):\n', (await page.locator('body').innerText()).slice(0, 400).replace(/\n+/g, ' | '))
await page.screenshot({ path: 'test/landing.png', fullPage: false })
// look for a login/get-started entry
for (const sel of ['text=Login', 'text=Get started', 'text=Create', 'text=Sign in', 'a[href*="login"]', 'a[href*="new"]', 'a[href*="create"]']) {
  const c = await page.locator(sel).count().catch(() => 0)
  if (c) console.log('found control:', sel, 'x', c)
}
console.log('5xx responses:', errors.length ? errors : 'none')
await browser.close()
