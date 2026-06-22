// 04 - crash handoff (the real HMR / dev-server corruption scenario): one
// process holds the datadir while a SECOND is already blocked waiting for it,
// then the holder is `kill -9`'d and the waiter must take over cleanly.
//
//   pnpm handoff-test
//
// With raw PGlite this is the classic corruption: the old instance dies and the
// new one opens the same files. With @zeropg/client the waiter reclaims the dead
// lock and opens a single, consistent writer that sees the holder's committed
// data - no corruption, no second co-resident writer.

import { connect } from '@zeropg/client'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KILL_WORKER = fileURLToPath(new URL('./kill-worker.mjs', import.meta.url))
const HANDOFF_WORKER = fileURLToPath(new URL('./handoff-worker.mjs', import.meta.url))

let failed = 0
function ok(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`)
  else { console.error(`  FAIL ${msg}`); failed++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Spawn a child, invoking onLine(line) for each stdout line. */
function spawnChild(script, args, onLine) {
  const proc = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line) onLine(line, proc)
    }
  })
  return proc
}

const dir = await mkdtemp(join(tmpdir(), 'zeropg-handoff-'))
const dataDir = join(dir, 'pgdata')
console.log(`datadir: ${dataDir}\n`)

// --- A: holds the datadir and commits rows ----------------------------------
let aLastCommitted = 0
let aCommittedCount = 0
let aProc
const aDone = new Promise((resolve) => {
  aProc = spawnChild(KILL_WORKER, [dataDir, '1'], (line) => {
    const m = /^committed (\d+)$/.exec(line)
    if (m) { aLastCommitted = Number(m[1]); aCommittedCount++ }
  })
  aProc.on('close', resolve)
})

// Wait until A has committed a handful of rows (so there is real data to recover).
while (aCommittedCount < 15) await sleep(20)
console.log(`A: holding the lock, committed ${aCommittedCount} rows (up to n=${aLastCommitted})`)

// --- B: tries to open the SAME datadir; it will block on A's live lock -------
let bWaiting = false
let bAcquiredSaw = null
const bDone = new Promise((resolve) => {
  const b = spawnChild(HANDOFF_WORKER, [dataDir], (line) => {
    if (line === 'waiting') bWaiting = true
    const m = /^acquired (\d+)$/.exec(line)
    if (m) bAcquiredSaw = Number(m[1])
  })
  b.on('close', (code) => resolve(code))
})

// Make sure B is genuinely blocked in the acquire loop before we kill A.
while (!bWaiting) await sleep(10)
await sleep(400)
ok(bWaiting && bAcquiredSaw === null, 'B is blocked waiting on A\'s live lock (not yet acquired)')

// --- kill -9 A while B is waiting --------------------------------------------
console.log('kill -9 A (while B waits)...')
aProc.kill('SIGKILL')
await aDone

// --- B must now take over ----------------------------------------------------
const bCode = await bDone
ok(bCode === 0, 'B took over and exited cleanly after A was killed')
ok(bAcquiredSaw !== null, `B reclaimed the dead lock and opened (saw ${bAcquiredSaw} of A's rows)`)
ok(bAcquiredSaw >= aCommittedCount, `B saw all of A's committed rows (${bAcquiredSaw} >= ${aCommittedCount})`)

// --- final independent verification -----------------------------------------
const db = await connect(`file://${dataDir}`, { noHmrPin: true })
const rows = await db.query('select count(*)::int as c from rows_log')
const handoff = await db.query('select who from handoff')
ok(rows.rows[0].c >= aCommittedCount, `datadir intact: A's ${rows.rows[0].c} rows present, no corruption`)
ok(handoff.rows.length === 1, `B's write landed: "${handoff.rows[0]?.who}"`)
await db.end()

console.log('')
if (failed === 0) console.log('PASS - holder killed mid-flight, waiting process took over cleanly, no corruption')
else { console.error(`FAIL - ${failed} assertion(s)`); process.exit(1) }
