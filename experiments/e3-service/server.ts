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
import { ZeroPG, FencedError, LockedError, type Durability, type CommitInfo } from '@zeropg/objectstore-fs'

const PROCESS_START = performance.now()
const __dirname = dirname(fileURLToPath(import.meta.url))

const BUCKET = process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
const DB_PREFIX = process.env.ZEROPG_PREFIX ?? 'demo/default'
const APP_LABEL = process.env.APP_LABEL ?? 'zeropg demo'
// Durability: 'sleep' (default) = writes live in memory, one snapshot upload
// when Cloud Run tells us to sleep (SIGTERM). 'interval' = background flush
// every second. 'strict' = every write commits to the bucket before returning.
const DURABILITY: Durability = (['strict', 'interval', 'sleep'].includes(
  process.env.ZEROPG_DURABILITY ?? '',
)
  ? process.env.ZEROPG_DURABILITY
  : 'sleep') as Durability
// Sleep-mode backstop: Cloud Run only grants ~10s after SIGTERM, which a large
// snapshot upload can blow through. Flush after this much request idleness so
// the upload normally happens while we are still alive and unhurried. 0 = off.
const IDLE_FLUSH_MS = Number(process.env.ZEROPG_IDLE_FLUSH_MS ?? 60_000)
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
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: DB_PREFIX })
  try {
    db = await ZeroPG.open({
      store,
      holder: INSTANCE_ID,
      durability: DURABILITY,
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
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A real Postgres, living in a GCS bucket. No database server. Scales to zero.</div>
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
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
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
  const commitRows = w.commit
    ? `<tr><td>· checkpoint</td><td>${f(w.commit.dumpMs)} ms</td></tr>
 <tr><td>· snapshot upload (${(w.commit.snapshotBytes / 1e6).toFixed(1)} MB)</td><td>${f(w.commit.uploadMs)} ms</td></tr>
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
