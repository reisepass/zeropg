// Remote engine — a bucket-backed, scale-to-zero zeropg instance reached over
// HTTP (@zeropg/server's POST /sql + /wake + /ready). This is the adapter over
// the server's HTTP surface from the E2 table; it surfaces E3 pre-warm
// (ensureReady = wake + wait-until-restored) through the unified interface so a
// remote connect() can warm the instance before the first query.
//
// Reached via http(s):// connection strings. The bucket-scheme strings
// (gs:// / r2:// / s3:// / cos://) that name a bucket directly resolve to an
// EMBEDDED ObjectStoreFS instance instead — wired separately — because they
// carry a bucket, not a server endpoint.

import { ZeroPGRemoteClient } from '@zeropg/server'
import type { Client, ConnectOptions, Engine, FieldInfo, QueryResult, Queryable } from './types.js'

class RemoteClient implements Client {
  readonly engine: Engine = 'remote'
  constructor(private rc: ZeroPGRemoteClient) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Params are bound server-side by POST /sql, which forwards them to
    // ZeroPG.query(sql, params). Never inline values into the string: that is
    // an injection hazard, and it is what a repository layer emitting $1/$2
    // would otherwise be forced into.
    const { rows, rowCount } = await this.rc.sql<T>(sql, params)
    // /sql returns JSON rows only - no type OIDs. Derive field names from the
    // first row so the pg-shaped `fields` is non-empty for tooling.
    const first = rows[0] as Record<string, unknown> | undefined
    const fields: FieldInfo[] = first ? Object.keys(first).map((name) => ({ name })) : []
    return { rows, rowCount, fields }
  }

  /** Multi-statement SQL (migrations) goes over the simple protocol, which is
   *  the only path that accepts several statements in one request. */
  async exec(sql: string): Promise<void> {
    await this.rc.execMulti(sql)
  }

  async transaction<T>(_fn: (tx: Queryable) => Promise<T>): Promise<T> {
    throw new Error(
      'remote engine: multi-statement transactions are not supported over the ' +
        'stateless HTTP /sql surface (each POST is independent). Send one SQL string ' +
        'wrapped in BEGIN; ... COMMIT;, or use a wire (postgres://) connection.',
    )
  }

  async ensureReady(): Promise<void> {
    await this.rc.ensureReady()
  }

  async end(): Promise<void> {
    // Stateless HTTP client — nothing to close.
  }
}

export async function connectRemote(baseUrl: string, opts: ConnectOptions): Promise<Client> {
  const rc = new ZeroPGRemoteClient({
    baseUrl,
    headers: opts.headers,
    readyTimeoutMs: opts.readyTimeoutMs,
  })
  return new RemoteClient(rc)
}
