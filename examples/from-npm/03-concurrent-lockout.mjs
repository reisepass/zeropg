// 03 - concurrent lockout: prove two openers of one datadir can't both run (the
// single biggest cause of PGlite corruption), via the cross-process lock.
//
//   pnpm concurrent-test
//
// While A holds file://<dir>, a second connect() to the SAME datadir must be
// LOCKED OUT (LockTimeoutError) rather than opening a second writer. After A
// releases, the next opener succeeds and sees A's data intact.

import { connect } from '@zeropg/client'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function ok(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`)
  else { console.error(`  FAIL ${msg}`); failed++ }
}

const dir = await mkdtemp(join(tmpdir(), 'zeropg-conc-'))
const dataDir = join(dir, 'pgdata')
console.log(`datadir: ${dataDir}\n`)

const a = await connect(`file://${dataDir}`, { noHmrPin: true })
await a.exec('create table t (v text)')
await a.query("insert into t values ('written by A')")
console.log('A: opened and holding the datadir lock')

// Second opener of the SAME datadir while A is live.
let lockedOut = false
const t0 = Date.now()
try {
  const b = await connect(`file://${dataDir}`, { noHmrPin: true, acquireTimeoutMs: 800 })
  await b.end()
} catch (e) {
  lockedOut = e?.name === 'LockTimeoutError'
  console.log(`B: rejected after ${Date.now() - t0}ms -> ${e?.name}: ${e?.message}`)
}
ok(lockedOut, 'second concurrent opener is locked out (LockTimeoutError), never a co-resident writer')

await a.end()
console.log('A: released')

const c = await connect(`file://${dataDir}`, { noHmrPin: true })
const r = await c.query('select v from t')
ok(r.rows.length === 1 && r.rows[0].v === 'written by A', "after A released, next opener succeeds and A's data is intact")
await c.end()

console.log('')
if (failed === 0) console.log('PASS - concurrent second writer is prevented, not corrupting')
else { console.error(`FAIL - ${failed} assertion(s)`); process.exit(1) }
