// E3b: find the memory floor for the 500MB database on Cloud Run.
//
// Redeploys zeropg-demo-500mb at each memory tier, then forces N cold starts
// and records the boot breakdown + RSS, or the failure mode (OOM kill shows up
// as the instance never becoming ready / connection resets in a loop).
//
//   tsx experiments/e3b-memory-tiers.ts [tiers...]   default: 1Gi 2Gi 4Gi

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logResult, stats, round, section } from './_util.js'

const exec = promisify(execFile)
const PROJECT = 'blob-pglite'
const REGION = 'europe-west1'
const SERVICE = 'zeropg-demo-500mb'
const URL = 'https://zeropg-demo-500mb-71428757273.europe-west1.run.app'
const COLD_STARTS = 5

const TIERS = process.argv.length > 2 ? process.argv.slice(2) : ['1Gi', '2Gi', '4Gi']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setMemory(tier: string): Promise<void> {
  await exec(
    'gcloud',
    ['run', 'services', 'update', SERVICE, '--region', REGION, '--memory', tier, '--project', PROJECT],
    { timeout: 300_000 },
  )
}

async function coldStart(): Promise<{ ms: number; metrics: any } | { error: string }> {
  try {
    // Clean exit: /_fault/abort would trip Cloud Run's crash-restart backoff.
    await fetch(`${URL}/_restart`, { signal: AbortSignal.timeout(10000) })
  } catch {
    /* connection reset possible */
  }
  await sleep(4000)
  const t0 = performance.now()
  const deadline = t0 + 120_000
  let lastErr: unknown
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${URL}/metrics`, { signal: AbortSignal.timeout(110_000) })
      if (res.ok) return { ms: performance.now() - t0, metrics: await res.json() }
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await sleep(500)
  }
  return { error: lastErr instanceof Error ? lastErr.message : String(lastErr) }
}

async function main() {
  for (const tier of TIERS) {
    section(`500MB DB @ ${tier}`)
    await setMemory(tier)
    await sleep(2000)
    const e2e: number[] = []
    const restore: number[] = []
    const rss: number[] = []
    let failures = 0
    for (let i = 0; i < COLD_STARTS; i++) {
      const r = await coldStart()
      if ('error' in r) {
        failures++
        console.log(`  [${i + 1}/${COLD_STARTS}] FAILED: ${r.error}`)
        logResult('e3b-memory.jsonl', { tier, iter: i, error: r.error })
        continue
      }
      e2e.push(r.ms)
      restore.push(r.metrics.bootTimings.restoreMs)
      rss.push(r.metrics.rssMB)
      console.log(
        `  [${i + 1}/${COLD_STARTS}] e2e=${round(r.ms)}ms ready=${r.metrics.readyMs}ms rss=${r.metrics.rssMB}MB cold=${r.metrics.coldRequest}`,
      )
      logResult('e3b-memory.jsonl', {
        tier,
        iter: i,
        endToEndMs: round(r.ms),
        readyMs: r.metrics.readyMs,
        bootTimings: r.metrics.bootTimings,
        rssMB: r.metrics.rssMB,
      })
    }
    const summary = {
      probe: 'summary',
      tier,
      coldStarts: COLD_STARTS,
      failures,
      endToEndMs: e2e.length ? stats(e2e) : null,
      restoreMs: restore.length ? stats(restore) : null,
      rssMB: rss.length ? stats(rss) : null,
    }
    logResult('e3b-memory.jsonl', summary)
    console.log(
      `  ── ${tier}: ${failures}/${COLD_STARTS} failures` +
        (e2e.length ? `, cold p50=${stats(e2e).p50}ms` : ''),
    )
  }
  // Leave the service on the tier that worked (last one wins; 2Gi re-set below).
  await setMemory('2Gi')
  section('Done (service restored to 2Gi)')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
