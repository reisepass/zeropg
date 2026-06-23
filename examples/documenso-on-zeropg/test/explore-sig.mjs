import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
await page.goto('http://localhost:3102/signup', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(1000)

// The "Sign Here" box trigger has onClick -> setShowSignatureModal(true).
// Find the clickable container near the "Sign Here" label.
const sigArea = await page.evaluateHandle(() => {
  const label = [...document.querySelectorAll('*')].find((e) => /^Sign Here$/i.test(e.textContent?.trim() || '') && e.children.length === 0)
  return label
})
console.log('found Sign Here label:', !!sigArea)

// Try clicking the SignatureRender area (the canvas/box under the label).
// Click center of the big box: locate the element with class containing the dashed border or the canvas placeholder.
await page.locator('text=Sign Here').first().scrollIntoViewIfNeeded().catch(() => {})

// Find any element that on click opens a dialog. Click the box visually below the label.
const labelBox = await page.locator('text=Sign Here').first().boundingBox()
console.log('label box:', JSON.stringify(labelBox))
if (labelBox) {
  // click ~80px below the label center (inside the signature box)
  await page.mouse.click(labelBox.x + 100, labelBox.y + 80)
  await page.waitForTimeout(1000)
}
console.log('dialog visible after click:', await page.locator('[role="dialog"]').isVisible().catch(() => false))

const tabs = await page.locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.textContent?.trim()))
console.log('tabs:', JSON.stringify(tabs))
const ph = await page.locator('input,textarea').evaluateAll((els) => els.map((e) => e.placeholder).filter(Boolean))
console.log('placeholders:', JSON.stringify(ph))
const btns = await page.locator('[role="dialog"] button').evaluateAll((els) => els.map((e) => e.textContent?.trim()).filter(Boolean))
console.log('dialog buttons:', JSON.stringify(btns))

await page.screenshot({ path: '/Users/user/workspace/zeropg/examples/documenso-on-zeropg/test/sig-dialog.png', fullPage: true })
await browser.close()
