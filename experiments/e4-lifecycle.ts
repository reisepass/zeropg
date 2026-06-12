// E4: Cloud Run lifecycle hazards, live against the deployed demo services.
//
//   P1  idle past lease TTL under CPU throttling -> request-path self-heal
//   P2  SIGTERM flush: sleep-mode pending write survives a revision replacement
//   P2b crash (SIGKILL): loss is bounded to unflushed writes, DB restores clean
//   P3  revision-switch loop: writes work across every switch, none lost
//   P4  zombie fencing: rival service takes over the same prefix; old writer
//       gets 423 (FencedError), never advances the manifest
//
//   tsx experiments/e4-lifecycle.ts [probe...]   (default: all)
//
// Uses the 50MB service as the victim (big enough to be a real DB, small
// enough that flushes are quick) and `gcloud` for revision replacement.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logResult, section, assert, failureCount, resetFailures } from './_util.js'

const exec = promisify(execFile)

const PROJECT = 'blob-pglite'
const REGION = 'europe-west1'
const SERVICE = 'zeropg-demo-50mb'
const URL = 'https://zeropg-demo-50mb-71428757273.europe-west1.run.app'
const RIVAL_SERVICE = 'zeropg-demo-rival'
const LEASE_TTL_MS = 60_000

const probes = process.argv.slice(2)
const want = (p: string) => probes.length === 0 || probes.includes(p)

async function getJson(path: string, timeoutMs = 60_000): Promise<any> {
  const res = await fetch(`${URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`)
  return res.json()
}

/** POST a note; returns HTTP status (302 success, 423 fenced/locked). */
async function postNote(url: string, body: string, durable: boolean): Promise<number> {
  const res = await fetch(`${url}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `body=${encodeURIComponent(body)}${durable ? '&durable=on' : ''}`,
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  })
  return res.status
}

async function noteCount(url = URL): Promise<number> {
  const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(60_000) })
  const m = (await res.json()) as { notes: string }
  return Number(m.notes)
}

/** Wait until /up returns 200 (cold boots ride through 503/conn-reset). */
async function waitReady(url = URL, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${url}/up`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) return
    } catch {
      /* booting */
    }
    if (Date.now() > deadline) throw new Error(`service at ${url} not ready in ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 1500))
  }
}

async function gcloud(args: string[]): Promise<string> {
  const { stdout } = await exec('gcloud', [...args, '--project', PROJECT], {
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Force a revision replacement (old instance gets SIGTERM + grace). */
async function rollRevision(tag: string): Promise<void> {
  await gcloud([
    'run', 'services', 'update', SERVICE,
    '--region', REGION,
    '--update-env-vars', `E4_BUMP=${tag}`,
  ])
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- P1
async function p1_idleLeaseSelfHeal() {
  section('P1: idle past lease TTL -> request-path lease self-heal')
  await waitReady()
  const before = await noteCount()
  assert(
    (await postNote(URL, 'e4-p1 first', true)) === 302,
    'P1: durable write before idle succeeds',
  )
  console.log(`  idling ${(LEASE_TTL_MS + 15_000) / 1000}s (lease must expire; CPU throttled)…`)
  await sleep(LEASE_TTL_MS + 15_000)
  const status = await postNote(URL, 'e4-p1 after idle', true)
  assert(status === 302, `P1: durable write after idle succeeds (got ${status})`)
  const after = await noteCount()
  assert(after === before + 2, `P1: both writes landed (${before} -> ${after})`)
  logResult('e4.jsonl', { probe: 'P1-idle-lease-self-heal', before, after, status })
}

// ---------------------------------------------------------------- P2
async function p2_sigtermFlush() {
  section('P2: sleep-mode pending write survives SIGTERM (revision replacement)')
  await waitReady()
  const before = await noteCount()
  assert((await postNote(URL, 'e4-p2 pending', false)) === 302, 'P2: memory write accepted')
  const m = await getJson('/metrics')
  assert(m.pendingFlush === true, 'P2: write is pending (not yet in bucket)')
  console.log('  rolling a new revision (old instance gets SIGTERM and must flush)…')
  const t0 = Date.now()
  await rollRevision(`p2-${Date.now()}`)
  await waitReady()
  // Make sure we are talking to the NEW instance (cold) and read the count.
  const after = await noteCount()
  assert(after === before + 1, `P2: pending write survived the SIGTERM flush (${before} -> ${after})`)
  logResult('e4.jsonl', { probe: 'P2-sigterm-flush', before, after, rollMs: Date.now() - t0 })
}

// ---------------------------------------------------------------- P2b
async function p2b_crashLossBounded() {
  section('P2b: crash (no grace) loses only unflushed writes; DB restores clean')
  await waitReady()
  // Establish a durable baseline, then one memory-only write, then crash.
  assert((await postNote(URL, 'e4-p2b durable baseline', true)) === 302, 'P2b: baseline durable write')
  const baseline = await noteCount()
  assert((await postNote(URL, 'e4-p2b doomed', false)) === 302, 'P2b: memory write accepted')
  assert((await noteCount()) === baseline + 1, 'P2b: memory write visible pre-crash')
  try {
    await fetch(`${URL}/_fault/abort`, { signal: AbortSignal.timeout(5000) })
  } catch {
    /* connection reset expected */
  }
  await sleep(3000)
  await waitReady()
  const after = await noteCount()
  assert(after === baseline, `P2b: state == last durable commit (${baseline}), got ${after}`)
  logResult('e4.jsonl', { probe: 'P2b-crash-loss-bounded', baseline, after })
}

// ---------------------------------------------------------------- P3
async function p3_revisionSwitchLoop(cycles = 5) {
  section(`P3: ${cycles}x revision-switch loop, a durable write after each`)
  await waitReady()
  const start = await noteCount()
  let switches = 0
  for (let i = 0; i < cycles; i++) {
    const t0 = Date.now()
    await rollRevision(`p3-${i}-${Date.now()}`)
    await waitReady()
    const status = await postNote(URL, `e4-p3 cycle ${i}`, true)
    assert(status === 302, `P3 cycle ${i}: write after switch (got ${status})`)
    const n = await noteCount()
    assert(n === start + i + 1, `P3 cycle ${i}: count ${start + i + 1}, got ${n}`)
    switches++
    console.log(`  cycle ${i}: switch+write ok in ${Date.now() - t0}ms`)
  }
  logResult('e4.jsonl', { probe: 'P3-revision-switch-loop', cycles: switches, finalCount: start + cycles })
}

// ---------------------------------------------------------------- P4
async function p4_zombieFencing() {
  section('P4: rival service on the same prefix; old writer must be fenced')
  await waitReady()
  console.log('  deploying rival service (same bucket prefix)…')
  await exec('bash', ['scripts/deploy.sh', RIVAL_SERVICE, 'demo/app-50mb', 'zeropg RIVAL'], {
    env: { ...process.env, SKIP_BUILD: '1' },
    timeout: 600_000,
  })
  const rivalUrl = await gcloud([
    'run', 'services', 'describe', RIVAL_SERVICE,
    '--region', REGION, '--format', 'value(status.url)',
  ])
  try {
    // Freeze A's request-path lease checks so it stays a confident zombie.
    await getJson('/_fault/pause-lease')
    // Wake the rival: it waits out A's lease (acquireTimeoutMs), takes over,
    // fence-stamps the manifest.
    console.log(`  waking rival at ${rivalUrl} (waits out A's lease ≤90s)…`)
    await waitReady(rivalUrl, 240_000)
    const rivalMetrics = await (await fetch(`${rivalUrl}/metrics`)).json() as any
    assert(rivalMetrics.fencingToken !== null, 'P4: rival holds the lease')
    // A (zombie, checks paused) tries a durable write -> the commit CAS must fail.
    const status = await postNote(URL, 'e4-p4 zombie write — must never land', true)
    assert(status === 423, `P4: zombie write rejected with 423 (got ${status})`)
    // Rival can write.
    const rivalWrite = await postNote(rivalUrl, 'e4-p4 rival write', true)
    assert(rivalWrite === 302, `P4: rival write succeeds (got ${rivalWrite})`)
    logResult('e4.jsonl', {
      probe: 'P4-zombie-fencing',
      rivalToken: rivalMetrics.fencingToken,
      zombieStatus: status,
    })
  } finally {
    console.log('  cleaning up rival…')
    await gcloud(['run', 'services', 'delete', RIVAL_SERVICE, '--region', REGION, '--quiet']).catch(
      (e) => console.log(`  (rival cleanup failed: ${e})`),
    )
    // Restart A so it re-acquires cleanly for later experiments.
    await fetch(`${URL}/_restart`).catch(() => {})
    await sleep(3000)
    await waitReady()
  }
}

async function main() {
  resetFailures()
  if (want('p1')) await p1_idleLeaseSelfHeal()
  if (want('p2')) await p2_sigtermFlush()
  if (want('p2b')) await p2b_crashLossBounded()
  if (want('p3')) await p3_revisionSwitchLoop()
  if (want('p4')) await p4_zombieFencing()
  section(failureCount() === 0 ? 'E4: ALL PROBES PASSED' : `E4: ${failureCount()} FAILURES`)
  process.exitCode = failureCount() === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
