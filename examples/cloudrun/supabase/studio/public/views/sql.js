// SQL editor: run arbitrary SQL through postgres-meta POST /query (autocommit,
// single shared session). Transaction control is rejected by the BFF; a timeout
// is reported as "stopped waiting", never "cancelled". Every submission is
// persisted to studio.queries (history); named queries can be saved.

import { renderGrid } from '/studio/views/util.js'

export async function render(root, { api, el }) {
  root.append(el('h1', {}, 'SQL editor'), el('p', { class: 'sub' }, 'Autocommit, one statement or many. Transaction-control statements are blocked - the shared PGlite session cannot afford an open transaction.'))

  const ta = el('textarea', { 'data-testid': 'sql-input', spellcheck: 'false', placeholder: 'select * from ...' })
  const runBtn = el('button', { class: 'btn btn-primary', 'data-testid': 'sql-run' }, 'Run')
  const saveBtn = el('button', { class: 'btn', 'data-testid': 'sql-save' }, 'Save query')
  const metaLine = el('span', { class: 'sql-meta', 'data-testid': 'sql-time' }, '')
  const errBox = el('div', { class: 'err', 'data-testid': 'sql-error' }, '')
  const resultBox = el('div', { 'data-testid': 'sql-result' })

  const historyList = el('ul', { class: 'panel-list', 'data-testid': 'sql-history' })
  const savedList = el('ul', { class: 'panel-list', 'data-testid': 'sql-saved' })

  async function run() {
    errBox.textContent = ''
    metaLine.textContent = 'running...'
    resultBox.innerHTML = ''
    runBtn.disabled = true
    try {
      const res = await api('/query', { method: 'POST', body: { sql: ta.value } })
      metaLine.textContent = `${res.rows.length} row${res.rows.length === 1 ? '' : 's'} in ${res.duration} ms`
      if (res.columns.length === 0) {
        resultBox.append(el('div', { class: 'empty', 'data-testid': 'sql-norows' }, 'Success. No rows returned.'))
      } else {
        resultBox.append(el('div', { class: 'grid-wrap' }, renderGrid(res.columns, res.rows, { testid: 'sql-results' })))
      }
    } catch (e) {
      const d = e.data || {}
      metaLine.textContent = d.duration != null ? `failed in ${d.duration} ms` : 'failed'
      const codeStr = d.code ? ` [${d.code}]` : ''
      errBox.textContent = `${d.error || e.message}${codeStr}`
      errBox.setAttribute('data-code', d.code || '')
      if (d.timeout) errBox.setAttribute('data-timeout', '1')
    } finally {
      runBtn.disabled = false
      await Promise.all([loadHistory(), null])
    }
  }
  runBtn.addEventListener('click', run)
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run() } })

  saveBtn.addEventListener('click', async () => {
    const name = prompt('Save query as:')
    if (!name) return
    await api('/saved', { method: 'POST', body: { name, sql: ta.value } })
    await loadSaved()
  })

  async function loadHistory() {
    try {
      const { history } = await api('/history?limit=50')
      historyList.innerHTML = ''
      if (!history.length) { historyList.append(el('li', { class: 'empty' }, 'No history yet')); return }
      for (const h of history) {
        historyList.append(el('li', { 'data-testid': 'history-item', dataset: { sql: h.sql }, onclick: () => { ta.value = h.sql } }, [
          el('div', {}, [el('span', { class: `badge ${h.success ? 'ok' : 'error'}` }, h.success ? 'ok' : 'error'), ' ', el('span', { class: 'sql-meta' }, `${h.duration_ms ?? '-'} ms`)]),
          el('div', { class: 'li-sql', 'data-testid': 'history-sql' }, h.sql),
        ]))
      }
    } catch {}
  }
  async function loadSaved() {
    try {
      const { saved } = await api('/saved')
      savedList.innerHTML = ''
      if (!saved.length) { savedList.append(el('li', { class: 'empty' }, 'No saved queries')); return }
      for (const s of saved) {
        savedList.append(el('li', { 'data-testid': 'saved-item', dataset: { name: s.name, sql: s.sql }, onclick: () => { ta.value = s.sql } }, [
          el('div', { class: 'li-name', 'data-testid': 'saved-name' }, s.name),
          el('div', { class: 'li-sql', 'data-testid': 'saved-sql' }, s.sql),
        ]))
      }
    } catch {}
  }

  root.append(
    el('div', { class: 'sql-editor' }, [
      ta,
      el('div', { class: 'sql-toolbar' }, [runBtn, saveBtn, metaLine]),
      errBox,
    ]),
    el('div', { class: 'sql-cols' }, [
      el('div', {}, [el('h2', {}, 'Result'), resultBox]),
      el('div', {}, [
        el('h2', {}, 'Saved queries'), savedList,
        el('h2', { style: 'margin-top:16px' }, 'History'), historyList,
      ]),
    ]),
  )
  await Promise.all([loadHistory(), loadSaved()])
}
