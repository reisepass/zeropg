// zeropg Console SPA shell: instant paint, real-URL history routing, and
// lazy-loaded per-view chunks (dynamic import). Auth is checked once on load;
// unauthenticated navigation is redirected to the login view.

const BASE = '/studio'
const ROUTES = {
  [`${BASE}`]: { view: 'home', crumb: 'Home' },
  [`${BASE}/`]: { view: 'home', crumb: 'Home' },
  [`${BASE}/editor`]: { view: 'editor', crumb: 'Table editor' },
  [`${BASE}/sql`]: { view: 'sql', crumb: 'SQL editor' },
  [`${BASE}/logs`]: { view: 'logs', crumb: 'Logs' },
  [`${BASE}/settings`]: { view: 'settings', crumb: 'Settings' },
}

const state = { authenticated: false, csrfToken: null, returnTo: null }

// ---- API client (adds CSRF header to mutating requests) ----
export async function api(path, opts = {}) {
  const method = opts.method || 'GET'
  const headers = { ...(opts.headers || {}) }
  let body
  if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body) }
  if (method !== 'GET' && method !== 'HEAD' && state.csrfToken) headers['x-csrf-token'] = state.csrfToken
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body })
  let data = null
  const text = await r.text()
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (r.status === 401) { state.authenticated = false; showLogin() ; const e = new Error('unauthorized'); e.status = 401; e.data = data; throw e }
  if (!r.ok) { const e = new Error((data && data.error) || `request failed (${r.status})`); e.status = r.status; e.data = data; throw e }
  return data
}

// ---- small DOM helpers shared with views ----
export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = dv
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v)
  }
  for (const c of [].concat(children)) { if (c == null) continue; n.append(c.nodeType ? c : document.createTextNode(String(c))) }
  return n
}
export function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => {})
  return Promise.resolve()
}

const sidebar = document.getElementById('sidebar')
const topbar = document.getElementById('topbar')
const viewEl = document.getElementById('view')
const crumbEl = document.getElementById('crumb')

// ---- login view (kept in the shell so it paints instantly) ----
function showLogin() {
  sidebar.hidden = true
  topbar.hidden = true
  if (location.pathname !== `${BASE}/login`) { state.returnTo = location.pathname + location.search; history.replaceState({}, '', `${BASE}/login`) }
  viewEl.innerHTML = ''
  const err = el('div', { class: 'err', 'data-testid': 'login-error' })
  const pw = el('input', { type: 'password', id: 'password', 'data-testid': 'login-password', autocomplete: 'current-password', placeholder: 'Admin password' })
  const btn = el('button', { class: 'btn btn-primary', 'data-testid': 'login-submit', type: 'submit' }, 'Sign in')
  const form = el('form', { class: 'login-card', 'data-testid': 'login', onsubmit: async (e) => {
    e.preventDefault()
    err.textContent = ''
    btn.disabled = true
    try {
      const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw.value }) })
      const data = await res.json().catch(() => ({}))
      if (res.status === 429) { err.textContent = data.error || 'too many attempts'; btn.disabled = false; return }
      if (!res.ok) { err.textContent = data.error || 'invalid password'; btn.disabled = false; return }
      state.authenticated = true
      state.csrfToken = data.csrfToken
      const to = state.returnTo && state.returnTo.startsWith(`${BASE}`) && state.returnTo !== `${BASE}/login` ? state.returnTo : `${BASE}`
      state.returnTo = null
      history.replaceState({}, '', to)
      await boot()
    } catch (ex) { err.textContent = String(ex && ex.message || ex); btn.disabled = false }
  } }, [
    el('div', { class: 'brand' }, [document.createTextNode('zero'), el('span', {}, 'Studio')]),
    el('p', { class: 'sub' }, 'Admin console for zeropg'),
    el('div', { class: 'field' }, [el('label', {}, 'Password'), pw]),
    btn,
    err,
  ])
  viewEl.append(el('div', { class: 'login-wrap' }, form))
  setTimeout(() => pw.focus(), 0)
}

// ---- connection modal ----
const connModal = document.getElementById('conn-modal')
const connBody = document.getElementById('conn-body')
async function openConnModal() {
  connBody.innerHTML = '<div class="empty">Loading...</div>'
  connModal.hidden = false
  try {
    const c = await api('/connection')
    connBody.innerHTML = ''
    const pubRow = (k, label, val) => el('div', { class: 'row' }, [
      el('div', { class: 'k' }, label),
      el('div', { class: 'copyrow' }, [
        el('div', { class: 'value-box', 'data-testid': `conn-${k}` }, val || '(not set)'),
        el('button', { class: 'btn', onclick: () => copyToClipboard(val || '') }, 'Copy'),
      ]),
    ])
    const wrap = el('div', { class: 'kv' }, [
      pubRow('rest', 'REST URL', c.rest),
      pubRow('auth', 'Auth URL', c.auth),
      pubRow('anonKey', 'anon key', c.anonKey),
    ])
    for (const s of c.secrets) {
      const box = el('div', { class: 'value-box', 'data-testid': `secret-${s.key}` }, '••••••••  (hidden)')
      const revealBtn = el('button', { class: 'btn', 'data-testid': `reveal-${s.key}`, onclick: async () => {
        const r = await api(`/connection/reveal?item=${encodeURIComponent(s.key)}`, { method: 'POST' })
        box.textContent = r.value || '(not set)'
        box.dataset.revealed = '1'
        revealBtn.disabled = true
      } }, 'Reveal')
      wrap.append(el('div', { class: 'row' }, [
        el('div', { class: 'k' }, `${s.label} (privileged)`),
        el('div', { class: 'copyrow' }, [box, revealBtn]),
      ]))
    }
    connBody.append(wrap)
  } catch (e) {
    connBody.innerHTML = `<div class="err">${e.message}</div>`
  }
}
document.getElementById('conn-open').addEventListener('click', openConnModal)
document.getElementById('conn-close').addEventListener('click', () => { connModal.hidden = true })
connModal.addEventListener('click', (e) => { if (e.target === connModal) connModal.hidden = true })
document.getElementById('logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }) } catch {}
  state.authenticated = false; state.csrfToken = null
  history.replaceState({}, '', `${BASE}/login`)
  showLogin()
})

// ---- status pill (polls /status) ----
let statusTimer = null
async function refreshStatus() {
  const pill = document.getElementById('status-pill')
  try {
    const s = await api('/status')
    if (s.awake) { pill.textContent = 'ready'; pill.className = 'pill ok' }
    else { pill.textContent = 'waking'; pill.className = 'pill warn' }
  } catch { pill.textContent = 'offline'; pill.className = 'pill warn' }
}

// ---- router ----
const viewCache = {}
async function loadView(name) {
  if (!viewCache[name]) viewCache[name] = await import(`${BASE}/views/${name}.js`)
  return viewCache[name]
}
function setActiveNav(pathname) {
  for (const a of document.querySelectorAll('.nav-item')) {
    a.classList.toggle('active', a.getAttribute('data-route') === pathname || (pathname === `${BASE}/` && a.getAttribute('data-route') === BASE))
  }
}
async function renderRoute() {
  const path = location.pathname
  const route = ROUTES[path] || ROUTES[`${BASE}`]
  crumbEl.textContent = route.crumb
  setActiveNav(path)
  viewEl.innerHTML = '<div class="loading">Loading...</div>'
  try {
    const mod = await loadView(route.view)
    viewEl.innerHTML = ''
    await mod.render(viewEl, { api, el, copyToClipboard, state, navigate })
  } catch (e) {
    if (e.status === 401) return
    viewEl.innerHTML = `<div class="err">Failed to load view: ${e.message}</div>`
  }
}
export function navigate(to) {
  if (to !== location.pathname) history.pushState({}, '', to)
  renderRoute()
}
// intercept internal nav link clicks
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-route]')
  if (!a) return
  e.preventDefault()
  navigate(a.getAttribute('href'))
})
window.addEventListener('popstate', () => { if (state.authenticated) renderRoute(); else showLogin() })

// ---- boot ----
async function boot() {
  sidebar.hidden = false
  topbar.hidden = false
  document.getElementById('status-pill').textContent = 'connecting'
  refreshStatus()
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = setInterval(refreshStatus, 5000)
  await renderRoute()
}

async function init() {
  try {
    const s = await api('/session')
    if (s && s.authenticated) {
      state.authenticated = true
      state.csrfToken = s.csrfToken
      if (location.pathname === `${BASE}/login`) history.replaceState({}, '', `${BASE}`)
      await boot()
    } else {
      showLogin()
    }
  } catch {
    showLogin()
  }
}
init()
