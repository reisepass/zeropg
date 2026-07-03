// Thin client for supabase/postgres-meta - the introspection + run-SQL engine
// (docs/STUDIO-PGMETA-COMPAT.md). Everything the studio reads/runs goes through
// here so there is exactly one place that talks to the shared PGlite session.

// DISCARD ALL is the strongest single "return this session to a clean state"
// primitive and is verified working on PGlite: it clears role + SESSION
// AUTHORIZATION, all GUCs (search_path included), prepared statements, temp
// objects, LISTEN channels, and SESSION-level advisory locks - all of which
// otherwise persist on the ONE shared PGlite session across requests. We then
// pin search_path to public. (This supersedes the older "RESET ROLE; RESET ALL"
// baseline, which left advisory locks / temp / prepared statements behind.)
//
// It MUST be sent as its own single-statement query: `DISCARD ALL` errors with
// 25001 ("cannot run inside a transaction block") if it shares a multi-statement
// simple-query string, because the wire treats that string as one implicit txn.
const RESET_DISCARD = 'DISCARD ALL'
const RESET_SEARCH_PATH = 'SET search_path TO public'

export function createMeta({ baseUrl, requestTimeoutMs = 35_000 }) {
  const base = baseUrl.replace(/\/$/, '')

  async function call(path, init) {
    const t0 = Date.now()
    let r
    try {
      r = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
    } catch (e) {
      // A client-side timeout here means the BFF stopped waiting - the query may
      // still be running in PGlite. Surface that distinction to the caller.
      const timedOut = e && (e.name === 'TimeoutError' || String(e).includes('aborted'))
      const err = new Error(timedOut ? 'timeout' : `postgres-meta unreachable: ${String(e)}`)
      err.timeout = timedOut
      err.upstreamDown = !timedOut
      throw err
    }
    const text = await r.text()
    let body
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: r.status, body, ms: Date.now() - t0 }
  }

  // Run arbitrary SQL. Returns { rows, ms } on success; throws a rich error
  // (with .code / .formattedError / .pg) carrying the real Postgres error on
  // failure. `parameters` uses node-postgres bind params ($1..) - do NOT combine
  // with statementTimeoutSecs (that forces multi-statement mode which cannot bind).
  async function query(sql, parameters) {
    const body = parameters !== undefined ? { query: sql, parameters } : { query: sql }
    const r = await call('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.status >= 400) {
      const b = r.body || {}
      const err = new Error(b.formattedError || b.error || b.message || `query failed (${r.status})`)
      err.status = r.status
      err.code = b.code || null
      err.formattedError = b.formattedError || null
      err.pg = b
      throw err
    }
    return { rows: Array.isArray(r.body) ? r.body : [], ms: r.ms }
  }

  // Restore the shared session to a known baseline. Called after every SQL-editor
  // submission so one editor user's SET / SET ROLE / SET search_path does not leak
  // to the next. RESET ALL alone does NOT clear SET ROLE - the explicit RESET ROLE
  // is required (verified in the compat spike).
  async function resetSession() {
    // Two separate autocommit statements (see RESET_DISCARD note). Best-effort:
    // never mask the primary result, but do not let a DISCARD failure skip the
    // search_path pin.
    try { await query(RESET_DISCARD) } catch { /* best-effort */ }
    try { await query(RESET_SEARCH_PATH) } catch { /* best-effort */ }
  }

  async function schemas() {
    const r = await call('/schemas')
    return Array.isArray(r.body) ? r.body : []
  }

  // All tables with their columns[]. postgres-meta introspection is fully
  // schema-qualified against pg_catalog, so it is immune to a polluted search_path.
  async function tables() {
    const r = await call('/tables')
    return Array.isArray(r.body) ? r.body : []
  }

  return { query, resetSession, schemas, tables, base }
}
