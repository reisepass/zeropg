// Run: tsx packages/client/test/lock-stress.test.ts
//   heavier: STRESS_SCALE=2 tsx packages/client/test/lock-stress.test.ts
//
// Stress lab for the cross-process datadir lock, mirroring the classes of race
// the PGlite fork's lab (PR #892) used to shake out protocol bugs. Every worker,
// while holding the lock, asserts via an O_EXCL sentinel that no OTHER LIVE
// process is co-resident (the lock granted twice). The two invariants under all
// of this: (1) ZERO co-resident violations ever, (2) the lock is always
// eventually acquirable (never poisoned into a permanent refusal).
//
// This spawns hundreds of real processes; it is the slow, thorough sibling of
// lock-multiprocess.test.ts, not part of the fast suite.

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockPathFor } from '../src/lockfile.js'

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'lock-child.ts')
const SCALE = Number(process.env.STRESS_SCALE ?? 1)

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

interface Handle {
  proc: ReturnType<typeof spawn>
  done: Promise<Event[]>
  events: Event[]
  sawAcq: Promise<void>
}

function runChild(dataDir: string, holdMs: number, timeoutMs: number, gateMs = 0): Handle {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', CHILD, dataDir, String(holdMs), String(timeoutMs), String(gateMs)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const events: Event[] = []
  let onAcq: () => void = () => {}
  const sawAcq = new Promise<void>((r) => (onAcq = r))
  const done = new Promise<Event[]>((resolve) => {
    let buf = ''
    proc.stdout!.on('data', (d) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) continue
        const ev = JSON.parse(line) as Event
        events.push(ev)
        if (ev.ev === 'acq') onAcq()
      }
    })
    proc.on('close', () => resolve(events))
  })
  return { proc, done, events, sawAcq }
}

function allEvents(handles: Handle[]): Event[] {
  return handles.flatMap((h) => h.events)
}
function countViolations(events: Event[]): number {
  return events.filter((e) => e.ev === 'VIOLATION' || e.ev === 'error').length
}

async function seedStaleLock(dataDir: string): Promise<void> {
  await writeFile(
    lockPathFor(dataDir),
    JSON.stringify({ pid: 2147480000, host: hostname(), acquiredAt: new Date(0).toISOString() }),
  )
}

/** A round of N processes racing one datadir; returns when all have finished. */
async function race(dataDir: string, n: number, holdMs: number, gateMs: number): Promise<Event[]> {
  const handles = Array.from({ length: n }, () => runChild(dataDir, holdMs, 30_000, gateMs))
  await Promise.all(handles.map((h) => h.done))
  return allEvents(handles)
}

async function testFreshWaves(): Promise<void> {
  const waves = 5 * SCALE
  const n = 10
  console.log(`fresh-race waves: ${waves} waves x ${n} processes`)
  let totalAcq = 0
  let totalViol = 0
  for (let w = 0; w < waves; w++) {
    const dir = await mkdtemp(join(tmpdir(), 'stress-fresh-'))
    const events = await race(join(dir, 'db'), n, 25, 120)
    totalAcq += events.filter((e) => e.ev === 'acq').length
    totalViol += countViolations(events)
    await rm(dir, { recursive: true, force: true })
  }
  ok(totalViol === 0, `no co-resident violations across ${waves * n} fresh racers`)
  ok(totalAcq === waves * n, `every process acquired (${totalAcq}/${waves * n})`)
}

async function testStaleWaves(): Promise<void> {
  const waves = 5 * SCALE
  const n = 10
  console.log(`stale-stampede waves: ${waves} waves x ${n} processes reclaiming a dead lock`)
  let totalAcq = 0
  let totalViol = 0
  for (let w = 0; w < waves; w++) {
    const dir = await mkdtemp(join(tmpdir(), 'stress-stale-'))
    const dataDir = join(dir, 'db')
    await seedStaleLock(dataDir)
    const events = await race(dataDir, n, 25, 120)
    totalAcq += events.filter((e) => e.ev === 'acq').length
    totalViol += countViolations(events)
    await rm(dir, { recursive: true, force: true })
  }
  ok(totalViol === 0, `no violations across ${waves * n} stale-reclaim racers`)
  ok(totalAcq === waves * n, `every process reclaimed + acquired (${totalAcq}/${waves * n})`)
}

async function testKillCycles(): Promise<void> {
  const cycles = 10 * SCALE
  console.log(`kill-recovery: ${cycles} cycles of acquire -> SIGKILL -> successor reclaims`)
  const dir = await mkdtemp(join(tmpdir(), 'stress-kill-'))
  const dataDir = join(dir, 'db')
  let reclaims = 0
  let viol = 0
  for (let c = 0; c < cycles; c++) {
    const holder = runChild(dataDir, 60_000, 10_000) // holds "forever"
    await holder.sawAcq
    holder.proc.kill('SIGKILL')
    await holder.done // reap the zombie so its pid reads as dead
    const next = runChild(dataDir, 15, 12_000)
    const events = await next.done
    if (events.some((e) => e.ev === 'acq')) reclaims++
    viol += countViolations([...holder.events, ...events])
  }
  await rm(dir, { recursive: true, force: true })
  ok(viol === 0, `no violations across ${cycles} kill/reclaim cycles`)
  ok(reclaims === cycles, `every successor reclaimed the dead lock (${reclaims}/${cycles})`)
}

async function testChaos(): Promise<void> {
  const rounds = 6 * SCALE
  const n = 8
  console.log(`chaos: ${rounds} rounds x ${n} processes, ~1/3 SIGKILLed mid-flight`)
  const dir = await mkdtemp(join(tmpdir(), 'stress-chaos-'))
  const dataDir = join(dir, 'db')
  let viol = 0
  for (let r = 0; r < rounds; r++) {
    const handles = Array.from({ length: n }, (_, i) =>
      // varied holds + a small stagger so some overlap acquisition and some queue.
      runChild(dataDir, 20 + (i % 4) * 20, 30_000, (i % 3) * 30),
    )
    // Randomly SIGKILL roughly a third of them once they have the lock (leaves
    // sentinel + lock debris a successor must safely reclaim).
    const victims = handles.filter((_, i) => i % 3 === 0)
    await Promise.all(
      victims.map(async (h) => {
        await h.sawAcq.catch(() => {})
        h.proc.kill('SIGKILL')
      }),
    )
    await Promise.all(handles.map((h) => h.done))
    viol += countViolations(allEvents(handles))
  }
  // After all the chaos, the lock must still be cleanly acquirable.
  const final = runChild(dataDir, 15, 15_000)
  const fe = await final.done
  await rm(dir, { recursive: true, force: true })
  ok(viol === 0, `no co-resident violations across ${rounds} chaos rounds`)
  ok(fe.some((e) => e.ev === 'acq'), 'lock is cleanly acquirable after all the chaos (not poisoned)')
}

async function main(): Promise<void> {
  const t0 = Date.now()
  await testFreshWaves()
  await testStaleWaves()
  await testKillCycles()
  await testChaos()
  console.log(`\nPASS — ${passed} assertions in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
