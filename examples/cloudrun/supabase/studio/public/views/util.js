// Shared rendering helpers for the data grids (table editor + SQL results).
// Type-aware cell rendering is a correctness feature: NULL must be visually and
// structurally distinct from an empty string, and jsonb/arrays/booleans/numbers
// render distinctly. Nothing is ever ellipsis-truncated - long values wrap.

function span(cls, text, extra = {}) {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  for (const [k, v] of Object.entries(extra)) s.setAttribute(k, v)
  return s
}

// Render one value into a cell span. `value` is already JSON (from postgres-meta),
// so jsonb/arrays arrive as JS objects/arrays, timestamps as strings, null as null.
export function renderCell(value) {
  if (value === null || value === undefined) {
    return span('cell cell-null', 'NULL', { 'data-null': '1' })
  }
  const t = typeof value
  if (t === 'boolean') return span('cell cell-bool', value ? 'true' : 'false', { 'data-bool': String(value) })
  if (t === 'number') return span('cell cell-num', String(value))
  if (t === 'object') return span('cell cell-json', JSON.stringify(value), { 'data-json': '1' })
  // string (includes empty string, numeric-as-text like bigint, timestamps)
  return span('cell cell-str', String(value), { 'data-empty': value === '' ? '1' : '0' })
}

// Build a results table. `columns` is an array of { name, type? } or strings.
// opts.onSort(colName) makes headers clickable; opts.sort = { col, dir }.
export function renderGrid(columns, rows, opts = {}) {
  const cols = columns.map((c) => (typeof c === 'string' ? { name: c } : c))
  const table = document.createElement('table')
  table.className = 'grid'
  table.setAttribute('data-testid', opts.testid || 'grid')

  const thead = document.createElement('thead')
  const htr = document.createElement('tr')
  for (const c of cols) {
    const th = document.createElement('th')
    th.setAttribute('data-testid', 'grid-th')
    th.setAttribute('data-col', c.name)
    const label = document.createElement('span')
    label.textContent = c.name
    th.append(label)
    if (c.type) {
      const ty = document.createElement('span')
      ty.className = 'type'
      ty.textContent = ' ' + c.type
      th.append(ty)
    }
    if (opts.sort && opts.sort.col === c.name) {
      const arrow = document.createElement('span')
      arrow.className = 'type'
      arrow.textContent = opts.sort.dir === 'desc' ? ' ▼' : ' ▲'
      th.append(arrow)
    }
    if (opts.onSort) th.addEventListener('click', () => opts.onSort(c.name))
    htr.append(th)
  }
  thead.append(htr)
  table.append(thead)

  const tbody = document.createElement('tbody')
  tbody.setAttribute('data-testid', 'grid-body')
  for (const row of rows) {
    const tr = document.createElement('tr')
    tr.setAttribute('data-testid', 'grid-row')
    for (const c of cols) {
      const td = document.createElement('td')
      td.setAttribute('data-col', c.name)
      td.append(renderCell(row[c.name]))
      tr.append(td)
    }
    tbody.append(tr)
  }
  table.append(tbody)
  return table
}
