// zeropg fleet inspector - the console's one-click editor links, moved to the
// cloud. One scale-to-zero Cloud Run service:
//
//   browser ──► this node ingress (:PORT)                       adminer sidecar
//               - token gate (INSPECTOR_TOKEN)                   (:8081, auto-login
//               - GET  /        landing: fleet targets            index.php)
//               - GET  /open/X  materialize ZeroPGReplica of X's      ▲
//                 bucket prefix -> loopback wire -> 302 ──────────────┘
//               - ANY  /db/*    reverse-proxy to adminer
//
// Replicas are detached bucket snapshots: NO lease, NO fencing, the live
// service is untouched; edits land in the throwaway copy. Re-open to refresh.
// Trust model: the token is the door key; every request needs the zpt cookie
// (set once via ?t=<token>), and Adminer's login() checks the same token.

import { createServer, request as httpRequest } from 'node:http'
// replica-wire.mjs is the shared implementation from
// packages/cli/src/console/replica-wire.mjs, copied into this build context by
// deploy.sh. Edit the source there, never the copy here.
import { createReplicaManager } from './replica-wire.mjs'

const PORT = Number(process.env.PORT || 8080)
const TOKEN = process.env.INSPECTOR_TOKEN || ''
const BUCKET = process.env.ZEROPG_BUCKET || ''
const ADMINER = 'http://127.0.0.1:8081'
const MAX_OPEN = Number(process.env.INSPECTOR_MAX_OPEN || 3)
// [{ "name": "supabase-zeropg", "prefix": "cloudrun-supabase-v5" }, ...]
const TARGETS = JSON.parse(process.env.INSPECTOR_TARGETS || '[]')
if (!TOKEN) throw new Error('INSPECTOR_TOKEN is required - this service fronts every fleet database')
if (!BUCKET) throw new Error('ZEROPG_BUCKET is required')

const manager = createReplicaManager({ maxOpen: MAX_OPEN, log: (m) => console.log(`[inspector] ${m}`) })

async function ensureReplica(name) {
  const t = TARGETS.find((x) => x.name === name)
  if (!t) throw new Error(`unknown target ${name}`)
  return manager.ensure(name, { bucket: BUCKET, prefix: t.prefix, maxConnections: 5 })
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function landing() {
  const rows = TARGETS.map((t) => {
    const o = manager.get(t.name)
    const state = o ? `open (wire :${o.port})` : 'closed'
    return `<tr><td>${esc(t.name)}</td><td class="dim">${esc(t.prefix)}</td><td class="dim">${state}</td>
      <td><a href="/open/${encodeURIComponent(t.name)}">open in Adminer</a></td></tr>`
  }).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>zeropg inspector</title>
<style>body{font:14px/1.6 ui-monospace,Menlo,monospace;background:#0e1116;color:#e6edf3;max-width:900px;margin:40px auto;padding:0 16px}
a{color:#58a6ff} table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #2d333b;padding:8px 12px;text-align:left}
.dim{color:#8b949e} .note{color:#8b949e;font-size:12px;margin-top:24px}</style></head><body>
<h1>zeropg inspector</h1>
<p class="dim">Every target below is a <b>detached snapshot</b> of that instance's bucket - opening one touches nothing live; edits land in a throwaway copy.</p>
<table><tr><th>instance</th><th>bucket prefix</th><th>state</th><th></th></tr>${rows}</table>
<p class="note">Snapshots materialize on open (a few seconds for small DBs). At most ${MAX_OPEN} replicas stay open; the least recently used is closed. Re-open to refresh a snapshot to the latest committed state.</p>
</body></html>`
}

function proxyToAdminer(req, res, url) {
  // /db/<rest> -> adminer /<rest>; Adminer's links are query-relative so the
  // /db/ prefix survives navigation.
  const rest = url.pathname.replace(/^\/db/, '') || '/'
  const upstream = new URL(rest + url.search, ADMINER)
  const headers = { ...req.headers, host: '127.0.0.1:8081' }
  const p = httpRequest(upstream, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  p.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`adminer upstream error: ${e.message}`)
  })
  req.pipe(p)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (url.pathname === '/livez') {
      res.writeHead(200)
      return res.end('ok')
    }
    // token gate: accept ?t= once, then ride the cookie (shared with Adminer)
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p.length === 2))
    const presented = url.searchParams.get('t') || cookies.zpt || ''
    if (presented !== TOKEN) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      return res.end('missing or wrong token - open the link your fleet console gave you (…?t=<token>)')
    }
    if (url.searchParams.get('t')) {
      // normalize: set the cookie, drop the token from the URL
      url.searchParams.delete('t')
      res.writeHead(302, {
        'set-cookie': `zpt=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        location: url.pathname + (url.searchParams.size ? '?' + url.searchParams : ''),
      })
      return res.end()
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(landing())
    }
    if (url.pathname.startsWith('/open/')) {
      const name = decodeURIComponent(url.pathname.slice('/open/'.length))
      const entry = await ensureReplica(name)
      const q = new URLSearchParams({ pgsql: `127.0.0.1:${entry.port}`, username: 'postgres', db: 'postgres' })
      res.writeHead(302, { location: `/db/?${q}` })
      return res.end()
    }
    if (url.pathname === '/db' || url.pathname.startsWith('/db/')) return proxyToAdminer(req, res, url)
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  } catch (e) {
    console.error('[inspector]', e)
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`inspector error: ${e instanceof Error ? e.message : e}`)
  }
})

server.listen(PORT, () => console.log(`[inspector] listening on :${PORT}, ${TARGETS.length} targets, bucket ${BUCKET}`))

process.on('SIGTERM', async () => {
  await manager.closeAll()
  process.exit(0)
})
