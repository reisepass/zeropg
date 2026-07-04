// Settings: connection info (same data as the modal) plus the binding
// architecture notes, so the constraints are discoverable in the UI.

export async function render(root, { api, el, copyToClipboard }) {
  root.append(el('h1', {}, 'Settings'), el('p', { class: 'sub' }, 'Connection details and the single-session rules this console is built around.'))

  const connCard = el('div', { class: 'card' }, [el('h2', {}, 'Connection & API keys'), el('div', { class: 'empty' }, 'Loading...')])
  root.append(connCard)
  try {
    const c = await api('/connection')
    connCard.innerHTML = ''
    connCard.append(el('h2', {}, 'Connection & API keys'))
    const kv = el('div', { class: 'kv', style: 'margin-top:12px' })
    const pub = (k, label, val) => kv.append(el('div', { class: 'row' }, [
      el('div', { class: 'k' }, label),
      el('div', { class: 'copyrow' }, [el('div', { class: 'value-box', 'data-testid': `set-${k}` }, val || '(not set)'), el('button', { class: 'btn', onclick: () => copyToClipboard(val || '') }, 'Copy')]),
    ]))
    pub('rest', 'REST URL', c.rest)
    pub('auth', 'Auth URL', c.auth)
    pub('anonKey', 'anon key', c.anonKey)
    for (const s of c.secrets) {
      const box = el('div', { class: 'value-box', 'data-testid': `set-secret-${s.key}` }, '••••••••  (hidden)')
      const btn = el('button', { class: 'btn', 'data-testid': `set-reveal-${s.key}`, onclick: async () => { const r = await api(`/connection/reveal?item=${encodeURIComponent(s.key)}`, { method: 'POST' }); box.textContent = r.value || '(not set)'; btn.disabled = true } }, 'Reveal')
      // Copy without revealing: fetch the value and put it straight on the
      // clipboard - it is never rendered into the DOM.
      const copyBtn = el('button', { class: 'btn', 'data-testid': `set-copy-${s.key}`, onclick: async () => {
        const r = await api(`/connection/reveal?item=${encodeURIComponent(s.key)}&mode=copy`, { method: 'POST' })
        await copyToClipboard(r.value || '')
        const orig = copyBtn.textContent
        copyBtn.textContent = 'Copied'
        copyBtn.disabled = true
        setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false }, 1500)
      } }, 'Copy')
      kv.append(el('div', { class: 'row' }, [el('div', { class: 'k' }, `${s.label} (privileged)`), el('div', { class: 'copyrow' }, [box, copyBtn, btn])]))
    }
    connCard.append(kv)
  } catch (e) { connCard.innerHTML = `<div class="err">${e.message}</div>` }

  root.append(el('div', { class: 'card' }, [
    el('h2', {}, 'Single-session rules (binding)'),
    el('ul', { style: 'margin:10px 0 0; padding-left:18px; color:var(--muted); font-size:13px; line-height:1.7' }, [
      el('li', {}, 'statement_timeout is inert on PGlite. The SQL editor timeout is client-side and is reported as "stopped waiting", never "cancelled".'),
      el('li', {}, 'Transaction-control statements are blocked in the SQL editor - an open transaction freezes every other backend consumer on the shared session.'),
      el('li', {}, 'Session state (SET / SET ROLE / search_path) is reset after every SQL-editor submission.'),
      el('li', {}, 'Index metadata is read from pg_indexes, not postgres-meta /indexes (which drops non-first-column indexes on PGlite).'),
    ]),
  ]))
}
