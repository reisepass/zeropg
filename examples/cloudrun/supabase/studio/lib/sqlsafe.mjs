// SQL-safety helpers for the studio BFF.
//
// Two jobs, both dictated by zeropg's single shared PGlite session
// (docs/STUDIO-PGMETA-COMPAT.md):
//
//  1. rejectTxnControl(sql): an idle-open or long-running explicit transaction
//     on the shared session FREEZES every other backend consumer
//     (PostgREST/GoTrue included) until it commits/rolls back. So the SQL editor
//     must reject transaction-control statements. Detection strips comments and
//     all string/dollar-quote/identifier literals first, so `BEGIN` inside a
//     PL/pgSQL body or a string is NOT a false positive, and a `BEGIN;` hidden
//     among other statements in a multi-statement submission IS caught.
//
//  2. quoteIdent(name): double-quote an identifier for use in dynamically built
//     read queries (schema/table/column), after the name has been validated
//     against live introspection. Values are NEVER interpolated - they go through
//     bind parameters ($1) on postgres-meta POST /query.

// Remove comments and quoted regions, replacing each with a single space so
// statement boundaries (;) and leading keywords survive. Handles: line comments
// (-- ... EOL), block comments (/* ... */, PostgreSQL-nestable), single-quoted
// strings ('' escaping), dollar-quoted strings ($tag$ ... $tag$), and
// double-quoted identifiers.
export function stripSqlLiterals(sql) {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = sql[i + 1]
    // line comment
    if (c === '-' && c2 === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    // block comment (nestable)
    if (c === '/' && c2 === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      out += ' '
      continue
    }
    // single-quoted string literal
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      out += ' '
      continue
    }
    // double-quoted identifier
    if (c === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue }
        if (sql[i] === '"') { i++; break }
        i++
      }
      out += ' '
      continue
    }
    // dollar-quoted string ($tag$ ... $tag$)
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*|)\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) { i = n } else { i = end + tag.length }
        out += ' '
        continue
      }
    }
    out += c
    i++
  }
  return out
}

// Split a (literal-stripped) SQL string into individual statements on top-level
// semicolons, trimmed, empties dropped.
export function splitStatements(strippedSql) {
  return strippedSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const TXN_CONTROL = [
  /^BEGIN\b/i,
  /^START\s+TRANSACTION\b/i,
  /^COMMIT\b/i,
  /^END\b/i, // COMMIT alias
  /^ROLLBACK\b/i,
  /^ABORT\b/i, // ROLLBACK alias
  /^SAVEPOINT\b/i,
  /^RELEASE\b/i, // RELEASE SAVEPOINT
  /^SET\s+TRANSACTION\b/i,
  /^SET\s+CONSTRAINTS\b/i,
]

// `COPY ... FROM STDIN` puts the wire into copy-in mode waiting for copy data
// the BFF never sends. Verified on PGlite: it triggers a FATAL protocol
// desync (08P01) that tears down the connection - a genuine wedge of the shared
// session, distinct from an ordinary long autocommit statement. (COPY ... TO
// STDOUT is harmless and is NOT blocked.)
const COPY_FROM_STDIN = /^COPY\b[\s\S]*\bFROM\s+STDIN\b/i

// Returns { ok, statement?, kind? } - ok=false if any statement is a shared-session
// hazard. kind is 'txn' (transaction control) or 'copy' (COPY FROM STDIN).
export function rejectSharedSessionHazards(sql) {
  const stripped = stripSqlLiterals(sql)
  for (const stmt of splitStatements(stripped)) {
    for (const re of TXN_CONTROL) {
      if (re.test(stmt)) return { ok: false, kind: 'txn', statement: stmt.split(/\s+/).slice(0, 2).join(' ') }
    }
    if (COPY_FROM_STDIN.test(stmt)) return { ok: false, kind: 'copy', statement: 'COPY FROM STDIN' }
  }
  return { ok: true }
}

// Back-compat alias.
export const rejectTxnControl = rejectSharedSessionHazards

export const TXN_REJECT_MESSAGE =
  'Transaction-control statements (BEGIN, START TRANSACTION, COMMIT, ROLLBACK, END, ' +
  'SAVEPOINT, RELEASE) are not allowed in the SQL editor. zeropg runs one shared ' +
  'PGlite session: an open transaction freezes every other backend consumer ' +
  '(the REST and auth services included) until it commits or rolls back. Each ' +
  'submission already runs autocommit - remove the transaction wrapper.'

export const COPY_REJECT_MESSAGE =
  'COPY ... FROM STDIN is not allowed in the SQL editor. It puts the single shared ' +
  'PGlite wire session into copy-in mode waiting for data the console never sends, ' +
  'which desyncs the wire protocol and tears down the shared session. Use an ' +
  'INSERT ... SELECT, or COPY ... TO STDOUT for export.'

// Double-quote a Postgres identifier (schema/table/column). The caller MUST
// have already validated the name against live introspection; this is a second
// line of defence, not the primary check.
export function quoteIdent(name) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('invalid identifier')
  return '"' + name.replace(/"/g, '""') + '"'
}
