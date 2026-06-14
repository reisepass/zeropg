// loadtest-service — a long-running CRUD/simulation app on ZeroPG, built to be
// deployed to Cloud Run and pointed (with siblings / a local writer) at ONE GCS
// prefix so the single-writer lease is stress-tested under real contention.
//
// Unlike the e3 demo (a guestbook that writes only when a human clicks), this
// service writes CONTINUOUSLY on its own: a background simulator appends to a
// hash-chained ledger (ledger.ts) a few times per second whenever it holds the
// lease. The chain is the integrity instrument — if two instances ever both
// committed (a single-writer violation), the chain forks / a fence regresses /
// a row hash fails to round-trip, all of which /verify reports.
//
// Endpoints (a superset of e3's, same idioms):
//   GET  /            — live status page (instance, token, chain tip, writes/s)
//   GET  /metrics     — JSON: instance, fencingToken, chain tip, sim counters
//   GET  /verify      — walk the WHOLE chain in-process, return the verdict
//   POST /sql {sql}   — arbitrary SQL (durably committed in strict mode)
//   POST /sim/start?rps=  — start/adjust the background write simulator
//   POST /sim/stop    — pause the simulator (instance keeps the lease)
//   POST /flush       — force a flush now
//   POST /sleep       — flush + release lease + exit 0 (next request cold-starts)
//   GET  /up,/healthz — health
//
// Durability defaults to 'strict' here (every sim write is its own fenced
// manifest CAS) so contention is maximally visible; override with
// ZEROPG_DURABILITY. Lease churn is driven externally (max-instances>1, a
// second service, a local writer, or repeated /sleep).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GcsBlobStore, R2BlobStore, type BlobStore } from '@zeropg/blobstore'
import { ZeroPG, FencedError, LockedError, type Durability } from '@zeropg/objectstore-fs'
import { LEDGER_DDL, appendRow, readTip, verifyChain } from './ledger.js'

const PROCESS_START = performance.now()
const __dirname = dirname(fileURLToPath(import.meta.url))

// Transport: COS (S3/SigV4) when its HMAC creds are present, else GCS — exactly
// the e3-service selection so one image serves either backend.
const USE_COS = !!(process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY)
const BUCKET = USE_COS
  ? process.env.COS_BUCKET ?? 'zeropg-cos'
  : process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
const DB_PREFIX = process.env.ZEROPG_PREFIX ?? 'demo/loadtest'
const STORAGE_SCHEME = USE_COS ? 's3' : 'gs'

function selectStore(): BlobStore {
  if (USE_COS) {
    const endpoint = process.env.COS_ENDPOINT_DIRECT || process.env.COS_ENDPOINT
    if (!endpoint) throw new Error('COS_* creds set but no COS_ENDPOINT/COS_ENDPOINT_DIRECT')
    return new R2BlobStore({
      endpoint,
      accessKeyId: process.env.COS_HMAC_ACCESS_KEY_ID!,
      secretAccessKey: process.env.COS_HMAC_SECRET_ACCESS_KEY!,
      bucket: BUCKET,
      prefix: DB_PREFIX,
      region: process.env.IBM_COS_REGION ?? 'eu-de',
    })
  }
  return new GcsBlobStore({ bucket: BUCKET, prefix: DB_PREFIX })
}

const APP_LABEL = process.env.APP_LABEL ?? 'zeropg loadtest'
const DURABILITY: Durability = (['strict', 'interval', 'sleep'].includes(process.env.ZEROPG_DURABILITY ?? '')
  ? process.env.ZEROPG_DURABILITY
  : 'strict') as Durability
const PORT = Number(process.env.PORT ?? 8080)
const INSTANCE_ID = `${process.env.K_REVISION ?? 'local'}-${process.pid}`
// Background simulator default rate (writes/sec). 0 => start paused.
const SIM_RPS = Number(process.env.LOADTEST_RPS ?? 3)
// Lease TTL. Kept modest so an external takeover (sibling / local writer) is
// observable within the run, but > Cloud Run's request throttling windows.
const LEASE_TTL_MS = Number(process.env.ZEROPG_LEASE_TTL_MS ?? 30_000)

function loadSeed(): Uint8Array | undefined {
  const p = join(__dirname, 'seed.tar.gz')
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

let db: ZeroPG
let readyMs = 0
let bootError: string | null = null
let requestsServed = 0

// ---- background write simulator (the "continuous writes" the brief asks for) ----
interface SimState {
  running: boolean
  rps: number
  appended: number
  fenced: number // sim writes rejected because we lost the lease (correct!)
  errors: number
  startedAt: number
  lastSeq: number
  lastFence: number
  lastError: string | null
}
const sim: SimState = {
  running: false,
  rps: SIM_RPS,
  appended: 0,
  fenced: 0,
  errors: 0,
  startedAt: 0,
  lastSeq: 0,
  lastFence: 0,
  lastError: null,
}
let simTimer: NodeJS.Timeout | null = null
let simBusy = false

async function simTick() {
  if (!sim.running || simBusy || !db) return
  simBusy = true
  try {
    // Request-path lease validation: throws FencedError if a sibling took over,
    // which is the single-writer guarantee doing its job. We do NOT blind-retry;
    // a fenced instance flips the sim off and the next request cold-starts/takes
    // over cleanly.
    await db.validateLease()
    const fence = db.fencingToken ?? 0
    const tip = await appendRow(db, INSTANCE_ID, fence, `sim @${Date.now()}`)
    // A little mixed CRUD so the WAL isn't a single-table stream.
    await db.query(
      'INSERT INTO kv (k,v,n) VALUES ($1,$2,1) ON CONFLICT (k) DO UPDATE SET v=excluded.v, n=kv.n+1',
      [`k${tip.seq % 64}`, `v${tip.seq}`],
    )
    sim.appended++
    sim.lastSeq = tip.seq
    sim.lastFence = fence
  } catch (e) {
    if (e instanceof FencedError || e instanceof LockedError) {
      sim.fenced++
      sim.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      // We are no longer the writer. Stop simulating; stay up to serve reads.
      sim.running = false
      console.log(JSON.stringify({ event: 'sim-fenced', instance: INSTANCE_ID, detail: sim.lastError }))
    } else {
      sim.errors++
      sim.lastError = e instanceof Error ? e.message : String(e)
      console.error(JSON.stringify({ event: 'sim-error', error: sim.lastError }))
    }
  } finally {
    simBusy = false
  }
}

function startSim(rps: number) {
  sim.rps = Math.max(0.1, Math.min(50, rps))
  sim.running = true
  if (!sim.startedAt) sim.startedAt = Date.now()
  if (simTimer) clearInterval(simTimer)
  simTimer = setInterval(() => void simTick(), Math.round(1000 / sim.rps))
  simTimer.unref?.()
}
function stopSim() {
  sim.running = false
  if (simTimer) clearInterval(simTimer)
  simTimer = null
}

async function boot() {
  const store = selectStore()
  try {
    db = await ZeroPG.open({
      store,
      holder: INSTANCE_ID,
      durability: DURABILITY,
      leaseTtlMs: LEASE_TTL_MS,
      acquireTimeoutMs: 90_000, // ride out a revision-switch / sibling overlap
      seedSnapshot: loadSeed(),
    })
    await db.raw.exec(LEDGER_DDL)
    await db.raw.exec(
      'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, n BIGINT NOT NULL DEFAULT 0)',
    )
    readyMs = performance.now() - PROCESS_START
    console.log(
      JSON.stringify({ event: 'ready', readyMs, instance: INSTANCE_ID, token: db.fencingToken, boot: db.bootTimings }),
    )
    if (sim.rps > 0) startSim(sim.rps) // begin writing immediately
  } catch (e) {
    bootError = e instanceof Error ? e.message : String(e)
    console.error(JSON.stringify({ event: 'boot-error', error: bootError }))
  }
}

// ---- helpers ----
function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
}
function simWritesPerSec(): number {
  const span = (Date.now() - sim.startedAt) / 1000
  return span > 0 ? Math.round((sim.appended / span) * 100) / 100 : 0
}

// ---- routes ----
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/up' || url.pathname === '/healthz') {
    if (bootError) return json(res, 503, { ok: false, error: bootError })
    return json(res, db ? 200 : 503, { ok: !!db })
  }

  requestsServed++
  if (!db) return json(res, 503, { error: bootError ?? 'still booting' })

  if (url.pathname === '/metrics') {
    const mem = process.memoryUsage()
    const tip = await readTip(db)
    return json(res, 200, {
      instance: INSTANCE_ID,
      revision: process.env.K_REVISION ?? null,
      readyMs: Math.round(readyMs),
      requestsServed,
      fencingToken: db.fencingToken,
      durability: db.durabilityMode,
      pendingFlush: db.pendingFlush,
      chainTipSeq: tip.seq,
      sim: { ...sim, writesPerSec: simWritesPerSec() },
      rssMB: Math.round(mem.rss / 1e6),
    })
  }

  // Walk the entire chain in-process and return the integrity verdict. This is
  // the writer's own view; the leaseless verifier in the harness is the
  // independent one. Both must agree.
  if (url.pathname === '/verify') {
    const t0 = performance.now()
    const v = await verifyChain(db)
    return json(res, v.ok ? 200 : 500, { ...v, ms: Math.round(performance.now() - t0) })
  }

  if (url.pathname === '/sim/start' && req.method === 'POST') {
    const rps = Number(url.searchParams.get('rps') ?? sim.rps)
    startSim(rps)
    return json(res, 200, { running: sim.running, rps: sim.rps })
  }
  if (url.pathname === '/sim/stop' && req.method === 'POST') {
    stopSim()
    return json(res, 200, { running: sim.running })
  }

  if (url.pathname === '/sql' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const { sql } = JSON.parse(body) as { sql: string }
      const t0 = performance.now()
      const r = await db.query(sql)
      return json(res, 200, {
        rows: r.rows,
        ms: Math.round((performance.now() - t0) * 100) / 100,
        commit: r.commit,
        fencingToken: db.fencingToken,
      })
    } catch (e) {
      const status = e instanceof FencedError ? 423 : 400
      return json(res, status, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (url.pathname === '/flush' && req.method === 'POST') {
    try {
      const t0 = performance.now()
      const commit = await db.flush()
      return json(res, 200, { flushed: !!commit, ms: Math.round(performance.now() - t0), commit })
    } catch (e) {
      const status = e instanceof FencedError ? 423 : 500
      return json(res, status, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (url.pathname === '/sleep' && req.method === 'POST') {
    stopSim()
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
    const line = (s = '') => res.write(s + '\n')
    line(`💤 sleep — instance ${INSTANCE_ID} (token ${db.fencingToken})`)
    line(`   bucket: ${STORAGE_SCHEME}://${BUCKET}/${DB_PREFIX}`)
    try {
      const c = await db.flush()
      line(`→ flushed: ${c ? `seq ${c.commitSeq} (${c.mode})` : 'nothing pending'}`)
      await db.close()
      line(`✓ lease released — next request cold-starts a fresh writer`)
    } catch (e) {
      line(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)} (a successor already took over)`)
    }
    res.end()
    setTimeout(() => process.exit(0), 100)
    return
  }

  if (url.pathname === '/' || url.pathname === '') {
    const tip = await readTip(db)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderPage(tip.seq))
    return
  }

  return json(res, 404, { error: 'not found' })
}

function renderPage(tipSeq: number): string {
  const wps = simWritesPerSec()
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(APP_LABEL)} — zeropg loadtest</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.3rem;margin-bottom:0}.sub{color:#666;margin-top:.2rem}
 table{border-collapse:collapse;margin:1rem 0}td{padding:.2rem .9rem .2rem 0}td:first-child{color:#888}
 code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}
 .ok{color:#0b8043;font-weight:600}.run{color:#1a73e8;font-weight:600}.off{color:#888}
 button{padding:.45rem .9rem;border:0;border-radius:6px;color:#fff;cursor:pointer;margin-right:.4rem}
 #v{background:#0b8043}#s{background:#5f6368}
 pre{background:#1e1e1e;color:#d4f7d4;padding:.8rem;border-radius:8px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A continuously-writing Postgres app on object storage. One writer at a time, proven by a hash-chained ledger.</div>
<table>
 <tr><td>instance</td><td><code>${escapeHtml(INSTANCE_ID)}</code></td></tr>
 <tr><td>fencing token</td><td><b>${db.fencingToken ?? '—'}</b></td></tr>
 <tr><td>durability</td><td>${db.durabilityMode}</td></tr>
 <tr><td>simulator</td><td>${sim.running ? `<span class="run">writing</span> ~${sim.rps}/s` : '<span class="off">stopped</span>'}</td></tr>
 <tr><td>ledger rows appended (this instance)</td><td>${sim.appended}</td></tr>
 <tr><td>sustained writes/sec</td><td><b>${wps}</b></td></tr>
 <tr><td>chain tip seq</td><td><b>${tipSeq}</b></td></tr>
 <tr><td>sim fenced (lost lease → stopped)</td><td>${sim.fenced}</td></tr>
 <tr><td>cold-start</td><td>${Math.round(readyMs)} ms</td></tr>
</table>
<button id="v">verify chain integrity</button>
<button id="s">💤 sleep (release lease)</button>
<pre id="out" hidden></pre>
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
<script>
const out=document.getElementById('out')
document.getElementById('v').onclick=async()=>{out.hidden=false;out.textContent='verifying…'
 const r=await fetch('/verify');const j=await r.json()
 out.textContent=(j.ok?'✅ chain intact\\n':'❌ VIOLATIONS\\n')+JSON.stringify(j,null,2)}
document.getElementById('s').onclick=async()=>{out.hidden=false;out.textContent=''
 const r=await fetch('/sleep',{method:'POST'});const rd=r.body.getReader(),d=new TextDecoder()
 for(;;){const{value,done}=await rd.read();if(done)break;out.textContent+=d.decode(value,{stream:true})}
 out.textContent+='\\n[reload to cold-start a fresh writer]'}
</script>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

async function shutdown(signal: string) {
  stopSim()
  console.log(JSON.stringify({ event: 'shutdown', signal, pendingFlush: db?.pendingFlush ?? false }))
  try {
    if (db) await db.close()
  } catch (e) {
    console.error(JSON.stringify({ event: 'shutdown-error', error: e instanceof Error ? e.message : String(e) }))
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await boot()
createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }))
}).listen(PORT, () => console.log(JSON.stringify({ event: 'listening', port: PORT })))
