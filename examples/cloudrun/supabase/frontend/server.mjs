// Ingress container for the stripped Supabase stack on zeropg.
//
// THREE jobs:
//
//  1. SPLIT FRONTEND. Serves a static login/shell instantly from memory — it does
//     NOT wait for the db or auth containers. The page's first action fires a
//     fire-and-forget WAKE to the db sidecar; data/auth calls are deferred until
//     /api/ready reports the backend up. This is the scale-to-zero UX pattern:
//     the user sees the app immediately while PGlite restores from GCS behind it.
//
//  2. KONG-STYLE REVERSE PROXY so a stock supabase-js client works unmodified.
//     supabase-js hardcodes `${url}/rest/v1` and `${url}/auth/v1`, so we mount:
//        /rest/v1/*  ->  db sidecar /rest/*  (PostgREST, via the sidecar's proxy)
//        /auth/v1/*  ->  GoTrue :9999/*       (path-stripped)
//     The JWT the client sends as `Authorization: Bearer` is forwarded untouched,
//     so PostgREST enforces RLS from the token's claims.
//
//  3. CONFIG + READINESS. /api/config returns the public anon key (an HS256 JWT
//     with role=anon, signed with the shared secret) + the base URL, so the
//     frontend can `createClient(origin, anonKey)`. /api/wake pokes the db sidecar;
//     /api/ready aggregates db + auth health.
//
// Env:
//   PORT                  Cloud Run ingress port (default 8080)
//   ZEROPG_DB_CONTROL     db sidecar control/REST-proxy base (default http://127.0.0.1:8081)
//   GOTRUE_URL            GoTrue base (default http://127.0.0.1:9999)
//   SUPABASE_JWT_SECRET   shared HS256 secret (also GOTRUE_JWT_SECRET / PGRST_JWT_SECRET)

import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8080)
const DB_CONTROL = process.env.ZEROPG_DB_CONTROL || 'http://127.0.0.1:8081'
const GOTRUE_URL = process.env.GOTRUE_URL || 'http://127.0.0.1:9999'
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.GOTRUE_JWT_SECRET
if (!JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET is required')

// ---- anon key: a long-lived HS256 JWT with role=anon, signed with the shared secret ----
const b64url = (s) => Buffer.from(s).toString('base64url')
function signJwt(claims) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: 'zeropg', iat: Math.floor(Date.now() / 1000), exp: 4102444800, ...claims }))
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
const ANON_KEY = signJwt({ role: 'anon' })

const indexHtml = await readFile(join(__dirname, 'index.html'), 'utf8')

// Fire-and-forget wake to the db sidecar (the HTTP request itself wakes the
// instance from zero; we just kick it without blocking).
function wakeDb() {
  fetch(`${DB_CONTROL}/wake`, { signal: AbortSignal.timeout(2000) }).catch(() => {})
}

async function readiness() {
  const out = { db: false, auth: false }
  try {
    const r = await fetch(`${DB_CONTROL}/ready`, { signal: AbortSignal.timeout(2500) })
    out.db = r.ok
  } catch {}
  try {
    const r = await fetch(`${GOTRUE_URL}/health`, { signal: AbortSignal.timeout(2500) })
    out.auth = r.ok
  } catch {}
  out.ready = out.db && out.auth
  return out
}

// Hop-by-hop / proxy-sensitive request headers we never forward to the backends.
const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer',
])
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1_000_000) // 1MB cap (single-writer DB)

// Generic reverse proxy (buffers body; demo-scale payloads).
async function proxy(req, res, targetBase, stripPrefix) {
  const url = new URL(req.url, 'http://localhost')
  const rest = url.pathname.slice(stripPrefix.length) || '/'
  const target = `${targetBase}${rest}${url.search}`
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (BLOCKED_REQ_HEADERS.has(k.toLowerCase())) continue
    headers[k] = Array.isArray(v) ? v.join(', ') : v
  }
  const method = req.method || 'GET'
  let body
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = []
    let total = 0
    for await (const c of req) {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'request body too large' }))
        return
      }
      chunks.push(c)
    }
    body = Buffer.concat(chunks)
  }
  let upstream
  try {
    upstream = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'backend waking, retry', detail: String(e) }))
    return
  }
  const respHeaders = {}
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    // fetch may transparently decompress; drop framing headers and set our own length.
    if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'content-length') return
    respHeaders[k] = v
  })
  const buf = Buffer.from(await upstream.arrayBuffer())
  respHeaders['content-length'] = String(buf.length)
  res.writeHead(upstream.status, respHeaders)
  res.end(buf)
}

function json(res, status, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    // ingress health (Cloud Run) — never blocks on backend
    if (path === '/healthz' || path === '/up') return json(res, 200, { ok: true })

    // config: anon key + base url for supabase-js. Wakes the db on first call.
    // Scheme: trust x-forwarded-proto when set (Cloud Run terminates TLS and sets
    // it to https); otherwise infer from the connection (http for local dev).
    if (path === '/api/config') {
      wakeDb()
      const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'))
      const origin = `${proto}://${req.headers.host}`
      return json(res, 200, { url: origin, anonKey: ANON_KEY })
    }
    if (path === '/api/wake') {
      wakeDb()
      return json(res, 200, { woke: true })
    }
    if (path === '/api/ready') {
      return json(res, 200, await readiness())
    }

    // Kong-style supabase layout (exact prefix: /rest/v1 or /rest/v1/...)
    const isPrefix = (p) => path === p || path.startsWith(`${p}/`)
    if (isPrefix('/rest/v1')) {
      wakeDb()
      // -> db sidecar's /rest proxy (which forwards to local PostgREST)
      return proxy(req, res, `${DB_CONTROL}/rest`, '/rest/v1')
    }
    if (isPrefix('/auth/v1')) {
      wakeDb()
      return proxy(req, res, GOTRUE_URL, '/auth/v1')
    }

    // static shell — served instantly, no backend dependency
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(indexHtml)
    }

    return json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[frontend] ingress on :${PORT} -> db=${DB_CONTROL} auth=${GOTRUE_URL}`)
})
