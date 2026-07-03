// `zeropg console`: a local web view over the same live fleet discovery the
// CLI uses. Binds 127.0.0.1 ONLY, on purpose: zeropg instances have no
// built-in auth, so a network-exposed console would be an open door to every
// database it can see. It is a viewer for the human; agents use the CLI.
// Data viewing / SQL UI is intentionally out of scope here.

import { createServer } from 'node:http'
import { loadConfig } from '../fleet/contexts.js'
import { listInstances } from '../fleet/gcloud.js'
import { probeStatus, wakeAndWait } from '../fleet/probe.js'
import type { Instance } from '../fleet/types.js'

async function discover(): Promise<{ instances: Instance[]; errors: Array<{ context: string; error: string }> }> {
  const cfg = loadConfig()
  const instances: Instance[] = []
  const errors: Array<{ context: string; error: string }> = []
  const results = await Promise.allSettled(cfg.contexts.map((c) => listInstances(c)))
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') instances.push(...r.value)
    else errors.push({ context: cfg.contexts[i].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })
  return { instances, errors }
}

async function findByName(service: string, context: string | null): Promise<Instance | null> {
  const { instances } = await discover()
  return instances.find((i) => i.name === service && (!context || i.context === context)) ?? null
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zeropg console</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#2d333b; --fg:#e6edf3; --dim:#8b949e; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--bg); color:var(--fg); }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; }
  header h1 { font-size:16px; margin:0; }
  header .sub { color:var(--dim); font-size:12px; }
  main { padding:24px; max-width:1200px; margin:0 auto; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin-bottom:16px; padding:16px 20px; }
  .card h2 { margin:0 0 4px; font-size:15px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .meta { color:var(--dim); font-size:12px; }
  dl { display:grid; grid-template-columns:110px 1fr; gap:4px 12px; margin:12px 0 0; }
  dt { color:var(--dim); }
  dd { margin:0; word-break:break-all; }
  .pill { font-size:11px; padding:1px 8px; border-radius:10px; border:1px solid var(--line); color:var(--dim); }
  .pill.ready { color:var(--ok); border-color:var(--ok); }
  .pill.booting { color:var(--warn); border-color:var(--warn); }
  .pill.bad { color:var(--bad); border-color:var(--bad); }
  .pill.public { color:var(--bad); border-color:var(--bad); }
  button { font:inherit; font-size:12px; background:transparent; color:var(--accent); border:1px solid var(--accent); border-radius:6px; padding:3px 12px; cursor:pointer; }
  button:hover { background:rgba(88,166,255,.1); }
  button:disabled { opacity:.5; cursor:wait; }
  .actions { margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .copy { color:var(--dim); border-color:var(--line); }
  code.cmd { display:block; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px; margin-top:8px; word-break:break-all; color:var(--dim); }
  .err { color:var(--bad); }
  #empty { color:var(--dim); }
</style>
</head>
<body>
<header><h1>zeropg console</h1><span class="sub">live discovery, no registry. Local viewer only (127.0.0.1). Probing or waking a sleeping instance starts it.</span></header>
<main>
  <div id="empty">scanning contexts...</div>
  <div id="list"></div>
</main>
<script>
const el = (t, attrs = {}, kids = []) => {
  const n = document.createElement(t)
  for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else n.setAttribute(k, v) }
  for (const k of kids) n.appendChild(k)
  return n
}
async function load() {
  const r = await fetch('/api/fleet'); const data = await r.json()
  const list = document.getElementById('list'); list.textContent = ''
  const empty = document.getElementById('empty')
  empty.textContent = data.instances.length ? '' : 'no zeropg instances discovered in any context'
  for (const e of data.errors) list.appendChild(el('div', { class: 'card err', text: 'context ' + e.context + ': ' + e.error }))
  for (const inst of data.instances) list.appendChild(card(inst))
}
function card(inst) {
  const id = inst.context + '/' + inst.name
  const bucket = inst.bucket && inst.prefix ? 'gs://' + inst.bucket + '/' + inst.prefix : '(unknown)'
  const statusPill = el('span', { class: 'pill', text: 'not probed' })
  const dl = el('dl', {}, [
    el('dt', { text: 'url' }), el('dd', { text: inst.url || '(none)' }),
    el('dt', { text: 'bucket' }), el('dd', { text: bucket }),
    el('dt', { text: 'sql' }), el('dd', { text: inst.url ? 'POST ' + inst.url + '/sql' : '(none)' }),
    el('dt', { text: 'rest' }), el('dd', { text: inst.url ? inst.url + '/rest/<table>' : '(none)' }),
    el('dt', { text: 'image' }), el('dd', { text: inst.image || '?' }),
    el('dt', { text: 'deployed' }), el('dd', { text: inst.updateTime || '?' }),
  ])
  const extra = el('div')
  const btn = (label, fn) => { const b = el('button', { text: label }); b.onclick = () => fn(b); return b }
  const statusBtn = btn('probe status (wakes it)', async (b) => {
    b.disabled = true
    const q = '?service=' + encodeURIComponent(inst.name) + '&context=' + encodeURIComponent(inst.context)
    const st = await (await fetch('/api/status' + q)).json()
    statusPill.className = 'pill ' + (st.ready ? 'ready' : st.reachable ? 'booting' : 'bad')
    statusPill.textContent = st.ready ? 'ready' : st.reachable ? 'booting: ' + (st.phase || '?') : 'unreachable'
    extra.textContent = ''
    const facts = []
    if (st.dbBytes != null) facts.push('db ' + (st.dbBytes / 1e6).toFixed(1) + ' MB')
    if (st.totalRssMB != null) facts.push('rss ' + st.totalRssMB + ' MB')
    if (st.requestsServed != null) facts.push(st.requestsServed + ' requests')
    facts.push('probe ' + st.probeMs + ' ms')
    extra.appendChild(el('div', { class: 'meta', text: facts.join('  |  ') }))
    if (st.publicInvoker === true) extra.appendChild(el('div', { class: 'err', text: 'PUBLIC: allUsers can invoke and zeropg has no built-in auth; anyone with the URL can run SQL.' }))
    if (st.error) extra.appendChild(el('div', { class: 'err', text: st.error }))
    b.disabled = false
  })
  const wakeBtn = btn('wake', async (b) => {
    b.disabled = true; b.textContent = 'waking...'
    const q = '?service=' + encodeURIComponent(inst.name) + '&context=' + encodeURIComponent(inst.context)
    const r = await (await fetch('/api/wake' + q, { method: 'POST' })).json()
    b.textContent = r.ready ? 'ready in ' + r.waitedMs + ' ms' : 'not ready (' + (r.phase || '?') + ')'
    setTimeout(() => { b.textContent = 'wake'; b.disabled = false }, 4000)
  })
  const copyBtn = (label, value) => { const b = el('button', { class: 'copy', text: label }); b.onclick = async () => { await navigator.clipboard.writeText(value); b.textContent = 'copied'; setTimeout(() => (b.textContent = label), 1200) }; return b }
  const cmds = el('code', { class: 'cmd', text:
    'zeropg fleet export ' + inst.name + ' --out ' + inst.name + '.sql\\n' +
    'zeropg fleet migrate ' + inst.name + ' --to <postgres-url> --yes' })
  return el('div', { class: 'card' }, [
    el('h2', {}, [
      el('span', { text: inst.name }),
      el('span', { class: 'pill', text: inst.context }),
      inst.appLabel ? el('span', { class: 'pill', text: inst.appLabel }) : el('span'),
      statusPill,
    ]),
    el('div', { class: 'meta', text: inst.project + '/' + inst.region + '  |  durability: ' + (inst.durability || 'sleep (default)') + (inst.extensions.length ? '  |  extensions: ' + inst.extensions.join(', ') : '') }),
    dl,
    el('div', { class: 'actions' }, [
      statusBtn, wakeBtn,
      copyBtn('copy url', inst.url || ''),
      copyBtn('copy sql endpoint', inst.url ? inst.url + '/sql' : ''),
      copyBtn('copy bucket', bucket),
    ]),
    extra,
    cmds,
  ])
}
load()
</script>
</body>
</html>
`

export async function runConsole(flags: Record<string, string | boolean>): Promise<void> {
  const port = typeof flags.port === 'string' ? Number(flags.port) : 4900
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(PAGE)
      }
      if (url.pathname === '/api/fleet') return json(200, await discover())
      if (url.pathname === '/api/status' || url.pathname === '/api/wake') {
        const service = url.searchParams.get('service')
        const context = url.searchParams.get('context')
        if (!service) return json(400, { error: 'service query param required' })
        const inst = await findByName(service, context)
        if (!inst) return json(404, { error: `no instance ${service}` })
        if (url.pathname === '/api/status') return json(200, await probeStatus(inst))
        return json(200, await wakeAndWait(inst))
      }
      return json(404, { error: 'not found' })
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1 only. Never bind wider: the console can wake and inspect every
    // database your credentials reach, and zeropg instances have no auth layer.
    server.listen(port, '127.0.0.1', resolve)
  })
  console.log(`zeropg console: http://127.0.0.1:${port} (Ctrl-C to stop)`)
}
