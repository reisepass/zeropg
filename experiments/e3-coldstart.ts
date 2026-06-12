// E3: cold-start-vs-size statistics against the live Cloud Run services.
//
// Forces a real cold start each iteration by aborting the running instance
// (/_fault/abort exits the process), waiting for Cloud Run to tear it down,
// then timing the next request end-to-end. The server reports its internal
// boot breakdown via /metrics, so we capture both the user-perceived latency
// and where the time goes.
//
//   tsx experiments/e3-coldstart.ts [iterations]

import { logResult, stats, round, section } from './_util.js'

const ITER = Number(process.argv[2] ?? 20)

const SERVICES = [
  { label: '1MB', url: 'https://zeropg-demo-1mb-71428757273.europe-west1.run.app' },
  { label: '50MB', url: 'https://zeropg-demo-50mb-71428757273.europe-west1.run.app' },
  { label: '500MB', url: 'https://zeropg-demo-500mb-71428757273.europe-west1.run.app' },
]

async function getJson(url: string, timeoutMs = 30000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function abort(url: string): Promise<void> {
  try {
    await fetch(`${url}/_fault/abort`, { signal: AbortSignal.timeout(5000) })
  } catch {
    // connection reset is expected — the process exits mid-response.
  }
}

/** Hit /metrics, retrying through the brief 503/connection window after abort. */
async function coldRequest(url: string): Promise<{ ms: number; metrics: any }> {
  const t0 = performance.now()
  const deadline = t0 + 40000
  let lastErr: unknown
  while (performance.now() < deadline) {
    try {
      const metrics = await getJson(`${url}/metrics`, 35000)
      return { ms: performance.now() - t0, metrics }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw lastErr
}

async function probeService(svc: { label: string; url: string }) {
  section(`Cold start @ ${svc.label} — ${svc.url}`)
  // Warm once to confirm reachability and learn DB size.
  let warm: any
  try {
    warm = await getJson(`${svc.url}/metrics`)
  } catch (e) {
    console.log(`  ⚠ service unreachable (${e instanceof Error ? e.message : e}); skipping`)
    return
  }
  const dbMB = round(Number(warm.dbBytes) / 1e6)
  console.log(`  db=${dbMB}MB rss=${warm.rssMB}MB`)

  const endToEnd: number[] = []
  const serverReady: number[] = []
  const snapshotGet: number[] = []
  const pgliteCreate: number[] = []
  let coldConfirmed = 0

  for (let i = 0; i < ITER; i++) {
    await abort(svc.url) // kill the current instance
    await new Promise((r) => setTimeout(r, 3000)) // let Cloud Run notice it died
    const { ms, metrics } = await coldRequest(svc.url)
    if (metrics.coldRequest) coldConfirmed++
    endToEnd.push(ms)
    serverReady.push(metrics.readyMs)
    snapshotGet.push(metrics.bootTimings.restoreMs)
    pgliteCreate.push(metrics.bootTimings.pgliteCreateMs)
    process.stdout.write(
      `  [${i + 1}/${ITER}] e2e=${round(ms)}ms ready=${metrics.readyMs}ms cold=${metrics.coldRequest}\n`,
    )
    logResult('e3-coldstart.jsonl', {
      size: svc.label,
      dbMB,
      iter: i,
      endToEndMs: round(ms),
      readyMs: metrics.readyMs,
      bootTimings: metrics.bootTimings,
      coldRequest: metrics.coldRequest,
    })
  }

  const summary = {
    size: svc.label,
    dbMB,
    iterations: ITER,
    coldConfirmed,
    endToEndMs: stats(endToEnd),
    serverReadyMs: stats(serverReady),
    restoreMs: stats(snapshotGet),
    pgliteCreateMs: stats(pgliteCreate),
  }
  logResult('e3-coldstart.jsonl', { probe: 'summary', ...summary })
  console.log(
    `  ── ${svc.label} (${dbMB}MB): end-to-end cold start p50=${summary.endToEndMs.p50}ms ` +
      `p99=${summary.endToEndMs.p99}ms | server-ready p50=${summary.serverReadyMs.p50}ms | ` +
      `cold-confirmed ${coldConfirmed}/${ITER}`,
  )
}

async function main() {
  console.log(`E3 cold-start statistics — ${ITER} iterations per size`)
  for (const svc of SERVICES) {
    await probeService(svc)
  }
  section('Done')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
