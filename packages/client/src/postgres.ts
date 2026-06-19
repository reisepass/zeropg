// Graduated engine — a real always-on Postgres (RDS / Cloud SQL / Neon / a
// dedicated wire server) reached via postgres:// / postgresql://. This is the
// top rung of the ladder: when a database outgrows the embedded/scale-to-zero
// model, the only thing that changes is DATABASE_URL. We pass straight through
// to node-postgres, whose result shape is the one this whole interface mirrors,
// so there is nothing to normalize.
//
// `pg` is an OPTIONAL peer dependency (most laptops/edge targets never touch a
// postgres:// URL), loaded on demand with an actionable error if it is missing.

import type { Client, Engine, QueryResult, Queryable } from './types.js'

// Minimal structural views of the bits of node-postgres we use, so this file
// type-checks without `pg`'s types installed.
interface PgQueryResult {
  rows: unknown[]
  rowCount: number | null
  fields: { name: string; dataTypeID: number }[]
}
interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>
  release(): void
}
interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>
  connect(): Promise<PgPoolClient>
  end(): Promise<void>
}

async function loadPg(): Promise<{ Pool: new (cfg: { connectionString: string }) => PgPool }> {
  try {
    // Non-literal specifier: `pg` is an OPTIONAL peer dep, so we must not make
    // the build hard-depend on its types being present. Resolved at runtime.
    const spec = 'pg'
    return (await import(spec)) as unknown as {
      Pool: new (cfg: { connectionString: string }) => PgPool
    }
  } catch {
    throw new Error(
      "postgres:// connection strings need the optional peer dependency 'pg'. " +
        'Install it: `npm install pg` (or pnpm/yarn add pg).',
    )
  }
}

function toResult<T>(r: PgQueryResult): QueryResult<T> {
  return {
    rows: r.rows as T[],
    rowCount: r.rowCount ?? r.rows.length,
    fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
  }
}

class PgClient implements Client {
  readonly engine: Engine = 'postgres'
  constructor(private pool: PgPool) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return toResult<T>(await this.pool.query(sql, params))
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql)
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const c = await this.pool.connect()
    const tx: Queryable = {
      query: async <U = Record<string, unknown>>(sql: string, params?: unknown[]) =>
        toResult<U>(await c.query(sql, params)),
      exec: async (sql: string) => {
        await c.query(sql)
      },
    }
    try {
      await c.query('BEGIN')
      const out = await fn(tx)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  async ensureReady(): Promise<void> {
    // Always-on — nothing to wake.
  }

  async end(): Promise<void> {
    await this.pool.end()
  }
}

export async function connectPostgres(connectionString: string): Promise<Client> {
  const { Pool } = await loadPg()
  return new PgClient(new Pool({ connectionString }))
}
