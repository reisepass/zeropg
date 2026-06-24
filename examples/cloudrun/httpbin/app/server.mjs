// httpbin + requestbin on zeropg — the BACKEND (ingress) container.
//
// One tiny dependency-light Node app. It serves two things:
//   (a) httpbin-style echo endpoints — pure, stateless, never touch the DB.
//   (b) requestbin — captures inbound requests into the zeropg Postgres (the
//       GCS-backed scale-to-zero `db` sidecar over localhost:5432) and serves
//       them back for inspection.
//
// Design choices (see README + the cross-model review baked into them):
//   - node-postgres `pg`, Pool({ max: 1 }). The zeropg wire is single-session
//     (PGlite); pretending to be concurrent only invites serialization
//     surprises. No named prepared statements (the `pg` default is fine).
//   - Stateless httpbin routes serve immediately and NEVER await DB readiness,
//     so a cold boot answers /get etc. the instant the process is up.
//   - The requestbin schema is ensured lazily on first capture/read, not on the
//     cold-start critical path.
//   - TTL / size bounding is done OPPORTUNISTICALLY (a sweep at most once every
//     few minutes, gated by a `maintenance_state.last_run` row) plus a cheap
//     per-bin id-cutoff cap on the bin just written. NO background worker / cron
//     — nothing holds an inbound request open, so the instance still scales to
//     zero. The cleanup rides on the capture/read requests themselves.
//   - Forwarding (pipedream-style) is AWAITED with a short timeout inside the
//     request, so Cloud Run's request-scoped CPU is still allocated when the
//     outbound call runs. Pure fire-and-forget-after-response is unreliable when
//     the instance freezes, so we don't pretend it is reliable.

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const PORT = Number(process.env.PORT || 8080)
const PGHOST = process.env.PGHOST || '127.0.0.1'
const PGPORT = Number(process.env.PGPORT || 5432)
const PGUSER = process.env.PGUSER || 'postgres'
const PGPASSWORD = process.env.PGPASSWORD || 'postgres'
const PGDATABASE = process.env.PGDATABASE || 'postgres'

// --- bounding knobs (also documented in the README) ---
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024) // 256 KiB cap per capture
const MAX_PER_BIN = Number(process.env.MAX_PER_BIN || 200) // keep last N per bin
const TTL_HOURS = Number(process.env.TTL_HOURS || 24) // drop captures older than this
const SWEEP_EVERY_MS = Number(process.env.SWEEP_EVERY_MS || 5 * 60 * 1000) // global TTL sweep cadence
const LIST_DEFAULT = 50
const LIST_MAX = 500
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 1500)

const BIN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const pool = new pg.Pool({
  host: PGHOST,
  port: PGPORT,
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
  max: 1, // single-session wire — one DB query at a time
  idleTimeoutMillis: 0,
  // Disable named server-side prepared statements globally is unnecessary for
  // `pg` (it only uses them when you pass a `name`), and we never do.
})

// --- lazy schema init: ensured once, off the cold-start critical path ---
let schemaReady = null
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS captures (
          id        bigserial PRIMARY KEY,
          bin_id    text        NOT NULL,
          method    text        NOT NULL,
          path      text        NOT NULL,
          query     text,
          headers   jsonb       NOT NULL,
          body      text,
          body_encoding text    NOT NULL DEFAULT 'utf8',
          body_truncated boolean NOT NULL DEFAULT false,
          remote_ip text,
          ts        timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS captures_bin_id_id_idx ON captures (bin_id, id DESC);
        CREATE INDEX IF NOT EXISTS captures_ts_idx ON captures (ts);
        CREATE TABLE IF NOT EXISTS bins (
          bin_id      text PRIMARY KEY,
          forward_url text,
          created_at  timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS maintenance_state (
          key      text PRIMARY KEY,
          last_run timestamptz NOT NULL
        );
      `)
      .catch((e) => {
        // reset so the next request retries (e.g. db sidecar still booting)
        schemaReady = null
        throw e
      })
  }
  return schemaReady
}

// --- opportunistic TTL sweep: at most once / SWEEP_EVERY_MS, gated in the DB so
// it's correct even across instance restarts. Rides on a real request; never a
// background timer (that would keep the instance from scaling to zero). ---
async function maybeSweep() {
  // Atomically claim the sweep: only one caller per window flips last_run.
  const claim = await pool.query(
    `INSERT INTO maintenance_state (key, last_run)
       VALUES ('ttl', now())
     ON CONFLICT (key) DO UPDATE SET last_run = now()
       WHERE maintenance_state.last_run < now() - ($1::int * interval '1 millisecond')
     RETURNING key`,
    [SWEEP_EVERY_MS],
  )
  if (claim.rowCount === 0) return // someone swept recently; skip
  await pool.query(`DELETE FROM captures WHERE ts < now() - ($1::int * interval '1 hour')`, [TTL_HOURS])
}

// --- per-bin cap via id cutoff (cheap, index-backed, no NOT IN) ---
async function capBin(binId) {
  const cut = await pool.query(
    `SELECT id FROM captures WHERE bin_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1`,
    [binId, MAX_PER_BIN],
  )
  if (cut.rowCount > 0) {
    await pool.query(`DELETE FROM captures WHERE bin_id = $1 AND id <= $2`, [binId, cut.rows[0].id])
  }
}

// ---------- helpers ----------
// CORS: the split frontend is a SEPARATE origin, so its browser calls to the
// echo + requestbin API are cross-origin. Allow them broadly — this is a public
// demo service (it already accepts requests from anywhere) so a wildcard origin
// adds no exposure, and it's what makes the split-frontend pattern work.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': '*',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
}

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  res.writeHead(status, {
    'content-type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...headers,
  })
  res.end(body)
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  return req.socket.remoteAddress || ''
}

function headerObject(req) {
  const o = {}
  for (let i = 0; i < req.rawHeaders.length; i += 2) o[req.rawHeaders[i]] = req.rawHeaders[i + 1]
  return o
}

// Read the body with a hard byte cap. Returns { text, encoding, truncated }.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let truncated = false
    req.on('data', (c) => {
      size += c.length
      if (size <= MAX_BODY_BYTES) {
        chunks.push(c)
      } else if (!truncated) {
        truncated = true
        // keep what fits; stop buffering more
        const remain = MAX_BODY_BYTES - (size - c.length)
        if (remain > 0) chunks.push(c.subarray(0, remain))
        req.destroy() // stop the upload; we have our cap
      }
    })
    req.on('end', () => finish())
    req.on('close', () => finish())
    req.on('error', (e) => reject(e))
    let done = false
    function finish() {
      if (done) return
      done = true
      const buf = Buffer.concat(chunks)
      // Decode as utf8 if it round-trips cleanly, else store base64.
      const text = buf.toString('utf8')
      const isUtf8 = Buffer.from(text, 'utf8').equals(buf)
      resolve(
        isUtf8
          ? { text, encoding: 'utf8', truncated }
          : { text: buf.toString('base64'), encoding: 'base64', truncated },
      )
    }
  })
}

function parsedBody(bodyText, encoding, contentType) {
  if (encoding !== 'utf8') return null
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.parse(bodyText)
    } catch {
      return null
    }
  }
  return null
}

// ---------- httpbin echo (stateless, no DB) ----------
function echoPayload(req, url, bodyText, encoding) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) headers[k] = v
  const args = {}
  for (const [k, v] of url.searchParams.entries()) args[k] = v
  const ct = req.headers['content-type'] || ''
  return {
    args,
    headers,
    origin: clientIp(req),
    url: url.href,
    method: req.method,
    data: encoding === 'utf8' ? bodyText : `(base64) ${bodyText}`,
    json: parsedBody(bodyText, encoding, ct),
  }
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    return send(res, 400, { error: 'bad url' })
  }
  const path = url.pathname

  // CORS preflight: answer OPTIONS for any path so the split frontend's
  // cross-origin POST/config calls succeed. Note: requests under /b/ are also
  // capturable via OPTIONS-as-method below, but a true browser preflight (with
  // access-control-request-method) is answered here and NOT captured.
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.writeHead(204, CORS_HEADERS)
    return res.end()
  }

  try {
    // --- pure stateless httpbin endpoints (NEVER touch the DB) ---
    if (req.method === 'GET' && path === '/') {
      return send(res, 200, {
        service: 'httpbin + requestbin on zeropg',
        echo: ['/get', '/post', '/headers', '/ip', '/user-agent', '/json', '/uuid', '/anything', '/status/:code', '/delay/:n'],
        requestbin: {
          capture: 'ANY /b/:binId  (any method/path under /b/:binId captures)',
          list: 'GET /api/bins/:binId/requests',
          inspect: 'GET /api/bins/:binId/requests/:id',
          configure: 'POST /api/bins/:binId/config  {"forward_url": "https://..."}',
          new_bin_id: 'GET /api/bins/new',
        },
        scale_to_zero: true,
      })
    }
    if (path === '/healthz' || path === '/health') return send(res, 200, 'ok')

    if (path === '/uuid') return send(res, 200, { uuid: randomUUID() })
    if (path === '/ip') return send(res, 200, { origin: clientIp(req) })
    if (path === '/user-agent') return send(res, 200, { 'user-agent': req.headers['user-agent'] || '' })
    if (path === '/headers') return send(res, 200, { headers: headerObject(req) })

    if (path === '/json') {
      return send(res, 200, {
        slideshow: { author: 'zeropg', date: 'now', title: 'Sample Slide Show', slides: [{ title: 'Wake up to zeropg', type: 'all' }] },
      })
    }

    if (path.startsWith('/status/')) {
      const code = Number(path.slice('/status/'.length))
      if (!Number.isInteger(code) || code < 100 || code > 599) return send(res, 400, { error: 'bad status code' })
      return send(res, code, { status: code })
    }

    if (path.startsWith('/delay/')) {
      let n = Number(path.slice('/delay/'.length))
      if (!Number.isFinite(n) || n < 0) return send(res, 400, { error: 'bad delay' })
      n = Math.min(n, 10) // cap at 10s
      await new Promise((r) => setTimeout(r, n * 1000))
      const body = await readBody(req)
      return send(res, 200, echoPayload(req, url, body.text, body.encoding))
    }

    if (path === '/get' && req.method === 'GET') {
      return send(res, 200, echoPayload(req, url, '', 'utf8'))
    }
    if ((path === '/post' || path === '/anything' || path.startsWith('/anything/')) || (path === '/put' && req.method === 'PUT')) {
      const body = await readBody(req)
      return send(res, 200, echoPayload(req, url, body.text, body.encoding))
    }

    // --- requestbin: capture ANY request under /b/:binId ---
    if (path.startsWith('/b/')) {
      const rest = path.slice('/b/'.length)
      const binId = rest.split('/')[0]
      if (!BIN_ID_RE.test(binId)) return send(res, 400, { error: 'bin id must match [A-Za-z0-9_-]{1,64}' })
      const subPath = '/' + rest.split('/').slice(1).join('/')

      const body = await readBody(req)
      await ensureSchema()

      const headers = headerObject(req)
      const ins = await pool.query(
        `INSERT INTO captures (bin_id, method, path, query, headers, body, body_encoding, body_truncated, remote_ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, ts`,
        [binId, req.method, subPath, url.search || '', JSON.stringify(headers), body.text, body.encoding, body.truncated, clientIp(req)],
      )
      const captureId = ins.rows[0].id
      const ts = ins.rows[0].ts

      // bounded cleanup, riding on this request (no background worker)
      await capBin(binId).catch(() => {})
      await maybeSweep().catch(() => {})

      // optional pipedream-style forward (awaited w/ short timeout so CPU is live)
      let forwarded = null
      const cfg = await pool.query(`SELECT forward_url FROM bins WHERE bin_id = $1`, [binId])
      const forwardUrl = cfg.rows[0]?.forward_url
      if (forwardUrl) {
        forwarded = await forwardRequest(forwardUrl, req, body, binId, captureId)
      }

      return send(res, 200, {
        ok: true,
        bin_id: binId,
        capture_id: String(captureId),
        method: req.method,
        path: subPath,
        captured_at: ts,
        body_truncated: body.truncated,
        forwarded,
      })
    }

    // --- requestbin API ---
    if (path === '/api/bins/new') {
      return send(res, 200, { bin_id: randomUUID().replace(/-/g, '').slice(0, 12) })
    }

    const cfgMatch = path.match(/^\/api\/bins\/([^/]+)\/config$/)
    if (cfgMatch && req.method === 'POST') {
      const binId = cfgMatch[1]
      if (!BIN_ID_RE.test(binId)) return send(res, 400, { error: 'bad bin id' })
      const body = await readBody(req)
      let cfg
      try {
        cfg = JSON.parse(body.text || '{}')
      } catch {
        return send(res, 400, { error: 'invalid json' })
      }
      const forwardUrl = cfg.forward_url ? String(cfg.forward_url) : null
      if (forwardUrl && !/^https?:\/\//.test(forwardUrl)) return send(res, 400, { error: 'forward_url must be http(s)' })
      await ensureSchema()
      await pool.query(
        `INSERT INTO bins (bin_id, forward_url) VALUES ($1,$2)
         ON CONFLICT (bin_id) DO UPDATE SET forward_url = EXCLUDED.forward_url`,
        [binId, forwardUrl],
      )
      return send(res, 200, { ok: true, bin_id: binId, forward_url: forwardUrl })
    }

    const listMatch = path.match(/^\/api\/bins\/([^/]+)\/requests$/)
    if (listMatch && req.method === 'GET') {
      const binId = listMatch[1]
      if (!BIN_ID_RE.test(binId)) return send(res, 400, { error: 'bad bin id' })
      let limit = Number(url.searchParams.get('limit') || LIST_DEFAULT)
      if (!Number.isFinite(limit) || limit < 1) limit = LIST_DEFAULT
      limit = Math.min(limit, LIST_MAX)
      await ensureSchema()
      await maybeSweep().catch(() => {}) // cheap sweep on read too
      const rows = await pool.query(
        `SELECT id, method, path, query, headers, body, body_encoding, body_truncated, remote_ip, ts
         FROM captures WHERE bin_id = $1 ORDER BY id DESC LIMIT $2`,
        [binId, limit],
      )
      const cfg = await pool.query(`SELECT forward_url FROM bins WHERE bin_id = $1`, [binId])
      return send(res, 200, {
        bin_id: binId,
        forward_url: cfg.rows[0]?.forward_url || null,
        count: rows.rowCount,
        requests: rows.rows.map((r) => ({ ...r, id: String(r.id) })),
      })
    }

    const inspectMatch = path.match(/^\/api\/bins\/([^/]+)\/requests\/(\d+)$/)
    if (inspectMatch && req.method === 'GET') {
      const binId = inspectMatch[1]
      const id = inspectMatch[2]
      if (!BIN_ID_RE.test(binId)) return send(res, 400, { error: 'bad bin id' })
      await ensureSchema()
      const rows = await pool.query(
        `SELECT id, method, path, query, headers, body, body_encoding, body_truncated, remote_ip, ts
         FROM captures WHERE bin_id = $1 AND id = $2`,
        [binId, id],
      )
      if (rows.rowCount === 0) return send(res, 404, { error: 'not found' })
      const r = rows.rows[0]
      return send(res, 200, { ...r, id: String(r.id) })
    }

    return send(res, 404, { error: 'not found', path })
  } catch (e) {
    return send(res, 500, { error: 'server error', detail: String(e && e.message ? e.message : e) })
  }
})

async function forwardRequest(forwardUrl, req, body, binId, captureId) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FORWARD_TIMEOUT_MS)
  try {
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      // drop hop-by-hop / host headers
      if (['host', 'content-length', 'connection'].includes(k.toLowerCase())) continue
      headers[k] = v
    }
    headers['x-zeropg-bin'] = binId
    headers['x-zeropg-capture-id'] = String(captureId)
    const init = { method: req.method, headers, signal: ctrl.signal }
    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = body.encoding === 'utf8' ? body.text : Buffer.from(body.text, 'base64')
    }
    const resp = await fetch(forwardUrl, init)
    return { url: forwardUrl, status: resp.status, ok: resp.ok }
  } catch (e) {
    return { url: forwardUrl, error: e.name === 'AbortError' ? `timeout after ${FORWARD_TIMEOUT_MS}ms` : String(e.message || e) }
  } finally {
    clearTimeout(t)
  }
}

// Hard limits against abusive/slow uploads on the single-process app.
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.keepAliveTimeout = 5_000

server.listen(PORT, () => {
  console.log(`[httpbin] up on :${PORT} (db ${PGHOST}:${PGPORT}, max_body=${MAX_BODY_BYTES}B, per_bin=${MAX_PER_BIN}, ttl=${TTL_HOURS}h)`)
})
