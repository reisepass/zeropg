// Run: tsx packages/client/test/lock-multiprocess.test.ts
//
// Real multi-process tests for the cross-process datadir lock (E1). Spawns
// genuinely separate OS processes that race to acquire the lock on ONE datadir;
// each, while holding, asserts via an O_EXCL sentinel that no other process is
// co-resident. A double-grant surfaces as a 'VIOLATION' event. This is the only
// way to test the property that matters ("two processes never both write the
// datadir") — the in-process test can at best simulate it.

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'lock-child.ts')

interface Event {
  pid: number
  t: number
  ev: 'acq' | 'rel' | 'reject' | 'VIOLATION' | 'error'
  msg?: string
  detail?: string
}

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

/** Spawn one child worker, resolving with the events it emitted. */
function runChild(
  dataDir: string,
  holdMs: number,
  acquireTimeoutMs: number,
  startGateMs = 0,
): { proc: ReturnType<typeof spawn>; done: Promise<Event[]> } {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, dataDir, String(holdMs), String(acquireTimeoutMs), String(startGateMs)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const done = new Promise<Event[]>((resolve) => {
    let buf = ''
    proc.stdout!.on('data', (d) => (buf += d.toString()))
    proc.on('close', () => {
      const events = buf
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Event)
      resolve(events)
    })
  })
  return { proc, done }
}

function flatten(results: Event[][]): Event[] {
  return results.flat().sort((a, b) => a.t - b.t)
}
function violations(events: Event[]): Event[] {
  return events.filter((e) => e.ev === 'VIOLATION' || e.ev === 'error')
}

async function testFreshRace(): Promise<void> {
  console.log('fresh N-way race: 12 processes, empty datadir')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-mp-'))
  const dataDir = join(dir, 'db')
  const N = 12
  const gate = 200 // all children wait this long, then race together
  const children = Array.from({ length: N }, () => runChild(dataDir, 40, 15_000, gate))
  const events = flatten(await Promise.all(children.map((c) => c.done)))
  ok(violations(events).length === 0, 'no two processes held the lock at once')
  const acqs = events.filter((e) => e.ev === 'acq').length
  ok(acqs === N, `all ${N} processes eventually acquired (got ${acqs})`)
}

async function testStaleStampede(): Promise<void> {
  console.log('stale-lock stampede: 12 processes reclaim one dead lock at once (TOCTOU)')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-mp-'))
  const dataDir = join(dir, 'db')
  // Pre-seed a stale lock owned by a (practically) dead PID on this host, so
  // every racer hits the dead-holder reclaim branch simultaneously.
  await writeFile(
    `${dataDir}.lock`,
    JSON.stringify({ pid: 2147480000, host: hostname(), acquiredAt: new Date(0).toISOString() }),
  )
  const N = 12
  const gate = 200
  const children = Array.from({ length: N }, () => runChild(dataDir, 40, 15_000, gate))
  const events = flatten(await Promise.all(children.map((c) => c.done)))
  ok(
    violations(events).length === 0,
    'reclaim stampede granted the lock to ONE process at a time (no TOCTOU double-grant)',
  )
  const acqs = events.filter((e) => e.ev === 'acq').length
  ok(acqs === N, `all ${N} processes acquired after reclaiming the stale lock (got ${acqs})`)
}

async function testReclaimAfterKill(): Promise<void> {
  console.log('cross-process reclaim: holder is SIGKILLed, next process reclaims')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-mp-'))
  const dataDir = join(dir, 'db')
  const holder = runChild(dataDir, 60_000, 5_000) // holds "forever"
  // Wait until it has actually acquired.
  await waitForEvent(holder.done, 'acq', holder.proc)
  holder.proc.kill('SIGKILL') // leaves the lock file behind, PID now dead
  // Await 'close' so Node reaps the zombie — otherwise kill(pid,0) on the
  // not-yet-reaped pid still reports it alive and the reclaim would (correctly)
  // refuse. We are testing reclaim of a genuinely-dead holder.
  await holder.done
  // A fresh process must reclaim the dead lock and acquire.
  const next = runChild(dataDir, 40, 8_000)
  const events = await next.done
  ok(
    events.some((e) => e.ev === 'acq'),
    'a new process reclaimed the lock left by the killed holder',
  )
  ok(violations(events).length === 0, 'reclaim after kill produced no violation')
}

async function testLiveRejection(): Promise<void> {
  console.log('cross-process rejection: a LIVE holder is not stolen from')
  const dir = await mkdtemp(join(tmpdir(), 'zeropg-mp-'))
  const dataDir = join(dir, 'db')
  const holder = runChild(dataDir, 1_500, 5_000)
  await waitForEvent(holder.done, 'acq', holder.proc)
  // Short timeout while the holder is alive -> must be rejected, never granted.
  const rival = runChild(dataDir, 40, 300)
  const events = await rival.done
  ok(
    events.some((e) => e.ev === 'reject') && !events.some((e) => e.ev === 'acq'),
    'rival was rejected (LockTimeoutError), never granted the live lock',
  )
  await holder.done
}

/** Resolve once the child has emitted `ev` (peeks without consuming the final
 * result, which the caller still awaits separately if needed). */
function waitForEvent(
  done: Promise<Event[]>,
  ev: Event['ev'],
  proc: ReturnType<typeof spawn>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (d: Buffer): void => {
      buf += d.toString()
      if (buf.split('\n').filter(Boolean).some((l) => (JSON.parse(l) as Event).ev === ev)) {
        proc.stdout!.off('data', onData)
        resolve()
      }
    }
    proc.stdout!.on('data', onData)
    done.then((events) => {
      if (events.some((e) => e.ev === ev)) resolve()
      else reject(new Error(`child exited without emitting '${ev}': ${JSON.stringify(events)}`))
    })
  })
}

async function main(): Promise<void> {
  await testFreshRace()
  await testStaleStampede()
  await testReclaimAfterKill()
  await testLiveRejection()
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
