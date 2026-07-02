// Playwright browser test: drives the real frontend UI end to end.
// Requires the stack running (test/up-local.mjs) at BASE_URL (default :8080).
//
//   node examples/cloudrun/supabase/test/browser.spec.mjs
//
// Asserts the split-frontend + supabase-js flow in a real browser:
//   shell renders instantly -> status becomes ready -> signup -> todos card
//   appears -> add a todo -> it shows in the list (RLS-scoped, via PostgREST).

import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080'
const email = `pw-${Date.now()}@example.com`
const password = 'Sup3rSecret!pw'

const fail = (m) => { console.error(`  FAIL ${m}`); process.exitCode = 1 }
const ok = (m) => console.log(`  ok   ${m}`)

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('  [browser console.error]', m.text()) })

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // shell renders instantly (auth card present before backend ready)
  await page.waitForSelector('[data-testid="signup"]', { timeout: 5000 })
  ok('shell rendered instantly (signup button present)')

  // status pill becomes ready once db+auth are up
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.trim() === 'ready', { timeout: 90_000 })
  ok('status pill -> ready (backend woke)')

  // signup
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.click('[data-testid="signup"]')

  // todos card appears after signup
  await page.waitForSelector('[data-testid="todos-card"], #todos-card', { state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="who"]')?.textContent?.includes('signed in as'), { timeout: 30_000 })
  ok('signed up + signed in (who shows session)')

  // add a todo
  const task = `browser todo ${Date.now()}`
  await page.fill('[data-testid="newtask"]', task)
  await page.click('[data-testid="add"]')

  // it appears in the RLS-scoped list
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('[data-testid="todos"] li .body')).some((e) => e.textContent === t), task, { timeout: 30_000 })
  ok('added todo appears in list (supabase-js insert -> PostgREST -> RLS read)')

  // reload: session persists, todo still there (durable over the wire)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.trim() === 'ready', { timeout: 90_000 })
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('[data-testid="todos"] li .body')).some((e) => e.textContent === t), task, { timeout: 30_000 })
  ok('after reload: session persisted + todo still present (durable)')
} catch (e) {
  fail(String(e))
  try { await page.screenshot({ path: '/tmp/supabase-pw-fail.png' }); console.log('  screenshot: /tmp/supabase-pw-fail.png') } catch {}
} finally {
  await browser.close()
}

console.log(process.exitCode ? '\n[browser] RESULT: FAIL' : '\n[browser] RESULT: PASS')
process.exit(process.exitCode || 0)
