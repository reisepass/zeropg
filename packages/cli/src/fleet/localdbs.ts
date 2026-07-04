// Local databases: the other half of the inventory. Sources the
// open-breadcrumbs that @zeropg/client drops in ~/.zeropg/opens.jsonl on every
// successful datadir open (see packages/client/src/breadcrumb.ts) and
// annotates each with what can be checked cheaply right now.

import { existsSync, statSync } from 'node:fs'
import { readOpenBreadcrumbs, lockPathFor, acquireDatadirLock } from '@zeropg/client'
import { captureDbStats, localStatsKey, mergeStats, readAllStats, type InstanceStats } from './stats.js'

export interface LocalDb {
  /** Absolute datadir path. */
  path: string
  /** Project dir the open ran from. */
  cwd: string
  /** Last opened (ISO). */
  lastOpened: string
  /** present = datadir exists; gone = breadcrumb points at a deleted dir. */
  status: 'present' | 'gone'
  /** True when a wrapper lock file sits next to the datadir right now -
   *  usually a live process (a dead holder's lock is reclaimed on next open). */
  lockPresent: boolean
  /** Remembered size + table hints (from a prior peek/serve), or null. */
  stats: InstanceStats | null
}

export function listLocalDbs(): LocalDb[] {
  const stats = readAllStats()
  return readOpenBreadcrumbs().map((b) => {
    let status: LocalDb['status'] = 'gone'
    try {
      if (statSync(b.path).isDirectory()) status = 'present'
    } catch {
      /* gone */
    }
    return {
      path: b.path,
      cwd: b.cwd,
      lastOpened: b.at,
      status,
      lockPresent: status === 'present' && existsSync(lockPathFor(b.path)),
      stats: stats[localStatsKey(b.path)] ?? null,
    }
  })
}

/**
 * Open a local datadir read-only under the datadir lock, read its size +
 * public table-name hints, close, and cache them (keyed by path). Takes the
 * wrapper lock so it coordinates with any live `connect()`/`serveWire` holder;
 * a live holder makes this throw (skip - the db is in use), a stale lock from
 * a dead process is reclaimed. Never opens a second writer on a live datadir.
 */
export async function peekLocalDb(path: string): Promise<InstanceStats> {
  const { PGlite } = (await import('@electric-sql/pglite')) as { PGlite: { create(opts: { dataDir: string }): Promise<PgliteHandle> } }
  const lock = await acquireDatadirLock(path, { acquireTimeoutMs: 2000 })
  try {
    const pg = await PGlite.create({ dataDir: path })
    await pg.waitReady
    await pg.exec('SET default_transaction_read_only = on')
    const stats = await captureDbStats({ query: (sql: string) => pg.query(sql) })
    await pg.close()
    mergeStats(localStatsKey(path), stats)
    return stats
  } finally {
    await lock.release()
  }
}

interface PgliteHandle {
  waitReady: Promise<unknown>
  exec(sql: string): Promise<unknown>
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
  close(): Promise<void>
}
