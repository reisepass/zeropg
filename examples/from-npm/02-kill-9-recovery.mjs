// 02 - kill -9 recovery: prove a SIGKILL does not corrupt the datadir and does
// not poison the lock, across repeated crashes.
//
//   pnpm kill-test
//
// Design (so the claims are precise, not hand-wavy):
//   - BASELINE: insert 100 rows in a transaction, then end() CLEANLY. These are
//     durable beyond any doubt. After every later crash they MUST all still be
//     there - that is the hard "no corruption of committed data" assertion.
//   - CRASH ROUNDS: spawn a worker (the npm package) that opens the SAME datadir
//     and commits rows in a loop. After it reports ~25 commits we `kill -9` it
//     mid-flight (it still holds the cross-process lock; its lock file is left
//     behind with a now-dead PID).
//   - RECOVERY: reopen the datadir. We assert it (a) opens without throwing
//     (no corruption / no PGlite Abort), (b) reclaims the dead lock FAST (not a
//     ~10s wait-out), (c) still has all 100 baseline rows, (d) is writable
//     again. We also OBSERVE how many of the in-flight committed rows survived
//     (a softer, PGlite-durability property) and report it honestly.

import { connect } from '@zeropg/client'
import { spawn } from 'node:child_process'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = fileURLToPath(new URL('./kill-worker.mjs', import.meta.url))
const lockPath = (dataDir) => `${dataDir}.zeropg.lock`

let failed = 0
function ok(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`)
  else { console.error(`  FAIL ${msg}`); failed++ }
}
async function exists(p) { try { await stat(p); return true } catch { return false } }

/** Spawn the worker; SIGKILL it once it has reported `killAfter` commits.
 *  Resolves with the highest n it reported as committed before dying. */
function crashWorker(dataDir, startN, killAfter) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER, dataDir, String(startN)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let lastCommitted = startN - 1
    let committedCount = 0
    let killed = false
    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        const m = /^committed (\d+)$/.exec(line)
        if (m) {
          lastCommitted = Number(m[1])
          committedCount++
          if (committedCount >= killAfter && !killed) {
            killed = true
            proc.kill('SIGKILL') // the actual kill -9
          }
        }
      }
    })
    proc.on('error', reject)
    proc.on('close', () => resolve({ lastCommitted, committedCount }))
  })
}

const dir = await mkdtemp(join(tmpdir(), 'zeropg-kill-'))
const dataDir = join(dir, 'pgdata')
console.log(`datadir: ${dataDir}\n`)

// --- BASELINE: 100 rows, committed then cleanly closed -----------------------
{
  const db = await connect(`file://${dataDir}`, { noHmrPin: true })
  await db.exec('create table if not exists rows_log (n int primary key, ts text)')
  await db.transaction(async (tx) => {
    for (let i = 1; i <= 100; i++) {
      await tx.query('insert into rows_log (n, ts) values ($1, $2)', [-i, 'baseline'])
    }
  })
  await db.end()
  console.log('baseline: 100 rows committed and cleanly closed\n')
}

const ROUNDS = 4
for (let r = 1; r <= ROUNDS; r++) {
  const startN = r * 1000 // each round uses a distinct n-range: 1000.., 2000..
  console.log(`round ${r}: worker writing from n=${startN}, will be SIGKILLed after ~25 commits`)
  const { lastCommitted, committedCount } = await crashWorker(dataDir, startN, 25)

  // A dead holder's lock should be sitting there with a now-defunct PID.
  ok(await exists(lockPath(dataDir)), `round ${r}: killed worker left its lock file behind (as expected)`)

  // RECOVERY: reopen. If the datadir were corrupted, or the lock poisoned, this
  // throws. Time it to prove the dead lock is RECLAIMED, not waited out ~10s.
  const t0 = Date.now()
  let db
  try {
    db = await connect(`file://${dataDir}`, { noHmrPin: true, acquireTimeoutMs: 12_000 })
  } catch (e) {
    ok(false, `round ${r}: reopen after kill -9 threw (${e?.name}: ${e?.message})`)
    break
  }
  const reopenMs = Date.now() - t0
  ok(reopenMs < 3_000, `round ${r}: dead lock reclaimed fast (${reopenMs}ms, not a ~10s wait-out)`)

  const base = await db.query("select count(*)::int as c from rows_log where ts = 'baseline'")
  ok(base.rows[0].c === 100, `round ${r}: all 100 cleanly-committed baseline rows survived kill -9 (got ${base.rows[0].c})`)

  const survived = await db.query(
    'select count(*)::int as c from rows_log where n >= $1 and n < $2',
    [startN, startN + 1000],
  )
  console.log(
    `       observed: worker reported ${committedCount} commits (up to n=${lastCommitted}); ${survived.rows[0].c} of them survived the reopen`,
  )

  // Prove the recovered DB is fully writable again.
  await db.query('insert into rows_log (n, ts) values ($1, $2)', [-(1000 + r), 'post-recovery'])
  const postRows = await db.query("select count(*)::int as c from rows_log where ts = 'post-recovery'")
  ok(postRows.rows[0].c === r, `round ${r}: datadir is writable after recovery`)

  await db.end()
  ok(!(await exists(lockPath(dataDir))), `round ${r}: lock released on clean end()`)
  console.log('')
}

if (failed === 0) {
  console.log(`PASS - ${ROUNDS} kill -9 rounds: no corruption, dead lock always reclaimed, committed data intact`)
} else {
  console.error(`FAIL - ${failed} assertion(s) failed`)
  process.exit(1)
}
