// E3/E4/demo service: a real little app backed by ZeroPG (PGlite on GCS),
// deployed to Cloud Run with --min-instances=0 so it scales to zero. The whole
// point is that the database is just bytes in a bucket; this container holds no
// state. When it wakes from zero it restores from the bucket and serves.
//
// Doubles as the experiment harness: /metrics reports the cold-start breakdown,
// /sql runs arbitrary statements, and the fault endpoints drive E4.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'
import type { BlobStore } from '@zeropg/blobstore'
import { ZeroPG, FencedError, LockedError, type Durability, type CommitInfo } from '@zeropg/objectstore-fs'
import { runBenchmark } from './bench.js' // BENCH: TPC-C engine (additive feature)

const PROCESS_START = performance.now()
const __dirname = dirname(fileURLToPath(import.meta.url))

// Transport selection. When COS_* (IBM Cloud Object Storage) HMAC creds are
// present we drive the existing S3/SigV4 R2BlobStore against the COS endpoint —
// no new transport code, exactly the construction the storage survey confirmed.
// Otherwise we use the GCS store (the original Cloud Run wiring). This is the
// only difference between the Cloud Run + GCS demo and the Code Engine + COS one.
const USE_COS = !!(
  process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY
)
const BUCKET = USE_COS
  ? process.env.COS_BUCKET ?? 'zeropg-cos'
  : process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
const DB_PREFIX = process.env.ZEROPG_PREFIX ?? 'demo/default'
const STORAGE_SCHEME = USE_COS ? 's3' : 'gs'

function selectStore(): BlobStore {
  if (USE_COS) {
    // Prefer the same-cloud DIRECT endpoint from inside Code Engine (no egress);
    // fall back to the public endpoint if only that is set.
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
const APP_LABEL = process.env.APP_LABEL ?? 'zeropg demo'
// Human label for the storage backend, shown on the demo page. Env-driven so a
// single image serves every backend without hardcoded copy. Falls back to a
// generic phrase derived from the transport when unset.
const BACKEND_LABEL =
  process.env.ZEROPG_BACKEND_LABEL ??
  (USE_COS ? 'an S3-compatible object store' : 'Google Cloud Storage')
// Durability: 'sleep' (default) = writes live in memory, one snapshot upload
// when Cloud Run tells us to sleep (SIGTERM). 'interval' = background flush
// every second. 'strict' = every write commits to the bucket before returning.
const DURABILITY: Durability = (['strict', 'interval', 'sleep'].includes(
  process.env.ZEROPG_DURABILITY ?? '',
)
  ? process.env.ZEROPG_DURABILITY
  : 'sleep') as Durability
// Sleep-mode backstop, sized by two hazards measured in E4:
//  1. Cloud Run only grants ~10s after SIGTERM — a large snapshot upload can
//     blow through it.
//  2. During a revision switch the NEW instance becomes ready by taking over
//     the lease at TTL expiry (60s after our last renew) and fence-stamps the
//     manifest; from that instant our flush is correctly rejected. So pending
//     writes must be flushed strictly before idle reaches the lease TTL:
//     idle-flush (25s) + worst-case upload (~10s) < TTL (60s).
const IDLE_FLUSH_MS = Number(process.env.ZEROPG_IDLE_FLUSH_MS ?? 25_000)
const PORT = Number(process.env.PORT ?? 8080)
const INSTANCE_ID = `${process.env.K_REVISION ?? 'local'}-${process.pid}`

// Seed snapshot (empty datadir) shipped in the image so a fresh DB skips initdb.
function loadSeed(): Uint8Array | undefined {
  const p = join(__dirname, 'seed.tar.gz')
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

let db: ZeroPG
let readyMs = 0
let bootError: string | null = null
let requestsServed = 0
let paused = false // E4 fault injection: pause request-path lease validation

/** Step-by-step timing of the most recent write (what the user asked to see). */
interface WriteTiming {
  at: string
  sql: string
  execMs: number // PGlite executing the statement (memory speed)
  leaseMs: number // request-path lease validate/renew
  commit: CommitInfo | null // checkpoint/upload/manifest split, when durable
  totalMs: number
  durable: boolean // did this write reach the bucket before responding?
}
let lastWrite: WriteTiming | null = null
let sleeping = false // a /sleep is in progress; the instance is on its way out
let benching = false // BENCH: a /bench run is in progress (one at a time)

let idleTimer: NodeJS.Timeout | null = null
function armIdleFlush() {
  if (IDLE_FLUSH_MS <= 0 || DURABILITY !== 'sleep') return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (db?.pendingFlush) {
      const t0 = performance.now()
      db.flush()
        .then((c) =>
          console.log(JSON.stringify({ event: 'idle-flush', ms: Math.round(performance.now() - t0), commit: c })),
        )
        .catch((e) => console.error(JSON.stringify({ event: 'idle-flush-error', error: String(e) })))
    }
  }, IDLE_FLUSH_MS)
  idleTimer.unref?.()
}

async function boot() {
  const store = selectStore()
  try {
    db = await ZeroPG.open({
      store,
      holder: INSTANCE_ID,
      durability: DURABILITY,
      leaseTtlMs: 60_000, // > Cloud Run idle windows; revalidated on the request path
      acquireTimeoutMs: 90_000, // ride out revision-switch / crash-restart lease overlap
      seedSnapshot: loadSeed(),
    })
    // App schema (idempotent). Don't commit if nothing changed.
    await db.raw.exec(
      `CREATE TABLE IF NOT EXISTS notes (id serial primary key, body text not null, created_at timestamptz default now());`,
    )
    readyMs = performance.now() - PROCESS_START
    console.log(JSON.stringify({ event: 'ready', readyMs, boot: db.bootTimings, instance: INSTANCE_ID }))
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
async function dbSizeInfo() {
  const notes = await db.raw.query<{ n: string }>('SELECT count(*)::text n FROM notes')
  let fillerRows = '0'
  let dbBytes = '0'
  try {
    const f = await db.raw.query<{ n: string }>('SELECT count(*)::text n FROM filler')
    fillerRows = f.rows[0]?.n ?? '0'
  } catch {
    /* no filler table */
  }
  try {
    const sz = await db.raw.query<{ b: string }>(
      "SELECT pg_database_size(current_database())::text b",
    )
    dbBytes = sz.rows[0]?.b ?? '0'
  } catch {
    /* ignore */
  }
  return { notes: notes.rows[0]?.n ?? '0', fillerRows, dbBytes }
}

// ---- routes ----
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost`)

  // Health: cheap, no DB. (Named /up because Google Front End reserves the
  // literal path /healthz and answers it before the request reaches us.) Does
  // NOT count as a served request, so it can't consume the "cold request" flag.
  if (url.pathname === '/up' || url.pathname === '/healthz') {
    if (bootError) return json(res, 503, { ok: false, error: bootError })
    return json(res, db ? 200 : 503, { ok: !!db })
  }

  // Clean restart for cold-start measurement: exit 0 so Cloud Run does not
  // apply crash-restart backoff (unlike /_fault/abort which simulates a crash).
  // Flushes first — in sleep mode a bare exit would drop pending writes.
  if (url.pathname === '/_restart') {
    res.end(JSON.stringify({ restarting: true, pendingFlush: db?.pendingFlush ?? false }))
    setTimeout(() => {
      void (db ? db.close() : Promise.resolve()).finally(() => process.exit(0))
    }, 50)
    return
  }

  const isColdRequest = requestsServed === 0
  requestsServed++
  armIdleFlush()

  if (!db) return json(res, 503, { error: bootError ?? 'still booting' })

  // E4 fault injection endpoints.
  if (url.pathname === '/_fault/pause-lease') {
    paused = true
    return json(res, 200, { paused })
  }
  if (url.pathname === '/_fault/resume-lease') {
    paused = false
    return json(res, 200, { paused })
  }
  if (url.pathname === '/_fault/abort') {
    res.end()
    process.exit(137) // simulate a hard crash (no graceful flush)
    return
  }

  if (url.pathname === '/metrics') {
    const mem = process.memoryUsage()
    return json(res, 200, {
      instance: INSTANCE_ID,
      revision: process.env.K_REVISION ?? null,
      coldRequest: isColdRequest,
      readyMs: Math.round(readyMs),
      bootTimings: db.bootTimings,
      requestsServed,
      fencingToken: db.fencingToken,
      durability: db.durabilityMode,
      pendingFlush: db.pendingFlush,
      lastWrite,
      rssMB: Math.round(mem.rss / 1e6),
      ...(await dbSizeInfo()),
    })
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
        execMs: Math.round(r.execMs * 100) / 100,
        commit: r.commit,
        durability: db.durabilityMode,
      })
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  // BENCH: run a TPC-C OLTP benchmark against the live PGlite DB and STREAM
  // progress (tpmC / throughput / latency percentiles / live DB size / rows
  // trimmed) to the client, exactly like /sleep streams its flush steps. The
  // engine (bench.ts) records pg_database_size as a baseline and trims its own
  // tables so total DB never exceeds ~2x baseline, then drops them at the end.
  if (url.pathname === '/bench' && req.method === 'POST') {
    if (benching) return json(res, 409, { error: 'benchmark already running' })
    benching = true
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', // keep proxies from buffering/sniffing
    })
    const line = (s = '') => res.write(s + '\n')
    try {
      const durationMs = Math.min(60_000, Math.max(5_000, Number(url.searchParams.get('seconds') ?? 25) * 1000))
      await runBenchmark(db, { durationMs }, line)
    } catch (e) {
      line(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
    } finally {
      benching = false
      res.end()
    }
    return
  }

  // On-demand sleep: run the same flush + lease-release the SIGTERM handler
  // runs, but STREAM each object-storage step and its timing to the client,
  // then exit 0. The next request cold-starts a fresh instance. There is no
  // Cloud Run API to ask the platform to SIGTERM us from inside the container;
  // a clean self-exit is the idiom and yields the same observable cold start
  // without the crash-restart backoff a non-zero exit triggers (see E3).
  // No special concurrency handling: a second caller just gets told we're
  // already on our way out; everyone else cold-starts on the fresh instance.
  if (url.pathname === '/sleep' && req.method === 'POST') {
    if (sleeping) return json(res, 409, { error: 'already shutting down' })
    sleeping = true
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', // keep proxies from buffering/ sniffing
    })
    const t0 = performance.now()
    const since = () => `${Math.round(performance.now() - t0)}ms`
    const line = (s = '') => res.write(s + '\n')
    const fmtBytes = (n: number) => (n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`)

    line(`💤 sleep requested — instance ${INSTANCE_ID}`)
    line(`   bucket:    ${STORAGE_SCHEME}://${BUCKET}/${DB_PREFIX}`)
    line(`   durability: ${db.durabilityMode}`)
    line()
    try {
      if (db.pendingFlush) {
        line(`→ flushing pending writes to object storage…`)
        const c = await db.flush()
        if (c && c.mode === 'incremental') {
          line(`  · scan WAL delta                 ${Math.round(c.dumpMs)}ms`)
          line(`  · PUT ${c.segments} WAL segment (${fmtBytes(c.snapshotBytes)})         ${Math.round(c.uploadMs)}ms`)
          line(`  · CAS manifest.json (the commit) ${Math.round(c.manifestMs)}ms   ← durable at this instant`)
          line(`  ✓ committed seq ${c.commitSeq} in ${since()}`)
        } else if (c) {
          line(`  (full-snapshot compaction — the first commit of an instance's life`)
          line(`   always re-snapshots so WAL ranges never cross writer lives; the`)
          line(`   2nd+ write in a life ships only its tiny WAL delta instead)`)
          line(`  · checkpoint + WAL switch        ${Math.round(c.dumpMs)}ms`)
          line(`  · PUT snapshot (${fmtBytes(c.snapshotBytes)})${' '.repeat(Math.max(1, 14 - fmtBytes(c.snapshotBytes).length))}${Math.round(c.uploadMs)}ms`)
          line(`  · CAS manifest.json (the commit) ${Math.round(c.manifestMs)}ms   ← durable at this instant`)
          line(`  ✓ committed seq ${c.commitSeq} in ${since()}`)
        } else {
          line(`  ✓ nothing to flush after all`)
        }
      } else {
        line(`→ no pending writes — the bucket is already current`)
        line(`  (in sleep mode, nothing uploads until there is something to flush)`)
      }
      line()
      line(`→ releasing the writer lease + closing the engine…`)
      const tc = performance.now()
      await db.close() // flush is a no-op now; releases lease.json, clears /tmp
      line(`  ✓ lease released, scratch dir cleared   ${Math.round(performance.now() - tc)}ms`)
      line()
      line(`✅ instance exiting (exit 0) after ${since()}.`)
      line(`   the next request cold-starts a fresh instance that restores from the bucket.`)
      line(`   reload the page to watch it wake up. 🥶`)
    } catch (e) {
      // A fenced flush means a successor already took the lease (e.g. you held
      // this open past the idle-flush + TTL window). Honest about it.
      line(`✗ ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      line(`  (a successor instance already took over; this one exits empty-handed)`)
    }
    res.end()
    setTimeout(() => process.exit(0), 100) // let the last bytes reach the client
    return
  }

  // Explicit flush: push pending writes to the bucket NOW (useful in sleep
  // mode to see the upload cost without waiting for scale-to-zero).
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

  if (url.pathname === '/notes' && req.method === 'POST') {
    const body = await readBody(req)
    const params = new URLSearchParams(body)
    const text = (params.get('body') ?? '').slice(0, 500)
    // Per-write override: the "make durable now" checkbox flushes the snapshot
    // before responding, regardless of the instance's durability mode.
    const durableNow = params.get('durable') === 'on'
    try {
      const t0 = performance.now()
      let leaseMs = 0
      if (!paused) {
        const tl = performance.now()
        await db.validateLease() // E4 bet b: validate on the request path
        leaseMs = performance.now() - tl
      }
      const r = await db.query('INSERT INTO notes (body) VALUES ($1)', [text || '(empty)'])
      let commit = r.commit
      if (durableNow && !commit) commit = await db.flush()
      lastWrite = {
        at: new Date().toISOString(),
        sql: 'INSERT INTO notes (body) VALUES ($1)',
        execMs: r.execMs,
        leaseMs,
        commit,
        totalMs: performance.now() - t0,
        durable: commit !== null,
      }
      res.writeHead(302, { location: '/' })
      res.end()
    } catch (e) {
      const status = e instanceof FencedError || e instanceof LockedError ? 423 : 500
      return json(res, status, { error: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  if (url.pathname === '/' || url.pathname === '') {
    const info = await dbSizeInfo()
    const recent = await db.raw.query<{ id: number; body: string; created_at: string }>(
      'SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 10',
    )
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-zeropg-boot-ms': String(Math.round(readyMs)),
      'x-zeropg-cold': String(isColdRequest),
    })
    res.end(renderPage(info, recent.rows, isColdRequest))
    return
  }

  return json(res, 404, { error: 'not found' })
}

function renderPage(
  info: { notes: string; fillerRows: string; dbBytes: string },
  notes: Array<{ id: number; body: string; created_at: string }>,
  cold: boolean,
) {
  const b = db.bootTimings
  const dbMB = (Number(info.dbBytes) / 1e6).toFixed(1)
  const banner = cold
    ? `<div class="banner cold">🥶 This page was served by a <b>COLD</b> instance that woke from zero and restored a ${dbMB}&nbsp;MB Postgres in <b>${Math.round(readyMs)}&nbsp;ms</b>.</div>`
    : `<div class="banner warm">🔥 Warm instance — request #${requestsServed}. (It cold-started in ${Math.round(readyMs)}&nbsp;ms.)</div>`
  const rows = notes
    .map(
      (n) =>
        `<li><span class="when">${new Date(n.created_at).toISOString().slice(0, 19).replace('T', ' ')}</span> ${escapeHtml(n.body)}</li>`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(APP_LABEL)} — zeropg</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.4rem;margin-bottom:0}.sub{color:#666;margin-top:.2rem}
 .banner{padding:.8rem 1rem;border-radius:8px;margin:1rem 0;font-size:.95rem}
 .cold{background:#e8f0fe;border:1px solid #aac4f5}.warm{background:#fef6e8;border:1px solid #f5d9aa}
 table{border-collapse:collapse;margin:1rem 0;font-size:.9rem}td{padding:.15rem .8rem .15rem 0;color:#333}
 td:first-child{color:#888}
 form{display:flex;gap:.5rem;margin:1rem 0}input[type=text]{flex:1;padding:.5rem;border:1px solid #ccc;border-radius:6px}
 button{padding:.5rem 1rem;border:0;background:#1a73e8;color:#fff;border-radius:6px;cursor:pointer}
 ul{list-style:none;padding:0}li{padding:.35rem 0;border-bottom:1px solid #eee}.when{color:#999;font-size:.8rem;margin-right:.5rem}
 code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}
 .hint{color:#888;font-size:.85rem}.durable{display:flex;align-items:center;gap:.3rem;font-size:.85rem;color:#555;white-space:nowrap}
 details.write{background:#f6fef6;border:1px solid #bce3bc;border-radius:8px;padding:.5rem .8rem;margin:1rem 0;font-size:.9rem}
 details.write table{margin:.3rem 0}
 .sleepbox{margin:1.5rem 0;border-top:1px solid #eee;padding-top:1rem}
 #sleepbtn{background:#5f6368}#sleepbtn:disabled{opacity:.6;cursor:default}
 #sleeplog{background:#1e1e1e;color:#d4f7d4;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:.8rem 1rem;border-radius:8px;margin:.8rem 0 0;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word}
 /* BENCH: TPC-C benchmark button + live log (mirrors the sleep box) */
 #benchbtn{background:#0b8043}#benchbtn:disabled{opacity:.6;cursor:default}
 #benchlog{background:#1e1e1e;color:#cfe8ff;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:.8rem 1rem;border-radius:8px;margin:.8rem 0 0;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A real Postgres, living in ${escapeHtml(BACKEND_LABEL)}. No database server. Scales to zero.</div>
${banner}
<table>
 <tr><td>database size</td><td><b>${dbMB} MB</b> on disk</td></tr>
 <tr><td>notes</td><td>${info.notes}</td></tr>
 <tr><td>filler rows</td><td>${info.fillerRows}</td></tr>
 <tr><td>cold-start total</td><td><b>${Math.round(readyMs)} ms</b></td></tr>
 <tr><td>· snapshot restore (download+gunzip+untar, ${(b.snapshotBytes / 1e6).toFixed(1)} MB)</td><td>${Math.round(b.restoreMs)} ms</td></tr>
 <tr><td>· PGlite open</td><td>${Math.round(b.pgliteCreateMs)} ms</td></tr>
 <tr><td>· lease acquire</td><td>${Math.round(b.leaseMs)} ms</td></tr>
 <tr><td>durability mode</td><td><b>${db.durabilityMode}</b>${durabilityHint()}</td></tr>
 <tr><td>unflushed writes</td><td>${db.pendingFlush ? '⏳ in memory, upload on sleep' : '✓ none — bucket is current'}</td></tr>
 <tr><td>fencing token</td><td>${db.fencingToken ?? '—'}</td></tr>
</table>
${renderLastWrite()}
<form method="post" action="/notes">
 <input type="text" name="body" placeholder="leave a note (it persists in the bucket)" maxlength="500" autofocus>
 <label class="durable"><input type="checkbox" name="durable"> durable&nbsp;now</label>
 <button>add note</button>
</form>
<ul>${rows || '<li><i>no notes yet — add one, then watch it survive a scale-to-zero</i></li>'}</ul>
<div class="sleepbox">
 <button type="button" id="sleepbtn">💤 put this instance to sleep</button>
 <span class="hint">flushes to the bucket, releases the lease, exits — the next load cold-starts</span>
 <pre id="sleeplog" hidden></pre>
</div>
<div class="sleepbox">
 <button type="button" id="benchbtn">🏎 run TPC-C benchmark</button>
 <span class="hint">a standard OLTP benchmark vs this PGlite DB, streamed live — self-caps its size, then cleans up</span>
 <pre id="benchlog" hidden></pre>
</div>
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
<script>
const sb = document.getElementById('sleepbtn'), sl = document.getElementById('sleeplog')
sb.addEventListener('click', async () => {
  if (sb.dataset.done) { location.reload(); return }
  sb.disabled = true; sb.textContent = '💤 sleeping…'; sl.hidden = false; sl.textContent = ''
  try {
    const res = await fetch('/sleep', { method: 'POST' })
    const reader = res.body.getReader(), dec = new TextDecoder()
    for (;;) { const { value, done } = await reader.read(); if (done) break
      sl.textContent += dec.decode(value, { stream: true }); sl.scrollTop = sl.scrollHeight }
  } catch (e) { sl.textContent += '\\n[connection closed — the instance is gone]' }
  sb.disabled = false; sb.dataset.done = '1'; sb.textContent = '↻ reload to wake it (cold start)'
})
// BENCH: stream the TPC-C benchmark into its log pane (same reader loop as sleep).
const bb = document.getElementById('benchbtn'), bl = document.getElementById('benchlog')
bb.addEventListener('click', async () => {
  bb.disabled = true; bb.textContent = '🏎 benchmarking…'; bl.hidden = false; bl.textContent = ''
  try {
    const res = await fetch('/bench', { method: 'POST' })
    const reader = res.body.getReader(), dec = new TextDecoder()
    for (;;) { const { value, done } = await reader.read(); if (done) break
      bl.textContent += dec.decode(value, { stream: true }); bl.scrollTop = bl.scrollHeight }
  } catch (e) { bl.textContent += '\\n[connection closed]' }
  bb.disabled = false; bb.textContent = '🏎 run TPC-C benchmark again'
})
</script>
</body></html>`
}

function durabilityHint(): string {
  switch (db.durabilityMode) {
    case 'sleep':
      return ' <span class="hint">— writes are memory-speed; the snapshot uploads when the instance is put to sleep</span>'
    case 'interval':
      return ' <span class="hint">— background flush every second (bounded loss window)</span>'
    default:
      return ' <span class="hint">— every write is durable in the bucket before it returns</span>'
  }
}

function renderLastWrite(): string {
  if (!lastWrite) return ''
  const w = lastWrite
  const f = (n: number) => (n < 10 ? n.toFixed(2) : String(Math.round(n)))
  const fmtBytes = (n: number) => (n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`)
  const commitRows = w.commit
    ? w.commit.mode === 'incremental'
      ? `<tr><td>· WAL delta scan</td><td>${f(w.commit.dumpMs)} ms</td></tr>
 <tr><td>· WAL segment upload (${w.commit.segments} × ${fmtBytes(w.commit.snapshotBytes)})</td><td>${f(w.commit.uploadMs)} ms</td></tr>
 <tr><td>· manifest CAS (the actual commit)</td><td>${f(w.commit.manifestMs)} ms</td></tr>`
      : `<tr><td>· checkpoint + WAL switch</td><td>${f(w.commit.dumpMs)} ms</td></tr>
 <tr><td>· snapshot upload — compaction (${fmtBytes(w.commit.snapshotBytes)})</td><td>${f(w.commit.uploadMs)} ms</td></tr>
 <tr><td>· manifest CAS (the actual commit)</td><td>${f(w.commit.manifestMs)} ms</td></tr>`
    : `<tr><td>· bucket upload</td><td><i>deferred — happens on ${db.durabilityMode === 'interval' ? 'the next interval flush' : 'sleep/flush'}</i></td></tr>`
  return `<details class="write" open><summary>last write: <b>${f(w.totalMs)} ms</b> ${w.durable ? '(durable in bucket)' : '(memory; not yet in bucket)'}</summary>
<table>
 <tr><td>SQL execute (PGlite, in memory)</td><td>${f(w.execMs)} ms</td></tr>
 <tr><td>lease validate/renew</td><td>${f(w.leaseMs)} ms</td></tr>
 ${commitRows}
 <tr><td>total request</td><td><b>${f(w.totalMs)} ms</b></td></tr>
</table></details>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// Graceful shutdown: Cloud Run sends SIGTERM + 10s grace. Flush + release lease.
async function shutdown(signal: string) {
  const pending = db?.pendingFlush ?? false
  console.log(JSON.stringify({ event: 'shutdown', signal, pendingFlush: pending }))
  const t0 = performance.now()
  try {
    if (db) await db.close() // sleep-mode flush happens here + releases lease
    console.log(
      JSON.stringify({ event: 'shutdown-done', flushed: pending, ms: Math.round(performance.now() - t0) }),
    )
  } catch (e) {
    // A fenced shutdown flush means a successor already took over: the writes
    // pending here are lost (bounded by the idle-flush backstop). Loud log —
    // if this ever fires with IDLE_FLUSH_MS correctly < lease TTL, it's a bug.
    console.error(
      JSON.stringify({
        event: 'shutdown-flush-failed',
        lostPendingWrites: pending,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }),
    )
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
