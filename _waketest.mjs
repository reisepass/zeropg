import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage()
let wakeFired = false
page.on('request', r => { if (r.url().includes('/healthz') && r.url().includes('8080')) wakeFired = true })
await page.goto('http://127.0.0.1:8090/')
await page.waitForTimeout(800)
console.log('WAKE fired to backend /healthz on page load:', wakeFired)
await browser.close()
