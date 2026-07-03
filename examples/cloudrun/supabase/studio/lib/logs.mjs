// DIY in-Postgres logging: the BFF writes its own request/auth/sql events to
// studio.logs. Redaction is applied to every log payload so no password, cookie,
// authorization header, API key, or full connection string is ever persisted.

const REDACT_KEYS = /(pass(word)?|secret|token|cookie|authorization|auth|api[-_]?key|service[-_]?key|jwt|connection[-_]?string|dsn|db[-_]?url)/i

const REDACTED = '[redacted]'

// Deep-redact an object/array by key name; also blanks any string that looks like
// a bearer token or a postgres connection URL regardless of its key.
export function redact(value, depth = 0) {
  if (depth > 6) return REDACTED
  if (value == null) return value
  if (typeof value === 'string') {
    if (/^Bearer\s+/i.test(value)) return REDACTED
    if (/^postgres(ql)?:\/\//i.test(value)) return REDACTED
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? REDACTED : redact(v, depth + 1)
  }
  return out
}

export function createLogger(meta, { console: consoleFallback = true } = {}) {
  // fire-and-forget write; logging must never block or fail a request
  async function log(source, level, message, metaObj) {
    const safeMeta = metaObj === undefined ? null : redact(metaObj)
    if (consoleFallback) {
      const line = `[studio:${source}] ${level} ${message}`
      if (level === 'error') console.error(line)
      else console.log(line)
    }
    try {
      await meta.query(
        'INSERT INTO studio.logs (source, level, message, meta) VALUES ($1, $2, $3, $4::jsonb)',
        [source, level, String(message), safeMeta === null ? null : JSON.stringify(safeMeta)],
      )
    } catch {
      // swallow - a logging failure must not surface to the user
    }
  }
  return {
    log,
    info: (source, message, meta) => log(source, 'info', message, meta),
    warn: (source, message, meta) => log(source, 'warn', message, meta),
    error: (source, message, meta) => log(source, 'error', message, meta),
  }
}
