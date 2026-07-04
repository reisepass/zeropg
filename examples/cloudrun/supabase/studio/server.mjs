// zeropg Console BFF.
//
// A lightweight Supabase-Studio-style admin console for zeropg (scale-to-zero
// PGlite behind pglite-socket, ONE shared wire session). Plain node:http, no
// framework. It:
//   - serves a fast vanilla-JS SPA (instant shell + lazy-loaded route chunks)
//   - guards everything behind a single admin login (bcrypt password, HMAC
//     session cookie, session-bound CSRF, login rate limiting)
//   - exposes a STRICT route allowlist to postgres-meta (no generic proxy)
//   - runs the SQL editor with the single-session safety rules baked in
//     (reject transaction control, reset session GUCs after every submission,
//     client-side-only timeout labelled as "stopped waiting", never "cancelled")
//   - browses tables READ-ONLY with validated identifiers + bind-param values
//   - keeps its own history/saved-query + log tables in the studio schema
//
// See README.md for env vars and docs/STUDIO-PGMETA-COMPAT.md for why the SQL
// editor is shaped the way it is.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'

import { createAuth, hashPassword } from './lib/auth.mjs'
import { createMeta } from './lib/meta.mjs'
import { createLogger } from './lib/logs.mjs'
import { applyBootstrap } from './lib/bootstrap.mjs'
import { rejectSharedSessionHazards, TXN_REJECT_MESSAGE, COPY_REJECT_MESSAGE, quoteIdent } from './lib/sqlsafe.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')

// ---------------------------------------------------------------- config ----
const PORT = Number(process.env.STUDIO_PORT || 4321)
const META_URL = process.env.PG_META_URL || 'http://127.0.0.1:4322'
const BASE = '/studio' // everything is mounted here

const SESSION_SECRET = process.env.STUDIO_SESSION_SECRET
const QUERY_TIMEOUT_SECS = Number(process.env.STUDIO_QUERY_TIMEOUT_SECS || 25)
const MAX_BODY_BYTES = Number(process.env.STUDIO_MAX_BODY_BYTES || 1_000_000)
const PAGE_SIZE = 50

// Connection info surfaced by the connection modal. Public values are shown
// outright; privileged ones are redacted until an explicit reveal.
const CONN = {
  rest: process.env.STUDIO_REST_URL || '',
  auth: process.env.STUDIO_AUTH_URL || '',
  anonKey: process.env.STUDIO_ANON_KEY || '',
  secrets: {
    serviceKey: { label: 'service_role key', value: process.env.STUDIO_SERVICE_KEY || '' },
    jwtSecret: { label: 'JWT secret', value: process.env.STUDIO_JWT_SECRET || '' },
    dbUrl: { label: 'database connection string', value: process.env.STUDIO_DB_URL || '' },
  },
}

if (!SESSION_SECRET) throw new Error('STUDIO_SESSION_SECRET is required')

// admin password hash: precomputed hash wins, else hash the plaintext at boot
let ADMIN_HASH = process.env.STUDIO_ADMIN_PASSWORD_HASH || null
if (!ADMIN_HASH) {
  if (!process.env.STUDIO_ADMIN_PASSWORD) throw new Error('set STUDIO_ADMIN_PASSWORD or STUDIO_ADMIN_PASSWORD_HASH')
  ADMIN_HASH = await hashPassword(process.env.STUDIO_ADMIN_PASSWORD)
}

const auth = createAuth({ sessionSecret: SESSION_SECRET, adminPasswordHash: ADMIN_HASH })
const meta = createMeta({ baseUrl: META_URL, requestTimeoutMs: (QUERY_TIMEOUT_SECS + 5) * 1000 })
const logger = createLogger(meta)
const STARTED_AT = Date.now()

// -------------------------------------------------------------- helpers -----
function isSecure(req) {
  const xf = req.headers['x-forwarded-proto']
  if (xf) return String(xf).split(',')[0].trim() === 'https'
  return Boolean(req.socket.encrypted)
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (xf) return String(xf).split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
}
function withSecurity(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers }
}
// Clamp a query-param to a finite integer in [min,max] (guards LIMIT/OFFSET
// against Infinity/NaN/fractional values producing invalid SQL).
function boundedInt(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(Math.max(Math.trunc(n), min), max)
}
function json(res, status, obj, extraHeaders = {}) {
  const s = JSON.stringify(obj)
  res.writeHead(status, withSecurity({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...extraHeaders }))
  res.end(s)
}
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > MAX_BODY_BYTES) { const e = new Error('body too large'); e.tooLarge = true; throw e }
    chunks.push(c)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { const e = new Error('invalid JSON'); e.badJson = true; throw e }
}

// ----------------------------------------------------------- static SPA -----
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
let INDEX_HTML = ''
async function loadIndex() { INDEX_HTML = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8') }

async function serveStatic(res, relPath) {
  // relPath is already stripped of the /studio prefix; prevent traversal
  const safe = normalize(relPath).replace(/^(\.\.[/\\])+/, '')
  const full = join(PUBLIC_DIR, safe)
  if (!full.startsWith(PUBLIC_DIR)) { json(res, 403, { error: 'forbidden' }); return }
  try {
    const st = await stat(full)
    if (!st.isFile()) throw new Error('not a file')
    const ext = full.slice(full.lastIndexOf('.'))
    const buf = await readFile(full)
    res.writeHead(200, withSecurity({ 'content-type': STATIC_TYPES[ext] || 'application/octet-stream', 'content-length': buf.length }))
    res.end(buf)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}
function serveShell(res) {
  res.writeHead(200, withSecurity({ 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(INDEX_HTML) }))
  res.end(INDEX_HTML)
}

// --------------------------------------------------------- introspection ----
// Cache the introspected table set briefly to validate table-browser reads.
let tableCache = { at: 0, byKey: new Map(), list: [] }
const INTERNAL_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast', 'studio', 'auth', 'storage', 'graphql', 'graphql_public', 'realtime', 'extensions', 'vault', '_analytics', 'net', 'pgsodium'])
function isInternalSchema(name) { return INTERNAL_SCHEMAS.has(name) || name.startsWith('pg_') }

async function introspect(force = false) {
  if (!force && Date.now() - tableCache.at < 3000) return tableCache
  const tables = await meta.tables()
  const byKey = new Map()
  const list = []
  for (const t of tables) {
    const cols = (t.columns || []).map((c) => ({ name: c.name, type: c.format || c.data_type, dataType: c.data_type }))
    const key = `${t.schema}.${t.name}`
    byKey.set(key, { schema: t.schema, name: t.name, columns: cols, primaryKeys: (t.primary_keys || []).map((p) => p.name) })
    list.push({ schema: t.schema, name: t.name, internal: isInternalSchema(t.schema), columns: cols })
  }
  tableCache = { at: Date.now(), byKey, list }
  return tableCache
}

// ------------------------------------------------------------ API routes ----
const FILTER_OPS = { eq: '=', neq: '<>', like: 'LIKE', ilike: 'ILIKE', 'is-null': 'IS NULL' }

async function handleRows(req, res, url) {
  const schema = url.searchParams.get('schema') || ''
  const table = url.searchParams.get('table') || ''
  const cache = await introspect()
  const entry = cache.byKey.get(`${schema}.${table}`)
  if (!entry) return json(res, 404, { error: `unknown table ${schema}.${table}` })

  const colNames = new Set(entry.columns.map((c) => c.name))
  const limit = boundedInt(url.searchParams.get('limit'), PAGE_SIZE, 1, PAGE_SIZE)
  const offset = boundedInt(url.searchParams.get('offset'), 0, 0, 1_000_000_000)

  // sort
  let orderSql = ''
  const sortCol = url.searchParams.get('sort')
  const dir = (url.searchParams.get('dir') || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
  if (sortCol) {
    if (!colNames.has(sortCol)) return json(res, 400, { error: `unknown sort column ${sortCol}` })
    orderSql = ` ORDER BY ${quoteIdent(sortCol)} ${dir}`
  }

  // filter
  let whereSql = ''
  const params = []
  const fCol = url.searchParams.get('filterCol')
  const fOp = url.searchParams.get('filterOp')
  if (fCol && fOp) {
    if (!colNames.has(fCol)) return json(res, 400, { error: `unknown filter column ${fCol}` })
    if (!(fOp in FILTER_OPS)) return json(res, 400, { error: `unknown filter operator ${fOp}` })
    if (fOp === 'is-null') {
      whereSql = ` WHERE ${quoteIdent(fCol)} IS NULL`
    } else {
      const fVal = url.searchParams.get('filterVal')
      params.push(fVal == null ? '' : fVal)
      whereSql = ` WHERE ${quoteIdent(fCol)} ${FILTER_OPS[fOp]} $1`
    }
  }

  const relation = `${quoteIdent(schema)}.${quoteIdent(table)}`
  const selectList = entry.columns.map((c) => quoteIdent(c.name)).join(', ')
  try {
    const countRes = await meta.query(`SELECT count(*)::bigint AS n FROM ${relation}${whereSql}`, params.length ? params : undefined)
    const total = Number(countRes.rows[0]?.n || 0)
    const rowsRes = await meta.query(`SELECT ${selectList} FROM ${relation}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`, params.length ? params : undefined)
    return json(res, 200, {
      columns: entry.columns,
      primaryKeys: entry.primaryKeys,
      rows: rowsRes.rows,
      total,
      limit,
      offset,
    })
  } catch (e) {
    return json(res, 400, { error: e.message, code: e.code || null })
  }
}

async function handleQuery(req, res) {
  let body
  try { body = await readJsonBody(req) } catch (e) { return json(res, e.tooLarge ? 413 : 400, { error: e.message }) }
  const sql = typeof body.sql === 'string' ? body.sql : ''
  if (!sql.trim()) return json(res, 400, { error: 'empty query' })

  const guard = rejectSharedSessionHazards(sql)
  if (!guard.ok) {
    const isCopy = guard.kind === 'copy'
    await logger.warn('sql', `rejected ${isCopy ? 'COPY FROM STDIN' : 'transaction-control'} statement`, { statement: guard.statement })
    return json(res, 400, {
      error: isCopy ? COPY_REJECT_MESSAGE : TXN_REJECT_MESSAGE,
      code: isCopy ? 'STUDIO_COPY_BLOCKED' : 'STUDIO_TXN_BLOCKED',
      rejected: guard.statement,
    })
  }

  const t0 = Date.now()
  let result = null
  let errObj = null
  try {
    const r = await meta.query(sql)
    result = { rows: r.rows, columns: r.rows.length ? Object.keys(r.rows[0]) : [] }
  } catch (e) {
    if (e.timeout) {
      errObj = {
        error: 'The client stopped waiting after the timeout. The query may still be running and could still commit on the shared PGlite session - it was NOT cancelled. Avoid blindly retrying a write.',
        code: 'STUDIO_TIMEOUT',
        timeout: true,
      }
    } else if (e.upstreamDown) {
      errObj = { error: e.message, code: 'STUDIO_UPSTREAM_DOWN' }
    } else {
      errObj = { error: e.message, code: e.code || null, formattedError: e.formattedError || null }
    }
  } finally {
    // Always restore the shared session baseline, even on error.
    await meta.resetSession()
  }
  const duration = Date.now() - t0

  // persist to history (best-effort; never fail the request on a logging miss)
  try {
    await meta.query(
      'INSERT INTO studio.queries (kind, sql, duration_ms, success, error) VALUES ($1,$2,$3,$4,$5)',
      ['history', sql, duration, !errObj, errObj ? errObj.error : null],
    )
  } catch { /* ignore */ }
  await logger.info('sql', errObj ? 'query failed' : 'query ok', { duration_ms: duration, success: !errObj, code: errObj?.code || null })

  if (errObj) return json(res, 400, { ...errObj, duration })
  return json(res, 200, { ...result, duration })
}

async function handleStatus(res) {
  const out = { awake: false, version: null, dbSize: null, dbSizePretty: null, uptimeSecs: Math.floor((Date.now() - STARTED_AT) / 1000) }
  try {
    const r = await meta.query("SELECT version() AS version, pg_database_size(current_database())::bigint AS size, pg_size_pretty(pg_database_size(current_database())) AS pretty")
    out.awake = true
    out.version = r.rows[0]?.version || null
    out.dbSize = Number(r.rows[0]?.size || 0)
    out.dbSizePretty = r.rows[0]?.pretty || null
  } catch (e) {
    out.error = e.timeout ? 'backend not responding yet' : e.message
  }
  json(res, 200, out)
}

// --------------------------------------------------------------- router -----
const server = createServer(async (req, res) => {
  const method = req.method || 'GET'
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { return json(res, 400, { error: 'bad url' }) }
  const path = url.pathname

  try {
    // ingress health (never blocks on backend, no auth)
    if (path === '/healthz' || path === '/up') return json(res, 200, { ok: true })
    // root -> studio
    if (path === '/' || path === '') { res.writeHead(302, withSecurity({ location: `${BASE}/` })); return res.end() }

    if (path !== BASE && !path.startsWith(`${BASE}/`)) return json(res, 404, { error: 'not found' })
    const sub = path.slice(BASE.length) || '/' // e.g. '/', '/sql', '/api/query'

    // ---- public API: session probe + login ----
    if (sub === '/api/session') {
      const token = auth.readCookie(req)
      const session = token ? auth.verifySession(token) : null
      if (!session) return json(res, 200, { authenticated: false })
      return json(res, 200, { authenticated: true, csrfToken: auth.csrfFor(token), sub: session.sub })
    }
    if (sub === '/api/login' && method === 'POST') {
      const ip = clientIp(req)
      const rl = auth.isRateLimited(ip)
      if (rl.limited) {
        await logger.warn('auth', 'login rate-limited', { ip })
        return json(res, 429, { error: 'too many login attempts, slow down', retryAfterSecs: rl.retryAfterSecs }, { 'retry-after': String(rl.retryAfterSecs) })
      }
      let body
      try { body = await readJsonBody(req) } catch (e) { return json(res, 400, { error: e.message }) }
      const okPw = await auth.verifyPassword(body.password)
      if (!okPw) {
        auth.recordFail(ip)
        await logger.warn('auth', 'login failed', { ip })
        return json(res, 401, { error: 'invalid password' })
      }
      auth.recordSuccess(ip)
      const token = auth.issueSession('admin')
      await logger.info('auth', 'login ok', { ip })
      return json(res, 200, { ok: true, csrfToken: auth.csrfFor(token) }, { 'set-cookie': auth.cookieHeader(token, { secure: isSecure(req) }) })
    }

    // ---- everything else under /studio/api requires a valid session ----
    const isApi = sub === '/api' || sub.startsWith('/api/')
    if (isApi) {
      const token = auth.readCookie(req)
      const session = token ? auth.verifySession(token) : null
      if (!session) return json(res, 401, { error: 'authentication required' })

      // CSRF for mutating methods
      const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
      if (mutating) {
        const provided = req.headers['x-csrf-token']
        if (!auth.csrfValid(token, Array.isArray(provided) ? provided[0] : provided)) {
          await logger.warn('auth', 'csrf rejected', { path: sub, method })
          return json(res, 403, { error: 'invalid or missing CSRF token' })
        }
      }

      // ---- authed API allowlist ----
      if (sub === '/api/logout' && method === 'POST') {
        await logger.info('auth', 'logout', {})
        return json(res, 200, { ok: true }, { 'set-cookie': auth.clearCookieHeader({ secure: isSecure(req) }) })
      }
      if (sub === '/api/status' && method === 'GET') return handleStatus(res)
      if (sub === '/api/connection' && method === 'GET') {
        return json(res, 200, {
          rest: CONN.rest,
          auth: CONN.auth,
          anonKey: CONN.anonKey,
          secrets: Object.entries(CONN.secrets).map(([key, v]) => ({ key, label: v.label, present: Boolean(v.value) })),
        })
      }
      // POST (not GET) so revealing a privileged secret requires the CSRF token.
      if (sub === '/api/connection/reveal' && method === 'POST') {
        const item = url.searchParams.get('item')
        const secret = CONN.secrets[item]
        if (!secret) return json(res, 404, { error: 'unknown secret' })
        await logger.warn('auth', 'secret revealed', { item })
        return json(res, 200, { key: item, label: secret.label, value: secret.value })
      }
      if (sub === '/api/meta/tables' && method === 'GET') {
        const cache = await introspect(url.searchParams.get('refresh') === '1')
        return json(res, 200, { tables: cache.list })
      }
      if (sub === '/api/rows' && method === 'GET') return handleRows(req, res, url)
      if (sub === '/api/query' && method === 'POST') return handleQuery(req, res)
      if (sub === '/api/history' && method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
        const r = await meta.query(`SELECT id, sql, executed_at, duration_ms, success, error FROM studio.queries WHERE kind='history' ORDER BY executed_at DESC, id DESC LIMIT ${limit}`)
        return json(res, 200, { history: r.rows })
      }
      if (sub === '/api/saved' && method === 'GET') {
        const r = await meta.query(`SELECT id, name, sql, executed_at FROM studio.queries WHERE kind='saved' ORDER BY name ASC, id DESC`)
        return json(res, 200, { saved: r.rows })
      }
      if (sub === '/api/saved' && method === 'POST') {
        let body
        try { body = await readJsonBody(req) } catch (e) { return json(res, 400, { error: e.message }) }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const sql = typeof body.sql === 'string' ? body.sql : ''
        if (!name || !sql.trim()) return json(res, 400, { error: 'name and sql are required' })
        const r = await meta.query('INSERT INTO studio.queries (kind, name, sql) VALUES ($1,$2,$3) RETURNING id, name, sql, executed_at', ['saved', name, sql])
        return json(res, 200, { saved: r.rows[0] })
      }
      if (sub === '/api/saved' && method === 'DELETE') {
        const id = Number(url.searchParams.get('id'))
        if (!Number.isInteger(id)) return json(res, 400, { error: 'id required' })
        await meta.query('DELETE FROM studio.queries WHERE kind=$1 AND id=$2', ['saved', id])
        return json(res, 200, { ok: true })
      }
      if (sub === '/api/logs' && method === 'GET') {
        const source = url.searchParams.get('source')
        const level = url.searchParams.get('level')
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
        const clauses = []
        const params = []
        if (source) { params.push(source); clauses.push(`source = $${params.length}`) }
        if (level) { params.push(level); clauses.push(`level = $${params.length}`) }
        const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
        const r = await meta.query(`SELECT id, ts, source, level, message, meta FROM studio.logs${where} ORDER BY ts DESC, id DESC LIMIT ${limit}`, params.length ? params : undefined)
        return json(res, 200, { logs: r.rows })
      }
      return json(res, 404, { error: 'unknown api route' })
    }

    // ---- static assets ----
    if (sub.startsWith('/assets/') || sub.startsWith('/views/') || sub === '/app.js' || sub === '/styles.css' || sub === '/favicon.ico' || sub === '/favicon.svg') {
      return serveStatic(res, sub)
    }

    // ---- SPA shell for every view route (deep links render directly) ----
    // /studio, /studio/, /studio/sql, /studio/editor, /studio/logs, /studio/settings, /studio/login
    if (method === 'GET') return serveShell(res)
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    try { await logger.error('bff', 'unhandled', { message: String(e && e.message || e) }) } catch {}
    return json(res, 500, { error: 'internal error' })
  }
})

// ------------------------------------------------------------- startup ------
await loadIndex()
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[studio] BFF on :${PORT} -> postgres-meta=${META_URL}`)
  // apply the studio schema in the background (backend may be waking)
  applyBootstrap(meta, { log: (m) => console.log(m) })
    .then(() => logger.info('bff', 'studio bootstrap ready', {}))
    .catch((e) => console.error('[studio] bootstrap failed:', e.message))
})
