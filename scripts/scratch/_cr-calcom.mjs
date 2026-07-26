import { chromium } from 'playwright'
const URL='https://calcom-zeropg-71428757273.europe-west1.run.app'
const ts=Date.now(); const email=`cr-${ts}@example.com`, user=`cr${ts}`
const b=await chromium.launch(); const p=await b.newPage()
const fivexx=[]; p.on('response',r=>{if(r.status()>=500)fivexx.push(r.status())})
await p.goto(URL+'/signup',{waitUntil:'networkidle',timeout:90000})
await p.getByTestId('continue-with-email-button').click().catch(()=>{})
await p.waitForTimeout(800)
await p.getByTestId('signup-usernamefield').fill(user)
await p.getByTestId('signup-emailfield').fill(email)
await p.getByTestId('signup-passwordfield').fill('Zeropg-Demo-1234!')
await p.getByTestId('signup-cookie-content-checkbox').check().catch(()=>{})
await p.getByTestId('signup-submit-button').click()
await p.waitForTimeout(5000)
console.log('after signup url:', p.url(), '| 5xx:', fivexx.length?fivexx:'none', '| email:', email)
await b.close()
