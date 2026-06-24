import { chromium } from 'playwright'
const pasteUrl = 'https://privatebin-zeropg-4sowr32yyq-ew.a.run.app/?79129596bd632c2f#HGVDp1DkPKhSDUX5i6x9RX9ChdqemuhTkVSY2tqQQVh4'
const expect = 'zeropg-cloudrun-gcs-'
const b = await chromium.launch(); const p = await b.newPage()
const t0 = Date.now()
await p.goto(pasteUrl, { waitUntil:'networkidle', timeout:60000 })
await p.waitForTimeout(2500)
const shown = await p.locator('#prettyprint, #cleartext, pre').first().innerText().catch(()=> '')
console.log(`reopened in ${((Date.now()-t0)/1000).toFixed(1)}s; paste survived fresh instance:`, shown.includes(expect), '| text:', shown.slice(0,40))
await b.close()
