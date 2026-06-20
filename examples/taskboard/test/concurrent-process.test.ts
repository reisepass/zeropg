// Run: tsx examples/taskboard/test/concurrent-process.test.ts
//
// The real-world reason the file:// lock exists: two server processes on one
// datadir (a hot-reload overlap — old `tsx watch` instance + new one) must never
// both write it. We boot the ACTUAL app as separate OS processes against one
// datadir and prove:
//
//   1. Live contention: while process A owns the datadir, a second process B
//      fails to boot (lock held) instead of corrupting it. A keeps serving; its
//      writes are intact; a later clean reopen sees exactly the same data.
//   2. Crash handover: if A is SIGKILLed (lock left behind), B reclaims the dead
//      lock, boots, and serves every durable write A made — no loss, no corruption.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts')

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

interface Server {
  proc: ChildProcess
  /** Resolves to the bound base URL when READY, or rejects if it exits first. */
  ready: Promise<string>
  /** Resolves with the exit code once the process ends. */
  exit: Promise<number>
  stderr: () => string
}

function boot(dataDir: string, extraEnv: Record<string, string> = {}): Server {
  const proc = spawn(process.execPath, ['--import', 'tsx', INDEX], {
    env: { ...process.env, DATABASE_URL: `file://${dataDir}`, PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  let resolveReady: (base: string) => void
  let rejectReady: (e: Error) => void
  const ready = new Promise<string>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  const exit = new Promise<number>((res) => proc.on('close', (code) => res(code ?? 0)))
  proc.stdout!.on('data', (d) => {
    out += d.toString()
    const m = /READY on (http:\/\/localhost:\d+)/.exec(out)
    if (m) resolveReady(m[1])
  })
  proc.stderr!.on('data', (d) => (err += d.toString()))
  // If it exits before READY, surface that as a boot failure.
  exit.then((code) => rejectReady(new Error(`exited ${code} before READY: ${err.trim()}`)))
  return { proc, ready, exit, stderr: () => err }
}

async function api(method: string, base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function seedTasks(base: string, titles: string[]): Promise<void> {
  for (const title of titles) await api('POST', base, '/api/tasks', { title })
}

async function testLiveContention(): Promise<void> {
  console.log('live contention: a 2nd process is locked out, the 1st is unharmed')
  const dir = await mkdtemp(join(tmpdir(), 'tb-contend-'))
  const dataDir = join(dir, 'tb.db')

  const a = boot(dataDir)
  const baseA = await a.ready
  await seedTasks(baseA, ['alpha', 'beta', 'gamma'])

  // B races A for the same datadir, with a short acquire timeout so it fails fast.
  const b = boot(dataDir, { ZEROPG_ACQUIRE_TIMEOUT_MS: '400' })
  let bReady = false
  try {
    await b.ready
    bReady = true
  } catch {
    /* expected: B never becomes READY */
  }
  const bCode = await b.exit
  ok(!bReady, 'second process never reached READY (locked out)')
  ok(bCode === 1, `second process exited non-zero (got ${bCode})`)
  ok(/lock|boot failed/i.test(b.stderr()), 'second process reported a lock/boot failure')

  // A is unscathed.
  const aTasks = (await api('GET', baseA, '/api/tasks')) as unknown[]
  ok(aTasks.length === 3, `first process still serves all 3 writes (got ${aTasks.length})`)

  // Clean shutdown of A releases the lock; a fresh process sees identical data.
  a.proc.kill('SIGTERM')
  await a.exit
  const c = boot(dataDir)
  const baseC = await c.ready
  const cTasks = (await api('GET', baseC, '/api/tasks')) as { title: string }[]
  ok(
    JSON.stringify(cTasks.map((t) => t.title).sort()) === JSON.stringify(['alpha', 'beta', 'gamma']),
    'clean reopen sees exactly the writes A committed (no corruption)',
  )
  c.proc.kill('SIGTERM')
  await c.exit
  await rm(dir, { recursive: true, force: true })
}

async function testCrashHandover(): Promise<void> {
  console.log('crash handover: SIGKILL the owner, a new process reclaims + serves all writes')
  const dir = await mkdtemp(join(tmpdir(), 'tb-crash-'))
  const dataDir = join(dir, 'tb.db')

  const a = boot(dataDir)
  const baseA = await a.ready
  const titles = Array.from({ length: 8 }, (_, i) => `task-${i + 1}`)
  await seedTasks(baseA, titles)
  // Confirm durability of the writes before the kill (strict default commits each).
  const before = (await api('GET', baseA, '/api/tasks')) as unknown[]
  ok(before.length === 8, 'owner committed all 8 writes')

  a.proc.kill('SIGKILL') // hard crash: lock + datadir left behind, no clean release
  await a.exit

  const b = boot(dataDir) // default acquire timeout: must reclaim the dead lock
  const baseB = await b.ready // if this rejects, the test fails (no handover)
  const recovered = (await api('GET', baseB, '/api/tasks')) as { title: string }[]
  ok(recovered.length === 8, `successor recovered all 8 writes (got ${recovered.length})`)
  ok(
    JSON.stringify(recovered.map((t) => t.title).sort((x, y) => x.localeCompare(y))) ===
      JSON.stringify([...titles].sort((x, y) => x.localeCompare(y))),
    'successor data byte-matches what the crashed owner wrote (no corruption)',
  )
  b.proc.kill('SIGTERM')
  await b.exit
  await rm(dir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await testLiveContention()
  await testCrashHandover()
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
