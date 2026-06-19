// The one node-postgres-shaped interface every engine presents (Track E2). App
// code binds to this; only the DATABASE_URL changes from laptop to bucket to a
// graduated postgres:// host. The shape mirrors `pg`'s `query()` result
// (`{rows, rowCount, fields}`) so an app can move to real `pg` with no rewrite.

export type Engine = 'memory' | 'file' | 'remote' | 'postgres'

export interface FieldInfo {
  name: string
  /** Postgres type OID, when the engine reports it. */
  dataTypeID?: number
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[]
  /** Rows affected for writes; row count for reads (node-postgres semantics). */
  rowCount: number
  fields: FieldInfo[]
}

/** The query surface available both on a Client and inside a transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  exec(sql: string): Promise<void>
}

export interface Client extends Queryable {
  /** Which engine the connection string resolved to. */
  readonly engine: Engine
  /** Run `fn` inside a single Postgres transaction; commit on resolve, roll
   * back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
  /** Pre-warm a scale-to-zero remote instance (wake + wait-until-restored).
   * No-op for in-process / always-on engines, so callers can always call it. */
  ensureReady(): Promise<void>
  /** Release the connection (close PGlite / release the lock / end the pool). */
  end(): Promise<void>
}

export interface ConnectOptions {
  /** Override the lock acquire timeout for file:// (ms). Default 10s. */
  acquireTimeoutMs?: number
  /** Extra headers (e.g. Authorization) for the remote HTTP engine. */
  headers?: Record<string, string>
  /** Max wait for a remote scale-to-zero instance to become ready (ms). */
  readyTimeoutMs?: number
  /** Disable the same-process HMR instance pin for file:// (default: pinned). */
  noHmrPin?: boolean
}
