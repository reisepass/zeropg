// One-command test runner for zeropg Console.
//
//   node examples/cloudrun/supabase/studio/test/run.mjs
//
// Boots the stack ONCE (wire + postgres-meta + BFF via lib/harness.mjs), launches
// one headless chromium, and runs every *.spec.mjs against it. Each spec seeds its
// own uniquely named data over the wire, then asserts the UI shows EXACTLY that
// data. Specs are order-independent. Exits non-zero if any assertion fails.
//
// Requires: Docker running, Playwright chromium installed (repo root).

import { chromium } from 'playwright'
import { bringUp } from '../lib/harness.mjs'
import { makeReporter } from './helpers.mjs'

import * as authSpec from './auth.spec.mjs'
import * as connectionSpec from './connection.spec.mjs'
import * as sqlSpec from './sql.spec.mjs'
import * as tableBrowserSpec from './table-browser.spec.mjs'
import * as logsSpec from './logs.spec.mjs'
import * as routingSpec from './routing.spec.mjs'
import * as concurrencySpec from './concurrency.spec.mjs'

const SPECS = [
  ['auth', authSpec],
  ['connection', connectionSpec],
  ['sql-editor', sqlSpec],
  ['table-browser', tableBrowserSpec],
  ['logs', logsSpec],
  ['routing', routingSpec],
  ['concurrency', concurrencySpec],
]

const ONLY = process.env.SPEC || null

console.log('[run] bringing up wire + postgres-meta + BFF ...')
const stack = await bringUp({ quiet: true, log: (m) => console.log(m) })
const browser = await chromium.launch()

let totalPass = 0, totalFail = 0
try {
  for (const [name, spec] of SPECS) {
    if (ONLY && name !== ONLY) continue
    if (typeof spec.run !== 'function') { console.error(`  spec ${name} has no run()`); totalFail++; continue }
    const t = makeReporter(name)
    console.log(`\n=== ${name} ===`)
    try {
      await spec.run({
        base: stack.base,
        password: stack.cfg.adminPassword,
        cfg: stack.cfg,
        browser,
        sql: stack.sql,
        wire: stack.wire,
        t,
      })
    } catch (e) {
      t.fail(`spec threw: ${e && e.stack ? e.stack : String(e)}`)
    }
    const { pass, fail } = t.counts()
    totalPass += pass; totalFail += fail
  }
} finally {
  await browser.close().catch(() => {})
  await stack.stop().catch(() => {})
}

console.log(`\n[run] TOTAL: ${totalPass} passed, ${totalFail} failed`)
process.exit(totalFail ? 1 : 0)
