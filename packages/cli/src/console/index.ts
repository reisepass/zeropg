// `zeropg console`: a local web view over every database you have.
//   remote - live fleet discovery (same functions as `zeropg fleet`)
//   local  - datadirs from the ~/.zeropg/opens.jsonl breadcrumbs
// Per row it can mint a live connection (serveWire for local dirs) and launch
// zeroSupabaseStudio against anything (local = the real DB; remote = a
// detached bucket snapshot, no lease, live service untouched).
//
// Binds 127.0.0.1 ONLY, on purpose: zeropg instances have no built-in auth,
// so a network-exposed console would be an open door to every database it can
// see. It is a viewer/launcher for the human; agents use the CLI.

import { createServer } from 'node:http'
import { probeStatus, wakeAndWait } from '../fleet/probe.js'
import { listLocalDbs, peekLocalDb } from '../fleet/localdbs.js'
import { inspectManifest, peekTables } from '../fleet/bucket.js'
import { mergeStats, readAllStats, remoteStatsKey } from '../fleet/stats.js'
import { discover, findByName } from './discovery.js'
import {
  serveLocal,
  serveReplica,
  stopServed,
  listServed,
  stopAllServed,
  launchStudio,
  stopStudio,
  currentStudio,
} from './serve.js'
import { launchPgweb, listEditors, stopEditor, stopAllEditors } from './editors.js'

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
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; }
  header .sub { color:var(--dim); font-size:12px; }
  main { padding:24px; max-width:1200px; margin:0 auto; }
  h3.group { margin:24px 0 12px; font-size:13px; color:var(--dim); text-transform:uppercase; letter-spacing:.08em; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; margin-bottom:16px; padding:16px 20px; }
  .card h2 { margin:0 0 4px; font-size:15px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .meta { color:var(--dim); font-size:12px; }
  .mem { color:var(--dim); font-size:11px; opacity:.75; margin-top:2px; }
  .studio-link { font-size:12px; color:var(--ok); border:1px solid var(--ok); border-radius:10px; padding:1px 8px; text-decoration:none; }
  .studio-link:hover { background:rgba(63,185,80,.12); }
  dl { display:grid; grid-template-columns:110px 1fr; gap:4px 12px; margin:12px 0 0; }
  dt { color:var(--dim); }
  dd { margin:0; word-break:break-all; }
  .pill { font-size:11px; padding:1px 8px; border-radius:10px; border:1px solid var(--line); color:var(--dim); }
  .pill.ready { color:var(--ok); border-color:var(--ok); }
  .pill.booting { color:var(--warn); border-color:var(--warn); }
  .pill.bad { color:var(--bad); border-color:var(--bad); }
  .pill.gone { color:var(--bad); border-color:var(--bad); }
  .pill.serving { color:var(--ok); border-color:var(--ok); }
  button { font:inherit; font-size:12px; background:transparent; color:var(--accent); border:1px solid var(--accent); border-radius:6px; padding:3px 12px; cursor:pointer; }
  button:hover { background:rgba(88,166,255,.1); }
  button:disabled { opacity:.5; cursor:wait; }
  .actions { margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .copy { color:var(--dim); border-color:var(--line); }
  code.cmd { display:block; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px; margin-top:8px; word-break:break-all; color:var(--dim); }
  .err { color:var(--bad); }
  #empty { color:var(--dim); }
  #studio { border-color:var(--accent); }
  a { color:var(--accent); }
</style>
</head>
<body>
<header><h1>zeropg console</h1><span class="sub">every database you have - remote fleet (live discovery) + local datadirs (open-breadcrumbs). Local viewer only (127.0.0.1). Probing/waking a sleeping instance starts it.</span></header>
<main>
  <div id="studio-slot"></div>
  <div id="empty">scanning...</div>
  <div id="remote-slot"></div>
  <div id="local-slot"></div>
</main>
<script>
const el = (t, attrs = {}, kids = []) => {
  const n = document.createElement(t)
  for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else n.setAttribute(k, v) }
  for (const k of kids) n.appendChild(k)
  return n
}
const btn = (label, fn, cls) => { const b = el('button', { text: label, class: cls || '' }); b.onclick = () => fn(b); return b }
// One-click pgweb: mints the wire (local serveWire / remote snapshot), spawns a
// pinned pgweb, opens the tab already logged in - no connection form.
const pgwebBtn = (body) => btn('open in pgweb', async (b) => {
  b.disabled = true; const old = b.textContent; b.textContent = 'starting pgweb...'
  try { const r = await api('/api/editor/pgweb', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); window.open(r.url, '_blank') }
  catch (e) { alert('pgweb: ' + e.message) }
  b.textContent = old; b.disabled = false
})
const copyBtn = (label, value) => btn(label, async (b) => { await navigator.clipboard.writeText(value); b.textContent = 'copied'; setTimeout(() => (b.textContent = label), 1200) }, 'copy')
async function api(path, opts) { const r = await fetch(path, opts); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j }

let studioState = null

async function load() {
  const [fleet, local, s] = await Promise.all([api('/api/fleet'), api('/api/local'), api('/api/studio')])
  studioState = s.studio
  renderStudio()
  const empty = document.getElementById('empty')
  const remoteSlot = document.getElementById('remote-slot'); remoteSlot.textContent = ''
  const localSlot = document.getElementById('local-slot'); localSlot.textContent = ''

  if (fleet.instances.length) empty.textContent = ''
  else if (fleet.contextCount === 0) empty.textContent = 'no contexts configured - tell the console where to look:  zeropg fleet context add <name> --project <gcp-project> --region <region>'
  else if (fleet.errors.length === fleet.contextCount) empty.textContent = 'every context scan failed (errors below) - nothing could be discovered'
  else empty.textContent = 'contexts scanned, no zeropg instances found (a service counts when it has ZEROPG_BUCKET/ZEROPG_PREFIX env vars or a zeropg label)'

  remoteSlot.appendChild(el('h3', { class: 'group', text: 'remote (' + fleet.instances.length + ')' }))
  for (const e of fleet.errors) remoteSlot.appendChild(el('div', { class: 'card err', text: 'context ' + e.context + ': ' + e.error }))
  for (const inst of fleet.instances) remoteSlot.appendChild(remoteCard(inst))

  localSlot.appendChild(el('h3', { class: 'group', text: 'local (' + local.dbs.length + ')' }))
  if (!local.dbs.length) localSlot.appendChild(el('div', { class: 'meta', text: 'no local databases seen yet - they appear here after any zeropg open (connect file://, zeropg run, serveWire) drops a breadcrumb in ~/.zeropg/opens.jsonl' }))
  for (const db of local.dbs) localSlot.appendChild(localCard(db, local.served))
  updateStudioLinks()
}

// Put the running studio's link inline on whichever card it is inspecting, so
// you do not have to scroll to the top banner to open it.
function updateStudioLinks() {
  for (const slot of document.querySelectorAll('.studio-inline')) {
    slot.textContent = ''
    if (studioState && studioState.targetId === slot.getAttribute('data-tid')) {
      slot.appendChild(el('a', { class: 'studio-link', href: studioState.url, target: '_blank', text: '▸ open studio' }))
    }
  }
}

function renderStudio() {
  const slot = document.getElementById('studio-slot'); slot.textContent = ''
  const st = studioState
  if (!st) return
  slot.appendChild(el('div', { class: 'card', id: 'studio' }, [
    el('h2', {}, [el('span', { text: 'studio running' }), el('span', { class: 'pill serving', text: st.kind })]),
    el('div', { class: 'meta', text: 'inspecting: ' + st.target }),
    el('dl', {}, [
      el('dt', { text: 'open' }), el('dd', {}, [el('a', { href: st.url, target: '_blank', text: st.url })]),
      el('dt', { text: 'password' }), el('dd', { text: st.adminPassword }),
    ]),
    el('div', { class: 'actions' }, [btn('stop studio', async (b) => { b.disabled = true; await api('/api/studio/stop', { method: 'POST' }); studioState = null; renderStudio(); updateStudioLinks() })]),
  ]))
}

async function studioLaunch(body, b) {
  b.disabled = true; const old = b.textContent; b.textContent = 'starting studio...'
  try {
    await api('/api/studio/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    studioState = (await api('/api/studio')).studio
    renderStudio()
    updateStudioLinks() // inline link appears on this card immediately
  } catch (e) { alert('studio: ' + e.message) }
  b.textContent = old; b.disabled = false
}

function remoteCard(inst) {
  const bucket = inst.bucket && inst.prefix ? 'gs://' + inst.bucket + '/' + inst.prefix : '(unknown)'
  const statusPill = el('span', { class: 'pill', text: 'not probed' })
  const extra = el('div')
  const statusBtn = btn('probe status (wakes it)', async (b) => {
    b.disabled = true
    const q = '?service=' + encodeURIComponent(inst.name) + '&context=' + encodeURIComponent(inst.context)
    const st = await api('/api/status' + q)
    // Three cases: bare zeropg control face (phase/metrics), an app service
    // fronting zeropg (answers HTTP, no control face), or truly unreachable.
    let cls, label
    if (!st.reachable) { cls = 'bad'; label = 'unreachable' }
    else if (st.hasControlFace) { cls = st.ready ? 'ready' : 'booting'; label = st.ready ? 'ready' : 'booting: ' + (st.phase || '?') }
    else { cls = st.ready ? 'ready' : 'booting'; label = st.ready ? 'app up (HTTP ' + st.httpStatus + ')' : 'HTTP ' + st.httpStatus }
    statusPill.className = 'pill ' + cls
    statusPill.textContent = label
    extra.textContent = ''
    const facts = []
    if (st.dbBytes != null) facts.push('db ' + (st.dbBytes / 1e6).toFixed(1) + ' MB')
    if (st.totalRssMB != null) facts.push('rss ' + st.totalRssMB + ' MB')
    if (st.requestsServed != null) facts.push(st.requestsServed + ' requests')
    facts.push('probe ' + st.probeMs + ' ms')
    extra.appendChild(el('div', { class: 'meta', text: facts.join('  |  ') }))
    if (st.reachable && !st.hasControlFace) extra.appendChild(el('div', { class: 'meta', text: 'This is an app service fronting zeropg - it has no zeropg HTTP control face, so DB metrics are not available here. Inspect its data with "open in studio (snapshot)".' }))
    if (st.publicInvoker === true) extra.appendChild(el('div', { class: 'err', text: 'PUBLIC: allUsers can invoke and zeropg has no built-in auth; anyone with the URL can run SQL.' }))
    if (st.error) extra.appendChild(el('div', { class: 'err', text: st.error }))
    b.disabled = false
  })
  const wakeBtn = btn('wake', async (b) => {
    b.disabled = true; b.textContent = 'waking...'
    const q = '?service=' + encodeURIComponent(inst.name) + '&context=' + encodeURIComponent(inst.context)
    const r = await api('/api/wake' + q, { method: 'POST' })
    b.textContent = r.ready ? 'ready in ' + r.waitedMs + ' ms' : 'not ready (' + (r.phase || '?') + ')'
    setTimeout(() => { b.textContent = 'wake'; b.disabled = false }, 4000)
  })
  const studioBtn = btn('open in studio (snapshot)', (b) => studioLaunch({ kind: 'replica', service: inst.name, context: inst.context }, b))
  const pgweb = pgwebBtn({ kind: 'replica', service: inst.name, context: inst.context })
  // Remembered stats (grey memory), shown from cache without touching anything.
  const memSlot = el('div')
  const ago = (iso) => { if (!iso) return null; const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000); if (s < 90) return s + 's ago'; if (s < 5400) return Math.round(s/60) + 'm ago'; if (s < 129600) return Math.round(s/3600) + 'h ago'; return Math.round(s/86400) + 'd ago' }
  const renderMem = (s) => {
    memSlot.textContent = ''
    if (!s) return
    const bits = []
    if (s.dbBytes != null) bits.push((s.dbBytes / 1e6).toFixed(1) + ' MB')
    if (s.lastStartupMs != null) bits.push('last start ' + (s.lastStartupMs/1000).toFixed(1) + 's')
    if (s.lastWakeAt) bits.push('woke ' + ago(s.lastWakeAt))
    else if (s.lastProbeAt) bits.push('probed ' + ago(s.lastProbeAt))
    if (bits.length) memSlot.appendChild(el('div', { class: 'mem', text: 'memory: ' + bits.join('  ·  ') }))
    const tabs = [...new Set([...(s.recentTables||[]), ...(s.oldestTables||[])])].slice(0, 8)
    if (tabs.length) memSlot.appendChild(el('div', { class: 'mem', text: 'tables: ' + tabs.join(', ') }))
  }
  renderMem(inst.stats)
  const inspectBtn = btn('learn more (no wake)', async (b) => {
    b.disabled = true; const old = b.textContent; b.textContent = 'reading bucket...'
    try { const r = await api('/api/inspect', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ service: inst.name, context: inst.context }) }); renderMem(r.stats)
      memSlot.appendChild(el('div', { class:'mem', text: 'bucket: last commit ' + (r.info.committedAt || '?') + '  ·  ' + r.info.commitSeq + ' commits  ·  ' + (r.info.bucketBytes/1e6).toFixed(1) + ' MB stored' + (r.info.movedTo ? '  ·  MOVED TO ' + r.info.movedTo : '') })) }
    catch (e) { alert('inspect: ' + e.message) }
    b.textContent = old; b.disabled = false
  })
  const peekBtn = btn('peek tables (no wake)', async (b) => {
    b.disabled = true; const old = b.textContent; b.textContent = 'materializing snapshot...'
    try { const r = await api('/api/peek', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ service: inst.name, context: inst.context }) }); renderMem(r.stats) }
    catch (e) { alert('peek: ' + e.message) }
    b.textContent = old; b.disabled = false
  })
  return el('div', { class: 'card' }, [
    el('h2', {}, [
      el('span', { text: inst.name }),
      el('span', { class: 'pill', text: inst.context }),
      inst.appLabel ? el('span', { class: 'pill', text: inst.appLabel }) : el('span'),
      statusPill,
      el('span', { class: 'studio-inline', 'data-tid': inst.context + '/' + inst.name }),
    ]),
    el('div', { class: 'meta', text: inst.project + '/' + inst.region + '  |  durability: ' + (inst.durability || 'sleep (default)') + (inst.extensions.length ? '  |  extensions: ' + inst.extensions.join(', ') : '') }),
    memSlot,
    el('dl', {}, [
      el('dt', { text: 'url' }), el('dd', { text: inst.url || '(none)' }),
      el('dt', { text: 'bucket' }), el('dd', { text: bucket }),
      el('dt', { text: 'sql' }), el('dd', { text: inst.url ? 'POST ' + inst.url + '/sql' : '(none)' }),
      el('dt', { text: 'rest' }), el('dd', { text: inst.url ? inst.url + '/rest/<table>' : '(none)' }),
    ]),
    el('div', { class: 'actions' }, [
      inspectBtn, peekBtn, statusBtn, wakeBtn, studioBtn, pgweb,
      copyBtn('copy url', inst.url || ''),
      copyBtn('copy sql endpoint', inst.url ? inst.url + '/sql' : ''),
      copyBtn('copy bucket', bucket),
    ]),
    extra,
    el('code', { class: 'cmd', text:
      'zeropg fleet export ' + inst.name + ' --out ' + inst.name + '.sql\\n' +
      'zeropg fleet migrate ' + inst.name + ' --to <postgres-url> --yes' }),
  ])
}

function localCard(db, servedList) {
  const servedEntry = (servedList || []).find((s) => s.id === db.path)
  const connSlot = el('div')
  const renderConn = (s) => {
    connSlot.textContent = ''
    if (!s) return
    // Direct connections: the same live wire in every format a tool wants.
    const hostPort = '127.0.0.1:' + s.port
    const formats = [
      ['uri', s.url],
      ['psql', 'psql "' + s.url + '"'],
      ['jdbc', 'jdbc:postgresql://' + hostPort + '/postgres?user=postgres&sslmode=disable'],
      ['.env', 'DATABASE_URL=' + s.url],
    ]
    connSlot.appendChild(el('h3', { class: 'group', text: 'direct connections' }))
    const dl = el('dl')
    for (const [name, value] of formats) {
      dl.appendChild(el('dt', { text: name }))
      dl.appendChild(el('dd', { text: value }))
    }
    connSlot.appendChild(dl)
    connSlot.appendChild(el('div', { class: 'actions' }, [
      ...formats.map(([name, value]) => copyBtn('copy ' + name, value)),
      btn('stop serving', async (b) => { b.disabled = true; await api('/api/unserve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: db.path }) }); renderConn(null) }),
    ]))
  }
  const serveBtn = btn('serve (psql/TablePlus)', async (b) => {
    b.disabled = true; b.textContent = 'starting wire...'
    try {
      const s = await api('/api/serve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: db.path }) })
      renderConn(s)
    } catch (e) { alert('serve: ' + e.message) }
    b.textContent = 'serve (psql/TablePlus)'; b.disabled = false
  })
  const studioBtn = btn('open in studio', (b) => studioLaunch({ kind: 'local', path: db.path }, b))
  const pgweb = pgwebBtn({ kind: 'local', path: db.path })
  const memSlot = el('div')
  const renderMem = (s) => {
    memSlot.textContent = ''
    if (!s) return
    if (s.dbBytes != null) memSlot.appendChild(el('div', { class: 'mem', text: 'memory: ' + (s.dbBytes / 1e6).toFixed(1) + ' MB' }))
    const tabs = [...new Set([...(s.recentTables||[]), ...(s.oldestTables||[])])].slice(0, 8)
    if (tabs.length) memSlot.appendChild(el('div', { class: 'mem', text: 'tables: ' + tabs.join(', ') }))
  }
  renderMem(db.stats)
  const peekBtn = btn('peek (size+tables)', async (b) => {
    b.disabled = true; const old = b.textContent; b.textContent = 'reading...'
    try { const r = await api('/api/peek-local', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ path: db.path }) }); renderMem(r.stats) }
    catch (e) { alert('peek: ' + e.message + (/held by live/.test(e.message) ? ' (in use - stop the app or serve first)' : '')) }
    b.textContent = old; b.disabled = false
  })
  const pills = [el('span', { class: 'pill ' + (db.status === 'gone' ? 'gone' : ''), text: db.status })]
  if (db.lockPresent) pills.push(el('span', { class: 'pill', text: 'lock present' }))
  const card = el('div', { class: 'card' }, [
    el('h2', {}, [el('span', { text: db.path.split('/').pop() || db.path }), ...pills, el('span', { class: 'studio-inline', 'data-tid': db.path })]),
    el('div', { class: 'meta', text: 'last opened ' + db.lastOpened + '  |  project ' + db.cwd }),
    memSlot,
    el('dl', {}, [el('dt', { text: 'datadir' }), el('dd', { text: db.path })]),
    el('div', { class: 'actions' },
      db.status === 'gone' ? [copyBtn('copy path', db.path)] : [peekBtn, serveBtn, studioBtn, pgweb, copyBtn('copy path', db.path)]),
    connSlot,
  ])
  if (servedEntry) renderConn(servedEntry)
  return card
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
    const readBody = async (): Promise<Record<string, string>> => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      try {
        return JSON.parse(Buffer.concat(chunks).toString() || '{}')
      } catch {
        return {}
      }
    }
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(PAGE)
      }
      if (url.pathname === '/api/fleet') {
        const d = await discover()
        // Attach remembered stats (grey memory) to each instance.
        const stats = readAllStats()
        return json(200, { ...d, instances: d.instances.map((i) => ({ ...i, stats: stats[remoteStatsKey(i)] ?? null })) })
      }
      if (url.pathname === '/api/local') return json(200, { dbs: listLocalDbs(), served: listServed() })
      if ((url.pathname === '/api/inspect' || url.pathname === '/api/peek') && req.method === 'POST') {
        const { service, context } = await readBody()
        const inst = await findByName(service ?? '', context ?? null)
        if (!inst) return json(404, { error: `no instance ${service}` })
        if (url.pathname === '/api/inspect') {
          const info = await inspectManifest(inst)
          mergeStats(remoteStatsKey(inst), { dbBytes: info.bucketBytes })
          return json(200, { info, stats: { ...readAllStats()[remoteStatsKey(inst)] } })
        }
        const patch = await peekTables(inst)
        mergeStats(remoteStatsKey(inst), patch)
        return json(200, { stats: { ...readAllStats()[remoteStatsKey(inst)] } })
      }
      if (url.pathname === '/api/serve' && req.method === 'POST') {
        const { path } = await readBody()
        if (!path) return json(400, { error: 'path required' })
        const s = await serveLocal(path)
        return json(200, { id: s.id, url: s.url, port: s.port })
      }
      if (url.pathname === '/api/unserve' && req.method === 'POST') {
        const { path } = await readBody()
        return json(200, { stopped: await stopServed(path ?? '') })
      }
      if (url.pathname === '/api/peek-local' && req.method === 'POST') {
        const { path } = await readBody()
        if (!path) return json(400, { error: 'path required' })
        return json(200, { stats: await peekLocalDb(path) })
      }
      if (url.pathname === '/api/studio' && req.method !== 'POST') {
        const s = currentStudio()
        return json(200, { studio: s ? { url: s.url, adminPassword: s.adminPassword, target: s.target, targetId: s.targetId, kind: s.kind } : null })
      }
      if (url.pathname === '/api/studio/launch' && req.method === 'POST') {
        const body = await readBody()
        if (body.kind === 'local') {
          if (!body.path) return json(400, { error: 'path required' })
          const s = await launchStudio({ kind: 'local', path: body.path })
          return json(200, { url: s.url, adminPassword: s.adminPassword })
        }
        if (body.kind === 'replica') {
          const inst = await findByName(body.service ?? '', body.context ?? null)
          if (!inst) return json(404, { error: `no instance ${body.service}` })
          const s = await launchStudio({ kind: 'replica', inst })
          return json(200, { url: s.url, adminPassword: s.adminPassword })
        }
        return json(400, { error: 'kind must be local or replica' })
      }
      if (url.pathname === '/api/studio/stop' && req.method === 'POST') {
        return json(200, { stopped: await stopStudio() })
      }
      if (url.pathname === '/api/editors') return json(200, { editors: listEditors() })
      if (url.pathname === '/api/editor/pgweb' && req.method === 'POST') {
        const body = await readBody()
        let servedEntry
        if (body.kind === 'local') {
          if (!body.path) return json(400, { error: 'path required' })
          servedEntry = await serveLocal(body.path)
        } else if (body.kind === 'replica') {
          const inst = await findByName(body.service ?? '', body.context ?? null)
          if (!inst) return json(404, { error: `no instance ${body.service}` })
          servedEntry = await serveReplica(inst)
        } else return json(400, { error: 'kind must be local or replica' })
        const e = await launchPgweb(servedEntry.id, servedEntry.url)
        return json(200, { url: e.url, port: e.port, targetId: e.targetId })
      }
      if (url.pathname === '/api/editor/stop' && req.method === 'POST') {
        const { targetId } = await readBody()
        return json(200, { stopped: await stopEditor(targetId ?? '') })
      }
      if (url.pathname === '/api/status' || url.pathname === '/api/wake') {
        const service = url.searchParams.get('service')
        const context = url.searchParams.get('context')
        if (!service) return json(400, { error: 'service query param required' })
        const inst = await findByName(service, context)
        if (!inst) return json(404, { error: `no instance ${service}` })
        if (url.pathname === '/api/status') {
          const st = await probeStatus(inst)
          mergeStats(remoteStatsKey(inst), {
            lastProbeAt: new Date().toISOString(),
            lastProbeMs: st.probeMs,
            ...(st.dbBytes !== null ? { dbBytes: st.dbBytes } : {}),
          })
          return json(200, st)
        }
        const r = await wakeAndWait(inst)
        if (r.ready) mergeStats(remoteStatsKey(inst), { lastWakeAt: new Date().toISOString(), lastStartupMs: r.waitedMs })
        return json(200, r)
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

  const cleanup = async () => {
    await Promise.allSettled([stopStudio(), stopAllServed(), stopAllEditors()])
    process.exit(0)
  }
  process.on('SIGINT', () => void cleanup())
  process.on('SIGTERM', () => void cleanup())
}
