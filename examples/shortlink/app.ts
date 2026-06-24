// The URL-shortener app. Pure HTTP + the unified Client; knows nothing about which
// engine is underneath. The HTML UI uses plain <form> POSTs + redirects (works with
// JS disabled, and is trivially driveable end-to-end), and there is a JSON REST API
// alongside it that the engine-parity test hammers.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Client, Queryable } from '@zeropg/client'

export interface Link {
  id: number
  code: string
  url: string
  clicks: number
  created_at: string
  last_clicked_at: string | null
}

// Unambiguous base-32 alphabet (no 0/O/1/I/l) for the auto-generated codes.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_LEN = 6
const RESERVED = new Set(['api', 'links', 'link', 'healthz', 'favicon.ico'])

export function createApp(db: Client): Server {
  return createServer((req, res) => {
    handle(db, req, res).catch((e) => {
      send(res, 500, 'application/json', JSON.stringify({ error: String(e?.message ?? e) }))
    })
  })
}

async function handle(db: Client, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  // ---- health ----
  if (method === 'GET' && path === '/healthz') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, engine: db.engine }))
  }

  // ---- JSON API ----
  if (path === '/api/links' && method === 'GET') {
    return send(res, 200, 'application/json', JSON.stringify(await listLinks(db)))
  }
  if (path === '/api/links' && method === 'POST') {
    const body = await readJson(req)
    const result = await createLink(db, String(body.url ?? ''), body.code === undefined ? undefined : String(body.code))
    if (result.error) return send(res, result.status, 'application/json', JSON.stringify({ error: result.error }))
    return send(res, 201, 'application/json', JSON.stringify(result.link))
  }
  const apiCode = matchCode(path, /^\/api\/links\/([^/]+)$/)
  if (apiCode !== null && method === 'GET') {
    const link = await getLink(db, apiCode)
    return link
      ? send(res, 200, 'application/json', JSON.stringify(link))
      : send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }))
  }

  // ---- HTML form actions (no-JS friendly: POST then redirect) ----
  if (path === '/links' && method === 'POST') {
    const f = await readForm(req)
    const result = await createLink(db, f.get('url') ?? '', undefined)
    // On success land on the link's detail page so the user sees their short code.
    return redirect(res, result.link ? `/link/${result.link.code}` : '/?error=1')
  }

  // ---- HTML pages (each view its own GET URL) ----
  if (path === '/' && method === 'GET') {
    const failed = url.searchParams.get('error') === '1'
    return send(res, 200, 'text/html; charset=utf-8', renderHome(db.engine, failed))
  }
  if (path === '/links' && method === 'GET') {
    return send(res, 200, 'text/html; charset=utf-8', renderList(db.engine, await listLinks(db)))
  }
  const pageCode = matchCode(path, /^\/link\/([^/]+)$/)
  if (pageCode !== null && method === 'GET') {
    const link = await getLink(db, pageCode)
    return link
      ? send(res, 200, 'text/html; charset=utf-8', renderDetail(req, link))
      : send(res, 404, 'text/html; charset=utf-8', page('not found', '<h1>404 — no such link</h1><a href=/>home</a>'))
  }

  // ---- the redirect: GET /:code -> 302 to the target, bumping the click count ----
  const code = matchCode(path, /^\/([^/]+)$/)
  if (code !== null && method === 'GET' && !RESERVED.has(code)) {
    const target = await follow(db, code)
    if (target) {
      res.writeHead(302, { location: target })
      return res.end()
    }
    return send(res, 404, 'text/html; charset=utf-8', page('not found', '<h1>404 — no such link</h1><a href=/>home</a>'))
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'not found', path }))
}

// ---- data access (engine-agnostic SQL via the unified Client) ----

async function listLinks(db: Client): Promise<Link[]> {
  return (await db.query<Link>('SELECT * FROM links ORDER BY created_at DESC, id DESC')).rows
}

async function getLink(db: Client, code: string): Promise<Link | null> {
  return (await db.query<Link>('SELECT * FROM links WHERE code = $1', [code])).rows[0] ?? null
}

interface CreateResult {
  link?: Link
  error?: string
  status: number
}

/** Validate + normalize the target URL, then insert with either the caller-supplied
 * code (API only, used for deterministic tests) or a freshly generated unique one. */
async function createLink(db: Client, rawUrl: string, wantCode?: string): Promise<CreateResult> {
  const target = normalizeUrl(rawUrl)
  if (!target) return { error: 'a valid http(s) url is required', status: 400 }

  if (wantCode !== undefined) {
    const code = wantCode.trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || RESERVED.has(code)) {
      return { error: 'invalid code', status: 400 }
    }
    const existing = await getLink(db, code)
    if (existing) return { error: 'code already in use', status: 409 }
    const { rows } = await db.query<Link>(
      'INSERT INTO links (code, url) VALUES ($1, $2) RETURNING *',
      [code, target],
    )
    return { link: rows[0], status: 201 }
  }

  // Generate a unique code, retrying on the (rare) collision. The UNIQUE index is
  // the real guard; this loop just avoids surfacing a constraint error to the user.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode()
    if (await getLink(db, code)) continue
    try {
      const { rows } = await db.query<Link>(
        'INSERT INTO links (code, url) VALUES ($1, $2) RETURNING *',
        [code, target],
      )
      return { link: rows[0], status: 201 }
    } catch {
      // lost the race on the UNIQUE index — try another code
    }
  }
  return { error: 'could not allocate a unique code', status: 500 }
}

/** Resolve a code to its target URL and bump the click counter in ONE transaction,
 * so a redirect can never be served without the click being durably recorded (and
 * vice versa). Returns the target, or null if the code is unknown. */
async function follow(db: Client, code: string): Promise<string | null> {
  return db.transaction(async (tx: Queryable) => {
    const cur = (await tx.query<Link>('SELECT * FROM links WHERE code = $1', [code])).rows[0]
    if (!cur) return null
    await tx.query(
      'UPDATE links SET clicks = clicks + 1, last_clicked_at = now() WHERE code = $1',
      [code],
    )
    return cur.url
  })
}

function generateCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return s
}

/** Accept bare hostnames too (prepend https://); reject anything that isn't a
 * syntactically valid http/https URL. Returns the canonical href, or null. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let u: URL
  try {
    u = new URL(candidate)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // Require a real-looking host: a dotted name, "localhost", or a bare IP. This
  // rejects junk like "not a url" while still accepting dev/loopback targets.
  if (!u.hostname) return null
  const looksLikeHost = u.hostname.includes('.') || u.hostname === 'localhost' || /^\[?[0-9a-f:]+\]?$/i.test(u.hostname)
  if (!looksLikeHost) return null
  return u.href
}

// ---- HTTP helpers ----

function matchCode(path: string, re: RegExp): string | null {
  const m = re.exec(path)
  return m ? decodeURIComponent(m[1]) : null
}
function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location })
  res.end()
}
async function readBody(req: IncomingMessage): Promise<string> {
  let b = ''
  for await (const c of req) b += c
  return b
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req))
}

// ---- views ----

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
 h1{margin-bottom:.2rem} .sub{color:#666;margin-top:0}
 nav{margin-bottom:1rem} nav a{margin-right:1rem}
 a{color:#1a56c1}
 code{background:#f3f4f6;padding:.1rem .35rem;border-radius:4px}
 .link{display:flex;align-items:center;gap:.6rem;padding:.5rem .7rem;border:1px solid #e2e2e2;border-radius:8px;margin:.4rem 0}
 .link .code{font-weight:600} .link .target{flex:1;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .clicks{font-size:.8rem;padding:.1rem .5rem;border-radius:999px;background:#e8f0fe;color:#1a56c1}
 .add{display:flex;gap:.4rem;margin:1rem 0;flex-wrap:wrap}
 input{font:inherit;padding:.4rem;border:1px solid #ccc;border-radius:6px}
 button{cursor:pointer;font:inherit;padding:.4rem .8rem;border:1px solid #ccc;border-radius:6px;background:#fff}
 .err{color:#b3261e}
 .short{font-size:1.1rem}
</style></head><body>${body}</body></html>`
}

function nav(): string {
  return `<nav><a href="/">Shorten</a><a href="/links" data-testid=nav-links>All links</a></nav>`
}

function renderHome(engine: string, failed: boolean): string {
  return page(
    'Shortlink — zeropg',
    `${nav()}
     <h1>Shortlink</h1>
     <p class=sub>One app, one codebase. Engine: <b data-testid=engine>${esc(engine)}</b> — set <code>DATABASE_URL</code> to move from laptop to bucket to RDS with zero code change.</p>
     ${failed ? '<p class="err" data-testid=error>That doesn&#39;t look like a valid http(s) URL.</p>' : ''}
     <form class=add method=post action="/links">
       <input name=url type=text placeholder="https://example.com/a/very/long/path" data-testid=new-url required style="flex:1;min-width:14rem">
       <button data-testid=shorten>Shorten</button>
     </form>
     <p class=sub>Paste a long URL, get a short code. Visiting <code>/&lt;code&gt;</code> redirects and counts the click.</p>`,
  )
}

function linkRow(l: Link): string {
  return `<div class="link" data-testid="link-${esc(l.code)}">
   <span class=code><a href="/link/${esc(l.code)}" data-testid="detail-${esc(l.code)}">/${esc(l.code)}</a></span>
   <span class=target>${esc(l.url)}</span>
   <span class=clicks data-testid="clicks-${esc(l.code)}">${esc(l.clicks)} clicks</span>
  </div>`
}

function renderList(engine: string, links: Link[]): string {
  const body = links.length ? links.map(linkRow).join('') : '<p class=sub data-testid=empty>No links yet.</p>'
  return page(
    'All links — zeropg',
    `${nav()}
     <h1>All links</h1>
     <p class=sub>Engine: <b data-testid=engine>${esc(engine)}</b> · ${links.length} link${links.length === 1 ? '' : 's'}</p>
     <div data-testid=link-list>${body}</div>`,
  )
}

function renderDetail(req: IncomingMessage, l: Link): string {
  const host = req.headers.host ?? 'localhost'
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http'
  const shortUrl = `${proto}://${host}/${l.code}`
  return page(
    `/${l.code} — zeropg`,
    `${nav()}
     <h1>Short link <code data-testid=code>${esc(l.code)}</code></h1>
     <p class="short">→ <a href="/${esc(l.code)}" data-testid=short-url>${esc(shortUrl)}</a></p>
     <p class=sub>targets <a href="${esc(l.url)}" data-testid=target rel=nofollow>${esc(l.url)}</a></p>
     <p>Clicks: <b data-testid=clicks>${esc(l.clicks)}</b>${l.last_clicked_at ? ` · last ${esc(l.last_clicked_at)}` : ''}</p>
     <p class=sub>created ${esc(l.created_at)}</p>
     <p><a href="/links">← all links</a></p>`,
  )
}
