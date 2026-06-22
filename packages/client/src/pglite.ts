// Embedded PGlite engine — backs both memory:// (ephemeral, in-process) and
// file://<path> (NodeFS datadir, guarded by the E1 cross-process lock + the
// same-process HMR instance pin). This is the "local" rung of the ladder; the
// durability/single-writer story for the remote rungs lives in @zeropg/server
// and ObjectStoreFS.

import { PGlite } from '@electric-sql/pglite'
import { resolve } from 'node:path'
import { acquireDatadirLock, type DatadirLock } from './lockfile.js'
import type { Client, ConnectOptions, Engine, FieldInfo, QueryResult, Queryable } from './types.js'

// Whether the installed PGlite build takes its OWN cross-process datadir lock
// (the reisepass/pglite-kill-dash-9 fork does, baked into NodeFS). If it does,
// the wrapper MUST NOT also lock: both use the same `<datadir>.lock` path with
// incompatible token formats, so running both stalls ~10s while each treats the
// other's lock as foreign and reclaims it. Resolution order: explicit option ->
// env var -> a static `managesDataDirLock` marker the fork can advertise.
export function nativeDatadirLockEnabled(opts: { nativeDatadirLock?: boolean }): boolean {
  if (opts.nativeDatadirLock !== undefined) return opts.nativeDatadirLock
  const env = process.env.ZEROPG_NATIVE_DATADIR_LOCK
  if (env === '1' || env === 'true') return true
  return (PGlite as unknown as { managesDataDirLock?: boolean }).managesDataDirLock === true
}

interface PgliteRow {
  rows: unknown[]
  fields?: { name: string; dataTypeID: number }[]
  affectedRows?: number
}

function normalize<T>(r: PgliteRow): QueryResult<T> {
  const fields: FieldInfo[] = (r.fields ?? []).map((f) => ({
    name: f.name,
    dataTypeID: f.dataTypeID,
  }))
  // node-postgres: rowCount is affected rows for writes, row count for reads.
  const rowCount = r.affectedRows && r.affectedRows > 0 ? r.affectedRows : r.rows.length
  return { rows: r.rows as T[], rowCount, fields }
}

// HMR pin (E1 layer 2). A PID lockfile can't tell two PGlite instances apart in
// the SAME process — a Next.js / tsx-watch module reload keeps the process alive
// and would open a SECOND instance on the same datadir. We pin the live instance
// to globalThis keyed by absolute datadir (the Prisma-client-in-Next-dev pattern)
// so a reload reuses the one instance instead of tearing the files. Cleared on
// end(); a framework that doesn't end() on reload simply finds the pin and reuses.
interface Pinned {
  pg: PGlite
  lock: DatadirLock | null
}
const PIN_KEY = Symbol.for('zeropg.client.pglite.pins')
function pins(): Map<string, Pinned> {
  const g = globalThis as unknown as Record<symbol, Map<string, Pinned>>
  if (!g[PIN_KEY]) g[PIN_KEY] = new Map()
  return g[PIN_KEY]
}

class PgliteClient implements Client {
  readonly engine: Engine
  private readonly pinKey: string | null
  /** True for the handle that created the instance; false for a handle that
   * reused a pinned instance. Only the owner tears down on end() — a reused
   * handle's end() must leave the shared instance + lock intact for the
   * still-live owner (and the next HMR reload). */
  private readonly owns: boolean
  constructor(
    private pg: PGlite,
    private lock: DatadirLock | null,
    engine: Engine,
    pinKey: string | null,
    owns: boolean,
  ) {
    this.engine = engine
    this.pinKey = pinKey
    this.owns = owns
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return normalize<T>((await this.pg.query<T>(sql, params)) as unknown as PgliteRow)
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql)
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (tx) => {
      const wrapped: Queryable = {
        query: async <U = Record<string, unknown>>(sql: string, params?: unknown[]) =>
          normalize<U>((await tx.query<U>(sql, params)) as unknown as PgliteRow),
        exec: async (sql: string) => {
          await tx.exec(sql)
        },
      }
      return fn(wrapped)
    }) as Promise<T>
  }

  async ensureReady(): Promise<void> {
    // Always resident — nothing to wake.
  }

  async end(): Promise<void> {
    if (!this.owns) return // reused pinned handle — leave the shared instance alone
    if (this.pinKey) pins().delete(this.pinKey)
    await this.pg.close()
    if (this.lock) await this.lock.release()
  }
}

export async function connectMemory(): Promise<Client> {
  const pg = await PGlite.create()
  return new PgliteClient(pg, null, 'memory', null, true)
}

export async function connectFile(dataDir: string, opts: ConnectOptions): Promise<Client> {
  const abs = resolve(dataDir)

  if (!opts.noHmrPin) {
    const existing = pins().get(abs)
    if (existing) {
      // Reuse the pinned instance (HMR reload / second same-process open). It
      // already holds the cross-process lock; this client must NOT release it.
      return new PgliteClient(existing.pg, null, 'file', abs, false)
    }
  }

  // Stand down when PGlite locks the datadir itself — let the single, canonical
  // lock (the fork's) own `<datadir>.lock`; never run two protocols over it.
  const lock = nativeDatadirLockEnabled(opts)
    ? null
    : await acquireDatadirLock(abs, { acquireTimeoutMs: opts.acquireTimeoutMs })
  let pg: PGlite
  try {
    pg = await PGlite.create({ dataDir: abs })
  } catch (e) {
    if (lock) await lock.release()
    throw e
  }

  const pinKey = opts.noHmrPin ? null : abs
  if (pinKey) pins().set(pinKey, { pg, lock })
  return new PgliteClient(pg, lock, 'file', pinKey, true)
}
