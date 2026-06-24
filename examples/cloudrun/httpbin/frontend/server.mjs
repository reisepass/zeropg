// The SPLIT FRONTEND for httpbin + requestbin on zeropg.
//
// This is its OWN Cloud Run service, intentionally separate from the backend.
// It has NO database and NO heavy dependencies, so it renders instantly even
// when the backend (app + zeropg db sidecar) is scaled to zero. The page's
// FIRST action is a fire-and-forget WAKE to the backend (client-side, after
// render) so the backend cold-starts in PARALLEL while the user reads the UI.
//
// minScale can stay 0 here too: this service is so cheap it cold-starts in
// well under a second, and it never touches the DB.
//
// Config (env): BACKEND_URL — the public backend base URL (the capture/echo
// service). Baked into the page so the browser talks to it directly.

import http from 'node:http'

const PORT = Number(process.env.PORT || 8080)
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8080'

const PAGE = (backend) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>requestbin on zeropg</title>
<style>
  :root { color-scheme: light dark; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 1100px; margin-inline: auto; line-height: 1.45; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; margin: 0 0 1.25rem; font-size: .9rem; }
  .card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 1rem; margin-bottom: 1rem; }
  button { font: inherit; padding: .5rem .9rem; border-radius: 8px; border: 1px solid rgba(128,128,128,.4); background: #2563eb; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: inherit; }
  input { font: inherit; padding: .5rem; border-radius: 8px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; width: 100%; }
  code, pre { font-family: var(--mono); font-size: .85rem; }
  pre { background: rgba(128,128,128,.12); padding: .75rem; border-radius: 8px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  .url { font-family: var(--mono); word-break: break-all; background: rgba(128,128,128,.12); padding: .4rem .6rem; border-radius: 6px; display: inline-block; }
  .req { border: 1px solid rgba(128,128,128,.25); border-radius: 8px; margin-bottom: .6rem; }
  .req summary { cursor: pointer; padding: .55rem .7rem; font-family: var(--mono); font-size: .85rem; }
  .req .meta { padding: 0 .7rem .6rem; }
  .pill { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .75rem; font-weight: 600; background: rgba(37,99,235,.18); }
  .muted { opacity: .6; }
  a { color: #2563eb; }
</style>
</head>
<body>
  <h1>requestbin on zeropg</h1>
  <p class="sub">A scale-to-zero httpbin + requestbin. This UI is a separate, always-instant service; it wakes the capture backend in the background.</p>

  <div class="card">
    <div class="row">
      <button id="newbin">Create a new bin</button>
      <span class="muted">or paste an existing bin id:</span>
    </div>
    <div class="row" style="margin-top:.6rem">
      <input id="binid" placeholder="bin id (e.g. ab12cd34ef56)" />
      <button class="secondary" id="open">Open</button>
    </div>
  </div>

  <div class="card" id="binpanel" hidden>
    <div class="row" style="justify-content:space-between">
      <div>Bin <span class="pill" id="binlabel"></span></div>
      <button class="secondary" id="refresh">Refresh</button>
    </div>
    <p style="margin:.6rem 0 .2rem">Send any request to this URL to capture it:</p>
    <div class="url" id="binurl"></div>
    <p class="muted" id="curlhint" style="margin:.4rem 0 0"></p>

    <div class="row" style="margin-top:.8rem">
      <input id="fwd" placeholder="optional forward URL (pipedream-style) https://..." />
      <button class="secondary" id="savefwd">Save forward</button>
    </div>

    <h3 style="margin:1rem 0 .4rem">Captured requests</h3>
    <div id="requests"><p class="muted">No requests yet. Hit the URL above.</p></div>
  </div>

  <p class="sub" style="margin-top:1.5rem">Backend: <a id="backendlink" href="${backend}" target="_blank"><span class="url">${backend}</span></a> · httpbin echo: <code>/get /post /headers /ip /uuid /status/:code /delay/:n /anything</code></p>

<script>
const BACKEND = ${JSON.stringify(backend)};

// WAKE the backend in the background the instant the page loads, so it cold
// starts in parallel while the user reads/clicks. Best-effort, client-side.
fetch(BACKEND + '/healthz', { mode: 'no-cors' }).catch(() => {});

const $ = (id) => document.getElementById(id);
let currentBin = null;

function setBin(binId) {
  currentBin = binId;
  $('binpanel').hidden = false;
  $('binlabel').textContent = binId;
  const u = BACKEND + '/b/' + binId;
  $('binurl').textContent = u;
  $('curlhint').textContent = 'e.g.  curl -X POST ' + u + " -d '{\\"hello\\":\\"zeropg\\"}'";
  history.replaceState(null, '', '?bin=' + encodeURIComponent(binId));
  loadRequests();
}

async function loadRequests() {
  if (!currentBin) return;
  const box = $('requests');
  try {
    const r = await fetch(BACKEND + '/api/bins/' + currentBin + '/requests');
    const data = await r.json();
    if (data.forward_url) $('fwd').value = data.forward_url;
    if (!data.requests || data.requests.length === 0) {
      box.innerHTML = '<p class="muted">No requests yet. Hit the URL above.</p>';
      return;
    }
    box.innerHTML = data.requests.map(renderReq).join('');
  } catch (e) {
    box.innerHTML = '<p class="muted">Backend waking up... <button class="secondary" onclick="loadRequests()">retry</button></p>';
  }
}

function esc(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function renderReq(r) {
  const when = new Date(r.ts).toLocaleString();
  const head = '<span class="pill">' + esc(r.method) + '</span> ' + esc(r.path) + esc(r.query || '') + ' <span class="muted">· ' + esc(when) + ' · #' + esc(r.id) + '</span>';
  const bodyLabel = r.body_encoding === 'base64' ? 'Body (base64' + (r.body_truncated ? ', truncated' : '') + ')' : 'Body' + (r.body_truncated ? ' (truncated)' : '');
  return '<details class="req"><summary>' + head + '</summary><div class="meta">'
    + '<strong>Headers</strong><pre>' + esc(JSON.stringify(r.headers, null, 2)) + '</pre>'
    + (r.body ? '<strong>' + bodyLabel + '</strong><pre>' + esc(r.body) + '</pre>' : '<p class="muted">(no body)</p>')
    + '<p class="muted">from ' + esc(r.remote_ip || '') + '</p></div></details>';
}

$('newbin').onclick = async () => {
  try {
    const r = await fetch(BACKEND + '/api/bins/new');
    const d = await r.json();
    setBin(d.bin_id);
  } catch (e) { alert('Backend waking up, try again in a second.'); }
};
$('open').onclick = () => { const v = $('binid').value.trim(); if (v) setBin(v); };
$('binid').addEventListener('keydown', e => { if (e.key === 'Enter') $('open').click(); });
$('refresh').onclick = loadRequests;
$('savefwd').onclick = async () => {
  if (!currentBin) return;
  const url = $('fwd').value.trim();
  await fetch(BACKEND + '/api/bins/' + currentBin + '/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ forward_url: url || null }),
  });
  alert(url ? 'Forwarding to ' + url : 'Forwarding cleared');
};

// deep-link: ?bin=<id> opens straight into a bin (bookmarkable URLs)
const params = new URLSearchParams(location.search);
const deep = params.get('bin');
if (deep) setBin(deep);
</script>
</body>
</html>`

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('ok')
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(PAGE(BACKEND_URL))
})

server.listen(PORT, () => console.log(`[httpbin-ui] up on :${PORT} backend=${BACKEND_URL}`))
