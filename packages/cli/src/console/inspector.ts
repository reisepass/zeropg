// `zeropg console --inspector`: the cloud trust mode of the console. One
// scale-to-zero Cloud Run service whose URL opens any fleet database in an
// editor, already logged in - read-only by construction (detached snapshots).
//
//   browser ──token link──► this ingress (:PORT, binds 0.0.0.0)   adminer sidecar
//               - bearer token gate (auth.ts, 403 without)         (:8081, auto-login
//               - GET /            landing: LIVE fleet discovery    index.php)
//               - GET /open/X      ZeroPGReplica of X's bucket          ▲
//                 prefix -> loopback wire -> 302 ─────────────────────┘
//               - ANY /db/*        reverse-proxy to adminer
//               - GET /pgweb/open/X  pgweb pinned to X's replica wire
//               - ANY /pgweb/*     reverse-proxy to that pgweb
//               - GET /livez       liveness (no token - startup probe)
//
// STRUCTURAL capability pruning, not if-guards: this module never imports the
// console's write/wake/export/serve-local/studio machinery (serve.ts,
// localdbs, probe) and never registers those routes. A wide-bound surface
// only ever serves detached snapshots - re-read the closing rule of
// docs/EDITOR-AUTH-SECURITY.md before adding anything here.
//
// Replicas are detached bucket snapshots: NO lease, NO fencing, the live
// service is untouched; edits land in the throwaway copy. Re-open to refresh.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { authBearer } from './auth.js'
import { discover } from './discovery.js'
import { launchPgweb, stopAllEditors } from './editors.js'
import { createReplicaManager, type ReplicaManager } from './replica-wire.mjs'

interface InspectorTarget {
  name: string
  bucket: string
  prefix: string
  appLabel?: string | null
  /** How this target was found: live discovery or the env fallback. */
  source: 'discovery' | 'env'
}

/** Live fleet discovery first; INSPECTOR_TARGETS env JSON only when discovery
 *  yields nothing (no ADC, no contexts, API failure). The env shape is the old
 *  targets-secret format [{ "name", "prefix", "bucket"? }] - bucket falls back
 *  to ZEROPG_BUCKET. */
async function listTargets(): Promise<{ targets: InspectorTarget[]; note: string | null }> {
  try {
    const d = await discover()
    const targets = d.instances
      .filter((i) => i.bucket && i.prefix)
      .map((i) => ({ name: i.name, bucket: i.bucket as string, prefix: i.prefix as string, appLabel: i.appLabel, source: 'discovery' as const }))
    if (targets.length > 0) {
      const note = d.errors.length ? `${d.errors.length} of ${d.contextCount} context scans failed` : null
      return { targets, note }
    }
    if (d.contextCount > 0 && d.errors.length === 0) return { targets: [], note: 'discovery ran but found no instances with a bucket/prefix' }
    return envTargets(d.errors.map((e) => `${e.context}: ${e.error}`).join('; ') || 'no fleet contexts configured')
  } catch (e) {
    return envTargets(e instanceof Error ? e.message : String(e))
  }
}

function envTargets(why: string): { targets: InspectorTarget[]; note: string | null } {
  const raw = process.env.INSPECTOR_TARGETS
  if (!raw) return { targets: [], note: `live discovery unavailable (${why}) and no INSPECTOR_TARGETS fallback set` }
  const defaultBucket = process.env.ZEROPG_BUCKET || ''
  const parsed = JSON.parse(raw) as Array<{ name: string; prefix: string; bucket?: string }>
  const targets = parsed
    .filter((t) => t.name && t.prefix && (t.bucket || defaultBucket))
    .map((t) => ({ name: t.name, bucket: t.bucket || defaultBucket, prefix: t.prefix, source: 'env' as const }))
  return { targets, note: `live discovery unavailable (${why}) - serving the INSPECTOR_TARGETS fallback list` }
}

const esc = (s: string): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

function landing(targets: InspectorTarget[], note: string | null, manager: ReplicaManager, maxOpen: number): string {
  const rows = targets
    .map((t) => {
      const o = manager.get(t.name)
      const state = o ? `open (wire :${o.port})` : 'closed'
      return `<tr><td>${esc(t.name)}${t.appLabel ? ` <span class="dim">(${esc(t.appLabel)})</span>` : ''}</td>
      <td class="dim">gs://${esc(t.bucket)}/${esc(t.prefix)}</td><td class="dim">${state}</td>
      <td><a href="/open/${encodeURIComponent(t.name)}">open in Adminer</a>
       · <a href="/pgweb/open/${encodeURIComponent(t.name)}">pgweb</a></td></tr>`
    })
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>zeropg inspector</title>
<style>body{font:14px/1.6 ui-monospace,Menlo,monospace;background:#0e1116;color:#e6edf3;max-width:900px;margin:40px auto;padding:0 16px}
a{color:#58a6ff} table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #2d333b;padding:8px 12px;text-align:left}
.dim{color:#8b949e} .note{color:#8b949e;font-size:12px;margin-top:24px} .warn{color:#d29922;font-size:12px}</style></head><body>
<h1>zeropg inspector</h1>
<p class="dim">Targets below come from <b>live fleet discovery</b>. Every one opens as a <b>detached snapshot</b> of that instance's bucket - opening one touches nothing live; edits land in a throwaway copy.</p>
${note ? `<p class="warn">${esc(note)}</p>` : ''}
<table><tr><th>instance</th><th>bucket</th><th>state</th><th></th></tr>${rows || '<tr><td colspan="4" class="dim">nothing discovered</td></tr>'}</table>
<p class="note">Snapshots materialize on open (a few seconds for small DBs). At most ${maxOpen} replicas stay open; the least recently used is closed. Re-open to refresh a snapshot to the latest committed state.</p>
</body></html>`
}

/**
 * Resolve the upstream URL for a proxied request, SAFELY.
 *
 * /db/<rest> -> adminer /<rest> (Adminer's links are query-relative, so the
 * /db/ prefix survives navigation). pgweb runs with --prefix pgweb and wants
 * the path verbatim, so stripPrefix is null there.
 *
 * SECURITY: stripping the prefix can leave a protocol-relative "//host/..."
 * (e.g. /db//169.254.169.254/...), which new URL() resolves to a DIFFERENT
 * authority - a host-controlling SSRF (GCP metadata server, arbitrary hosts,
 * SA-credential theft). Two guards: collapse leading slashes so rest is always
 * host-relative, then reject anything whose resolved origin is not the intended
 * upstream. Returns null when the request must be refused. Exported for tests.
 */
export function resolveUpstream(pathname: string, search: string, upstreamBase: string, stripPrefix: string | null): URL | null {
  let rest = stripPrefix ? pathname.replace(new RegExp(`^${stripPrefix}`), '') || '/' : pathname
  rest = rest.replace(/^\/+/, '/')
  const upstream = new URL(rest + search, upstreamBase)
  if (upstream.origin !== new URL(upstreamBase).origin) return null
  return upstream
}

function proxy(req: IncomingMessage, res: ServerResponse, url: URL, upstreamBase: string, stripPrefix: string | null): void {
  const upstream = resolveUpstream(url.pathname, url.search, upstreamBase, stripPrefix)
  if (!upstream) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request path')
    return
  }
  const headers = { ...req.headers, host: upstream.host }
  const p = httpRequest(upstream, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  p.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`upstream error: ${e.message}`)
  })
  req.pipe(p)
}

export async function runInspector(flags: Record<string, string | boolean>): Promise<void> {
  const port = Number(process.env.PORT || (typeof flags.port === 'string' ? flags.port : 8080))
  const token = process.env.INSPECTOR_TOKEN || ''
  if (!token) throw new Error('INSPECTOR_TOKEN is required - the inspector fronts every fleet database and refuses to start without its token gate')
  const adminerUrl = process.env.ADMINER_URL || 'http://127.0.0.1:8081'
  const maxOpen = Number(process.env.INSPECTOR_MAX_OPEN || 3)

  const auth = authBearer(token)
  const manager: ReplicaManager = createReplicaManager({ maxOpen, log: (m) => console.log(`[inspector] ${m}`) })

  async function targetByName(name: string): Promise<InspectorTarget> {
    const { targets } = await listTargets()
    const t = targets.find((x) => x.name === name)
    if (!t) throw new Error(`unknown target ${name}`)
    return t
  }

  // The pgweb the /pgweb/* proxy currently points at. pgweb serves exactly one
  // database per process, so "current" is the last one opened; launchPgweb is
  // idempotent per target, so re-opening an already-running target is a no-op
  // plus a proxy retarget.
  let currentPgweb: number | null = null

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (url.pathname === '/livez') {
        res.writeHead(200)
        return res.end('ok')
      }
      if (!auth.gate(req, res, url)) return
      if (url.pathname === '/') {
        const { targets, note } = await listTargets()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(landing(targets, note, manager, maxOpen))
      }
      if (url.pathname.startsWith('/open/')) {
        const name = decodeURIComponent(url.pathname.slice('/open/'.length))
        const t = await targetByName(name)
        const entry = await manager.ensure(t.name, { bucket: t.bucket, prefix: t.prefix, maxConnections: 5 })
        const q = new URLSearchParams({ pgsql: `127.0.0.1:${entry.port}`, username: 'postgres', db: 'postgres' })
        res.writeHead(302, { location: `/db/?${q}` })
        return res.end()
      }
      if (url.pathname === '/db' || url.pathname.startsWith('/db/')) return proxy(req, res, url, adminerUrl, '/db')
      if (url.pathname.startsWith('/pgweb/open/')) {
        const name = decodeURIComponent(url.pathname.slice('/pgweb/open/'.length))
        const t = await targetByName(name)
        const entry = await manager.ensure(t.name, { bucket: t.bucket, prefix: t.prefix, maxConnections: 5 })
        // One pgweb per target, mounted under /pgweb via pgweb's own --prefix;
        // idempotent relaunch returns the running one.
        const e = await launchPgweb(t.name, entry.url, { prefix: 'pgweb' })
        currentPgweb = e.port
        res.writeHead(302, { location: '/pgweb/' })
        return res.end()
      }
      if (url.pathname === '/pgweb' || url.pathname.startsWith('/pgweb/')) {
        if (!currentPgweb) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('no pgweb running - open a target first (/pgweb/open/<name>)')
        }
        return proxy(req, res, url, `http://127.0.0.1:${currentPgweb}`, null)
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    } catch (e) {
      console.error('[inspector]', e)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`inspector error: ${e instanceof Error ? e.message : e}`)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 0.0.0.0 on purpose: this mode lives behind Cloud Run ingress and the
    // bearer gate above. It serves ONLY detached snapshots - never widen the
    // local console this way.
    server.listen(port, '0.0.0.0', resolve)
  })
  console.log(`[inspector] listening on :${port} (bearer auth, live discovery, adminer at ${adminerUrl})`)

  const cleanup = async () => {
    await Promise.allSettled([manager.closeAll(), stopAllEditors()])
    process.exit(0)
  }
  process.on('SIGINT', () => void cleanup())
  process.on('SIGTERM', () => void cleanup())
}
