// Table editor / data explorer: READ-ONLY grid over postgres-meta introspection
// + validated POST /query reads (identifiers validated against the introspected
// list and double-quoted by the BFF; filter values are bind parameters). Sidebar
// lists schemas/tables, hiding internal schemas by default. Pagination, sort by
// header click, and one simple filter.

import { renderGrid } from '/studio/views/util.js'

const PAGE_SIZE = 50
const FILTER_OPS = [['eq', '='], ['neq', '≠'], ['like', 'LIKE'], ['ilike', 'ILIKE'], ['is-null', 'IS NULL']]

export async function render(root, { api, el, navigate }) {
  const sel = { schema: null, table: null, offset: 0, sort: null, dir: 'asc', filterCol: '', filterOp: 'eq', filterVal: '' }

  const side = el('div', { class: 'tb-side', 'data-testid': 'tb-sidebar' })
  const showInternal = el('input', { type: 'checkbox', 'data-testid': 'tb-internal' })
  const main = el('div', { 'data-testid': 'tb-main' }, el('div', { class: 'empty' }, 'Select a table'))

  root.append(el('h1', {}, 'Table editor'), el('p', { class: 'sub' }, 'Read-only browse over postgres-meta. Identifiers are validated against introspection; filter values use bind parameters.'))
  root.append(el('div', { class: 'tb-layout' }, [el('div', {}, [el('label', { class: 'toggle' }, [showInternal, ' show internal schemas']), side]), main]))

  let tables = []
  async function loadTables() {
    const { tables: t } = await api('/meta/tables?refresh=1')
    tables = t
    renderSidebar()
  }
  function renderSidebar() {
    side.innerHTML = ''
    const visible = tables.filter((t) => showInternal.checked || !t.internal)
    const bySchema = new Map()
    for (const t of visible) { if (!bySchema.has(t.schema)) bySchema.set(t.schema, []); bySchema.get(t.schema).push(t) }
    if (!bySchema.size) { side.append(el('div', { class: 'empty' }, 'No tables')); return }
    for (const [schema, ts] of [...bySchema.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      side.append(el('div', { class: 'tb-schema' }, schema))
      for (const t of ts.sort((a, b) => a.name.localeCompare(b.name))) {
        const active = sel.schema === t.schema && sel.table === t.name
        side.append(el('div', {
          class: `tb-table${active ? ' active' : ''}`,
          'data-testid': `tb-table`,
          dataset: { key: `${t.schema}.${t.name}` },
          onclick: () => selectTable(t.schema, t.name),
        }, t.name))
      }
    }
  }
  showInternal.addEventListener('change', renderSidebar)

  function selectTable(schema, table) {
    sel.schema = schema; sel.table = table; sel.offset = 0; sel.sort = null; sel.dir = 'asc'
    sel.filterCol = ''; sel.filterOp = 'eq'; sel.filterVal = ''
    renderSidebar()
    loadRows()
  }

  async function loadRows() {
    main.innerHTML = ''
    main.append(el('div', { class: 'loading' }, 'Loading rows...'))
    const qs = new URLSearchParams({ schema: sel.schema, table: sel.table, limit: String(PAGE_SIZE), offset: String(sel.offset) })
    if (sel.sort) { qs.set('sort', sel.sort); qs.set('dir', sel.dir) }
    if (sel.filterCol && sel.filterOp) { qs.set('filterCol', sel.filterCol); qs.set('filterOp', sel.filterOp); if (sel.filterOp !== 'is-null') qs.set('filterVal', sel.filterVal) }
    let data
    try { data = await api(`/rows?${qs.toString()}`) } catch (e) { main.innerHTML = ''; main.append(el('div', { class: 'err' }, e.message)); return }
    renderMain(data)
  }

  function renderMain(data) {
    main.innerHTML = ''
    // header row: table name + count
    const total = data.total
    main.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px' }, [
      el('h2', {}, `${sel.schema}.${sel.table}`),
      el('span', { class: 'sql-meta', 'data-testid': 'tb-count' }, `${total} row${total === 1 ? '' : 's'}`),
    ]))

    // filter bar
    const colSel = el('select', { 'data-testid': 'tb-filter-col' }, [el('option', { value: '' }, '(no filter)'), ...data.columns.map((c) => el('option', { value: c.name }, c.name))])
    colSel.value = sel.filterCol
    const opSel = el('select', { 'data-testid': 'tb-filter-op' }, FILTER_OPS.map(([v, l]) => el('option', { value: v }, l)))
    opSel.value = sel.filterOp
    const valInput = el('input', { 'data-testid': 'tb-filter-val', placeholder: 'value', value: sel.filterVal })
    const applyBtn = el('button', { class: 'btn', 'data-testid': 'tb-filter-apply', onclick: () => {
      sel.filterCol = colSel.value; sel.filterOp = opSel.value; sel.filterVal = valInput.value; sel.offset = 0; loadRows()
    } }, 'Apply')
    const clearBtn = el('button', { class: 'btn btn-ghost', 'data-testid': 'tb-filter-clear', onclick: () => { sel.filterCol = ''; sel.filterVal = ''; sel.offset = 0; loadRows() } }, 'Clear')
    main.append(el('div', { class: 'filterbar' }, [
      el('div', { class: 'fg' }, [el('label', {}, 'filter'), colSel]),
      el('div', { class: 'fg' }, [el('label', {}, 'op'), opSel]),
      el('div', { class: 'fg' }, [el('label', {}, 'value'), valInput]),
      applyBtn, clearBtn,
    ]))

    // grid
    if (data.rows.length === 0) {
      main.append(el('div', { class: 'empty', 'data-testid': 'tb-empty' }, 'No rows'))
    } else {
      const grid = renderGrid(data.columns, data.rows, {
        testid: 'tb-grid',
        sort: sel.sort ? { col: sel.sort, dir: sel.dir } : null,
        onSort: (col) => {
          if (sel.sort === col) sel.dir = sel.dir === 'asc' ? 'desc' : 'asc'
          else { sel.sort = col; sel.dir = 'asc' }
          sel.offset = 0; loadRows()
        },
      })
      main.append(el('div', { class: 'grid-wrap' }, grid))
    }

    // pager
    const from = total === 0 ? 0 : sel.offset + 1
    const to = Math.min(sel.offset + PAGE_SIZE, total)
    const prev = el('button', { class: 'btn', 'data-testid': 'tb-prev', disabled: sel.offset === 0 ? true : null, onclick: () => { sel.offset = Math.max(0, sel.offset - PAGE_SIZE); loadRows() } }, 'Prev')
    const next = el('button', { class: 'btn', 'data-testid': 'tb-next', disabled: to >= total ? true : null, onclick: () => { sel.offset += PAGE_SIZE; loadRows() } }, 'Next')
    main.append(el('div', { class: 'pager' }, [prev, next, el('span', { class: 'sql-meta', 'data-testid': 'tb-pageinfo' }, `${from}-${to} of ${total}`)]))
  }

  await loadTables()
}
