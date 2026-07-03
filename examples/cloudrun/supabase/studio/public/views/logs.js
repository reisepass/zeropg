// Logs: the DIY in-Postgres log view (studio.logs). Newest first, filterable by
// source and level. Red styling is reserved for error-level rows only.

const LEVELS = ['', 'info', 'warn', 'error']

export async function render(root, { api, el }) {
  root.append(el('h1', {}, 'Logs'), el('p', { class: 'sub' }, 'BFF request / auth / SQL events, written to studio.logs. Secrets are redacted at write time.'))

  const sourceInput = el('input', { 'data-testid': 'logs-source', placeholder: 'source (e.g. auth, sql, bff)' })
  const levelSel = el('select', { 'data-testid': 'logs-level' }, LEVELS.map((l) => el('option', { value: l }, l || '(any level)')))
  const list = el('div', { 'data-testid': 'logs-list', class: 'card', style: 'padding:0' })

  async function load() {
    list.innerHTML = '<div class="loading" style="padding:14px">Loading...</div>'
    const qs = new URLSearchParams({ limit: '200' })
    if (sourceInput.value.trim()) qs.set('source', sourceInput.value.trim())
    if (levelSel.value) qs.set('level', levelSel.value)
    let logs
    try { ({ logs } = await api(`/logs?${qs.toString()}`)) } catch (e) { list.innerHTML = `<div class="err" style="padding:14px">${e.message}</div>`; return }
    list.innerHTML = ''
    if (!logs.length) { list.append(el('div', { class: 'empty' }, 'No log rows')); return }
    for (const row of logs) {
      list.append(el('div', { class: 'log-row', 'data-testid': 'log-row', dataset: { source: row.source, level: row.level } }, [
        el('span', { class: 'ts' }, new Date(row.ts).toISOString().replace('T', ' ').replace('Z', '')),
        el('span', { class: 'log-src', 'data-testid': 'log-source' }, row.source),
        el('span', { class: `log-lvl ${row.level}`, 'data-testid': 'log-level' }, row.level),
        el('span', { class: 'log-msg', 'data-testid': 'log-message' }, row.message),
      ]))
    }
  }

  const apply = el('button', { class: 'btn', 'data-testid': 'logs-apply', onclick: load }, 'Apply')
  sourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load() })
  levelSel.addEventListener('change', load)
  root.append(el('div', { class: 'filterbar' }, [
    el('div', { class: 'fg' }, [el('label', {}, 'source'), sourceInput]),
    el('div', { class: 'fg' }, [el('label', {}, 'level'), levelSel]),
    apply,
  ]), list)

  await load()
}
