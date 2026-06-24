import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8087';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

function ok(label) { console.log('  PASS', label); }
function fail(label, extra) { console.error('  FAIL', label, extra || ''); process.exitCode = 1; }

// unique email per run so re-runs don't 409
const email = `ui_${Date.now()}@forest-ai.org`;
const coll = `ui_posts_${Math.floor(Math.random()*100000)}`;

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // 1. page renders the login panel instantly (no DB needed)
  await page.waitForSelector('#authPanel', { timeout: 5000 });
  ok('admin UI rendered (login panel present)');

  // status pill should eventually say db ready (proves wake + warm path)
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('ready'), { timeout: 15000 });
  ok('status pill reached "db ready"');

  // 2. register
  await page.fill('#email', email);
  await page.fill('#password', 'hunter2');
  await page.click('#registerBtn');
  await page.waitForSelector('#appPanel:not(.hidden)', { timeout: 8000 });
  const meTxt = await page.textContent('#meEmail');
  if (meTxt?.trim() === email) ok('registered + signed in (' + email + ')'); else fail('signed-in email mismatch', meTxt);

  // 3. create a collection with one text field
  await page.fill('#newCollName', coll);
  // the first field row exists; fill it
  await page.fill('#fieldRows .fieldrow input', 'title');
  await page.selectOption('#fieldRows .fieldrow select', 'text');
  await page.click('#createCollBtn');
  await page.waitForFunction((c) => document.querySelector('#collList')?.textContent?.includes(c), coll, { timeout: 8000 });
  ok('collection created and listed: ' + coll);

  // selecting it happens automatically on create; the record form should show a title input
  await page.waitForSelector('#recCreate [data-f="title"]', { timeout: 8000 });
  ok('record-create form rendered for collection');

  // 4. add a record
  await page.fill('#recCreate [data-f="title"]', 'hello from playwright');
  await page.click('#addRecBtn');
  await page.waitForFunction(() => document.querySelector('#recTable')?.textContent?.includes('hello from playwright'), { timeout: 8000 });
  ok('record created and visible in table');

  // 5. record count text shows 1 record
  const tableTxt = await page.textContent('#recTable');
  if (/1 record/.test(tableTxt)) ok('table shows "1 record(s)"'); else fail('record count text', tableTxt.slice(0,120));

  // 6. delete the record
  await page.click('#recTable .delRec');
  await page.waitForFunction(() => document.querySelector('#recTable')?.textContent?.includes('No records yet'), { timeout: 8000 });
  ok('record deleted (table empty)');

  // 7. reload -> persists session (token in localStorage) and shows app, not login
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#appPanel:not(.hidden)', { timeout: 8000 });
  ok('session persisted across reload (JWT in localStorage)');

  if (errors.length) fail('console errors present', JSON.stringify(errors));
  else ok('no console errors');
} catch (e) {
  fail('exception', e.message);
} finally {
  await browser.close();
}
if (process.exitCode) console.error('\nUI TEST FAILED'); else console.log('\nUI TEST PASSED');
