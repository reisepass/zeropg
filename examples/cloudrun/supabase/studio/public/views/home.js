// Home / status card: the zeropg observability seed. Shows whether the backend
// is awake, the PGlite/Postgres version, the database size, and BFF uptime.

function fmtUptime(s) {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export async function render(root, { api, el }) {
  root.append(
    el('h1', {}, 'zeroSupabaseStudio'),
    el('p', { class: 'sub' }, 'Admin console for a scale-to-zero Postgres (zeropg / PGlite over one shared wire session).'),
  )
  const grid = el('div', { class: 'card-grid', 'data-testid': 'status-grid' })
  root.append(grid)

  const stat = (k, testid) => {
    const v = el('div', { class: 'v', 'data-testid': testid }, '...')
    grid.append(el('div', { class: 'stat' }, [el('div', { class: 'k' }, k), v]))
    return v
  }
  const awakeEl = stat('Backend', 'status-awake')
  const verEl = stat('Postgres version', 'status-version')
  const sizeEl = stat('Database size', 'status-size')
  const upEl = stat('BFF uptime', 'status-uptime')

  async function refresh() {
    try {
      const s = await api('/status')
      awakeEl.textContent = s.awake ? 'awake' : 'waking'
      awakeEl.className = 'v'
      awakeEl.style.color = s.awake ? 'var(--accent)' : '#e2b04a'
      verEl.textContent = s.version || (s.awake ? 'unknown' : 'waiting...')
      sizeEl.textContent = s.dbSizePretty ? `${s.dbSizePretty}` : (s.dbSize != null ? `${s.dbSize} bytes` : '...')
      upEl.textContent = fmtUptime(s.uptimeSecs || 0)
    } catch (e) {
      awakeEl.textContent = 'offline'
      awakeEl.style.color = 'var(--danger)'
    }
  }
  await refresh()

  root.append(el('div', { class: 'card' }, [
    el('h2', {}, 'What this is'),
    el('p', { class: 'sub', style: 'margin-top:8px' }, 'A light Supabase-Studio-style console built directly on postgres-meta over the single PGlite wire session. The SQL editor rejects transaction-control statements and resets session state after every submission, because one open transaction on the shared session would freeze every other backend consumer.'),
  ]))
}
