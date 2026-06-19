// Child worker for the multi-process lock race tests. Spawned as a real OS
// process so the lock is exercised across genuinely separate processes (the
// in-process test can only simulate liveness). Emits one JSON line per event on
// stdout; the parent collects and asserts on them.
//
// The corruption probe is a SECOND lock-step, independent of the datadir lock
// being tested: while holding the datadir lock, the child creates a sibling
// sentinel `<datadir>.held` with O_EXCL ('wx'). If that create fails with
// EEXIST, another process is inside its critical section AT THE SAME TIME —
// i.e. the datadir lock granted two owners. That is exactly the
// concurrent-initdb corruption the lock exists to prevent, detected directly
// without relying on wall-clock overlap.
//
// Usage: node --import tsx lock-child.ts <dataDir> <holdMs> <acquireTimeoutMs> [<startGateMs>]

import { openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { acquireDatadirLock, LockTimeoutError } from '../src/lockfile.js'

function emit(ev: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ pid: process.pid, t: Date.now(), ...ev }) + '\n')
}

/** Create the sentinel exclusively and stamp it with our pid. */
function createSentinel(path: string): number {
  const fd = openSync(path, 'wx')
  writeFileSync(fd, String(process.pid))
  return fd
}

function readSentinelPid(path: string): number | null {
  try {
    const s = readFileSync(path, 'utf8').trim()
    if (!s) return null // empty: a holder that died mid-creation (debris, not a live owner)
    const n = Number(s)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  if (pid <= 0) return false // never probe pid 0 / negatives: kill(0,0) hits the whole group
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function main(): Promise<void> {
  const [dataDir, holdMsRaw, timeoutRaw, gateRaw] = process.argv.slice(2)
  const holdMs = Number(holdMsRaw)
  const acquireTimeoutMs = Number(timeoutRaw)
  const startGate = gateRaw ? Number(gateRaw) : 0
  const sentinel = `${dataDir}.held`

  // Optional start gate so the parent can release all children to race at once.
  if (startGate > 0) await sleep(startGate)

  let lock
  try {
    lock = await acquireDatadirLock(dataDir, { acquireTimeoutMs, pollIntervalMs: 5 })
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      emit({ ev: 'reject' })
      return
    }
    emit({ ev: 'error', msg: e instanceof Error ? e.message : String(e) })
    process.exitCode = 1
    return
  }

  emit({ ev: 'acq' })

  // Critical section. The sentinel is liveness-aware so it distinguishes a true
  // co-resident holder (the lock granted twice -> the OTHER pid is ALIVE) from
  // crash debris (a SIGKILLed holder left its sentinel; that pid is DEAD). Only
  // the former is a lock violation; the latter is reclaimed like a stale lock.
  let fd: number | null = null
  try {
    fd = createSentinel(sentinel)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const other = readSentinelPid(sentinel)
      if (other !== null && isAlive(other)) {
        emit({ ev: 'VIOLATION', detail: `co-resident live holder pid ${other}` })
      } else {
        // Debris from a crashed holder — reclaim and proceed (no violation).
        try {
          unlinkSync(sentinel)
          fd = createSentinel(sentinel)
        } catch (e2) {
          emit({ ev: 'error', msg: e2 instanceof Error ? e2.message : String(e2) })
        }
      }
    } else {
      emit({ ev: 'error', msg: e instanceof Error ? e.message : String(e) })
    }
  }
  await sleep(holdMs)
  if (fd !== null) {
    closeSync(fd)
    try {
      unlinkSync(sentinel)
    } catch {
      /* another holder already cleaned it (also a violation, reported above) */
    }
  }

  await lock.release()
  emit({ ev: 'rel' })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((e) => {
  emit({ ev: 'error', msg: e instanceof Error ? e.message : String(e) })
  process.exitCode = 1
})
