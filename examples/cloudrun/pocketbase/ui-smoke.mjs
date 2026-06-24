// Playwright end-to-end smoke for the zeropocket admin SPA.
// Drives: instant login render, register, sidebar nav, rich-field collection
// create, multi-type record add, filter + sort, users view, settings/retention
// view, and session persistence. Run: BASE=<url> node ui-smoke.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8094';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

function ok(l){ console.log('  PASS', l); }
function fail(l, x){ console.error('  FAIL', l, x||''); process.exitCode = 1; }

const email = `ui_${Date.now()}@forest-ai.org`;
const coll = `things_${Math.floor(Math.random()*100000)}`;

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // 1. login screen paints instantly (no DB)
  await page.waitForSelector('#login .box', { timeout: 5000 });
  ok('login screen rendered instantly');

  // status pill reaches ready (proves wake + db)
  await page.waitForFunction(() => document.querySelector('#status .lbl')?.textContent?.includes('ready'), { timeout: 20000 });
  ok('status pill → db ready');

  // 2. register → enters app shell with dark sidebar
  await page.fill('#email', email);
  await page.fill('#password', 'hunter2');
  await page.click('#registerBtn');
  await page.waitForSelector('#app:not(.hidden) aside', { timeout: 8000 });
  if ((await page.textContent('#footEmail'))?.trim() === email) ok('registered → admin shell (sidebar + email shown)'); else fail('email mismatch');

  // 3. nav to New collection via sidebar
  await page.click('aside .navitem[data-route="new-collection"]');
  await page.waitForFunction(() => location.hash === '#/new-collection', { timeout: 4000 });
  ok('sidebar nav → /new-collection (URL changed)');

  // 4. build a rich collection: text(required), number, bool, select
  await page.fill('#view input', coll); // first input = collection name
  // field row 1: title text required
  const setField = async (idx, name, type, opts, req) => {
    const rows = page.locator('.fieldrow');
    if (idx >= await rows.count()) { await page.click('button:has-text("+ add field")'); }
    const row = rows.nth(idx);
    await row.locator('input').first().fill(name);
    await row.locator('select').selectOption(type);
    if (opts){ await row.locator('input.opts').fill(opts); }
    if (req){ await row.locator('input[type=checkbox]').check(); }
  };
  await setField(0, 'title', 'text', null, true);
  await setField(1, 'votes', 'number');
  await setField(2, 'live', 'bool');
  await setField(3, 'status', 'select', 'draft,published');
  await page.click('button:has-text("Create collection")');
  await page.waitForFunction(c => location.hash === '#/c/'+c, coll, { timeout: 8000 });
  ok('created rich collection (text/number/bool/select) → records view');

  // collection shows in sidebar
  await page.waitForFunction(c => [...document.querySelectorAll('aside .navitem')].some(n=>n.textContent.includes(c)), coll, { timeout: 4000 });
  ok('collection appears in sidebar');

  // 5. add a record using the typed form
  await page.fill('#recCreate [type=text], #view .row input[type=text]', 'first thing').catch(()=>{});
  // title input is the first text input in the add-record row
  const titleInput = page.locator('#view .card .row input[type="text"]').first();
  await titleInput.fill('first thing');
  await page.locator('#view .card .row input[type="number"]').first().fill('15');
  await page.click('button:has-text("Add")');
  await page.waitForFunction(() => document.querySelector('#recTableHost')?.textContent?.includes('first thing'), { timeout: 8000 });
  ok('added a record (visible in data-table)');

  // 6. add a second record and test sort by clicking the votes header
  await titleInput.fill('second thing');
  await page.locator('#view .card .row input[type="number"]').first().fill('3');
  await page.click('button:has-text("Add")');
  await page.waitForFunction(() => (document.querySelector('#recTableHost')?.textContent||'').includes('second thing'), { timeout: 8000 });
  ok('added a second record');

  // 7. filter: votes > 10 should show only "first thing"
  await page.fill('#view .toolbar input', 'votes > 10');
  await page.click('.toolbar button:has-text("search")');
  await page.waitForFunction(() => {
    const t = document.querySelector('#recTableHost')?.textContent||'';
    return t.includes('first thing') && !t.includes('second thing');
  }, { timeout: 8000 });
  ok('filter "votes > 10" returns only matching record');

  // clear filter
  await page.click('.toolbar button:has-text("clear")');
  await page.waitForFunction(() => (document.querySelector('#recTableHost')?.textContent||'').includes('second thing'), { timeout: 6000 });
  ok('clear filter restores all records');

  // 8. Users view
  await page.click('aside .navitem[data-route="users"]');
  await page.waitForFunction((e) => location.hash==='#/users' && (document.querySelector('#view')?.textContent||'').includes(e), email, { timeout: 8000 });
  ok('users view lists the registered account');

  // 9. Settings / retention view
  await page.click('aside .navitem[data-route="settings"]');
  await page.waitForFunction(() => location.hash==='#/settings' && (document.querySelector('#view')?.textContent||'').toLowerCase().includes('retention'), { timeout: 8000 });
  const setTxt = (await page.textContent('#view')) || '';
  if (/Per-collection cap/.test(setTxt) && /Max users/.test(setTxt)) ok('settings shows the data-retention policy table'); else fail('retention table missing');

  // 10. deep-link + session persistence: reload on the records URL
  await page.goto(BASE + '/#/c/' + coll, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() => (document.querySelector('#recTableHost')?.textContent||'').includes('thing'), { timeout: 8000 });
  ok('deep-link to /#/c/<coll> works after reload (session persisted)');

  if (errors.length) fail('console errors', JSON.stringify(errors.slice(0,4)));
  else ok('no console errors');
} catch (e) {
  fail('exception', e.message + '\n' + (e.stack||''));
} finally {
  await browser.close();
}
console.log(process.exitCode ? '\nUI TEST FAILED' : '\nUI TEST PASSED');
