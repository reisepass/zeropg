// Idempotent studio schema. Applied by the BFF at startup (with retry, since the
// backend may still be waking from GCS). Holds SQL-editor history + saved queries
// and the DIY in-Postgres log table (replaces Supabase's external Logflare/Vector).

export const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS studio;

CREATE TABLE IF NOT EXISTS studio.queries (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('history','saved')),
  name        text,
  sql         text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  success     boolean,
  error       text
);
CREATE INDEX IF NOT EXISTS queries_kind_time_idx ON studio.queries (kind, executed_at DESC);

CREATE TABLE IF NOT EXISTS studio.logs (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  source  text NOT NULL,
  level   text NOT NULL,
  message text NOT NULL,
  meta    jsonb
);
CREATE INDEX IF NOT EXISTS logs_time_idx   ON studio.logs (ts DESC);
CREATE INDEX IF NOT EXISTS logs_source_idx ON studio.logs (source, level, ts DESC);
`

// Apply the bootstrap, retrying while the backend is still restoring.
export async function applyBootstrap(meta, { attempts = 30, delayMs = 1000, log = () => {} } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      await meta.query(BOOTSTRAP_SQL)
      log(`[studio] bootstrap applied (attempt ${i + 1})`)
      return true
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error(`studio bootstrap failed after ${attempts} attempts: ${lastErr && lastErr.message}`)
}
