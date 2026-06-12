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
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, FencedError, LockedError } from '@zeropg/objectstore-fs'

const PROCESS_START = performance.now()
const __dirname = dirname(fileURLToPath(import.meta.url))

const BUCKET = process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
const DB_PREFIX = process.env.ZEROPG_PREFIX ?? 'demo/default'
const APP_LABEL = process.env.APP_LABEL ?? 'zeropg demo'
const RELAXED = process.env.ZEROPG_RELAXED === '1'
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

async function boot() {
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: DB_PREFIX })
  try {
    db = await ZeroPG.open({
      store,
      holder: INSTANCE_ID,
      relaxedDurability: RELAXED,
      leaseTtlMs: 60_000, // > Cloud Run idle windows; revalidated on the request path
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
  if (url.pathname === '/_restart') {
    res.end(JSON.stringify({ restarting: true }))
    setTimeout(() => process.exit(0), 50)
    return
  }

  const isColdRequest = requestsServed === 0
  requestsServed++

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
      relaxed: RELAXED,
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
      return json(res, 200, { rows: r.rows, ms: Math.round((performance.now() - t0) * 100) / 100 })
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (url.pathname === '/notes' && req.method === 'POST') {
    const body = await readBody(req)
    const params = new URLSearchParams(body)
    const text = (params.get('body') ?? '').slice(0, 500)
    try {
      if (!paused) await db.validateLease() // E4 bet b: validate on the request path
      await db.query('INSERT INTO notes (body) VALUES ($1)', [text || '(empty)'])
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
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A real Postgres, living in a GCS bucket. No database server. Scales to zero.</div>
${banner}
<table>
 <tr><td>database size</td><td><b>${dbMB} MB</b> on disk</td></tr>
 <tr><td>notes</td><td>${info.notes}</td></tr>
 <tr><td>filler rows</td><td>${info.fillerRows}</td></tr>
 <tr><td>cold-start total</td><td><b>${Math.round(readyMs)} ms</b></td></tr>
 <tr><td>· snapshot download</td><td>${Math.round(b.snapshotGetMs)} ms (${(b.snapshotBytes / 1e6).toFixed(1)} MB)</td></tr>
 <tr><td>· gunzip</td><td>${Math.round(b.gunzipMs)} ms</td></tr>
 <tr><td>· PGlite init + restore</td><td>${Math.round(b.pgliteCreateMs)} ms</td></tr>
 <tr><td>· lease acquire</td><td>${Math.round(b.leaseMs)} ms</td></tr>
 <tr><td>fencing token</td><td>${db.fencingToken ?? '—'}</td></tr>
</table>
<form method="post" action="/notes">
 <input type="text" name="body" placeholder="leave a note (it persists in the bucket)" maxlength="500" autofocus>
 <button>add note</button>
</form>
<ul>${rows || '<li><i>no notes yet — add one, then watch it survive a scale-to-zero</i></li>'}</ul>
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// Graceful shutdown: Cloud Run sends SIGTERM + 10s grace. Flush + release lease.
async function shutdown(signal: string) {
  console.log(JSON.stringify({ event: 'shutdown', signal }))
  try {
    if (db) await db.close() // flushes pending commit + releases lease
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
