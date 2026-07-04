// Per-database memory for the console: a tiny cache of the things worth
// remembering about a db between visits - last known size, when we last
// probed/woke it, how long it took to start, and a few table names so a
// badly-named db still hints at what it holds.
//
// Stored at ~/.zeropg/instance-stats.json as one JSON object keyed by a stable
// id (durable bucket/prefix for remote instances, the datadir path for local
// ones). Console-side, low-frequency writes, so a plain read-modify-write of a
// small file is fine (unlike the hot-path append-only opens.jsonl breadcrumbs).
// Everything is best-effort: a stats failure never breaks a console action.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zeropgHome } from '@zeropg/client'

export interface InstanceStats {
  /** Last known on-disk database size, bytes. */
  dbBytes?: number
  /** Last time the console probed/connected (ISO). */
  lastProbeAt?: string
  lastProbeMs?: number
  /** Last time the console woke it, and how long the start took (ISO / ms). */
  lastWakeAt?: string
  lastStartupMs?: number
  /** Up to 5 most-recently-created and 5 first-created public tables (by oid,
   *  a good-enough proxy for creation order) - a hint at what the db is for. */
  recentTables?: string[]
  oldestTables?: string[]
  tablesAt?: string
}

function statsPath(): string {
  return join(zeropgHome(), 'instance-stats.json')
}

/** Stable id for a remote instance: its durable bucket home survives service
 *  renames; fall back to context/name when the bucket is unknown. */
export function remoteStatsKey(inst: { bucket: string | null; prefix: string | null; context: string; name: string }): string {
  return inst.bucket && inst.prefix ? `gs://${inst.bucket}/${inst.prefix}` : `svc:${inst.context}/${inst.name}`
}

export function localStatsKey(datadirPath: string): string {
  return `file:${datadirPath}`
}

export function readAllStats(): Record<string, InstanceStats> {
  try {
    const o = JSON.parse(readFileSync(statsPath(), 'utf8')) as Record<string, InstanceStats>
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

export function readStats(key: string): InstanceStats | undefined {
  return readAllStats()[key]
}

/** Shallow-merge a stats patch for one key. Never throws. */
export function mergeStats(key: string, patch: InstanceStats): void {
  try {
    const all = readAllStats()
    all[key] = { ...all[key], ...patch }
    mkdirSync(zeropgHome(), { recursive: true })
    writeFileSync(statsPath(), JSON.stringify(all, null, 2) + '\n')
  } catch {
    /* remembering is a nicety, never a hard dependency */
  }
}

/** Minimal shape of whatever can run SQL and give back rows. Both PGlite
 *  (local serve, replica.raw) and a node-postgres client satisfy this. */
interface Queryable {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * Read the size + table hints straight off a live handle (a served local wire's
 * PGlite, or a bucket replica). Best-effort: returns {} on any error.
 */
export async function captureDbStats(db: Queryable): Promise<InstanceStats> {
  const out: InstanceStats = {}
  try {
    const size = await db.query('SELECT pg_database_size(current_database())::text AS b')
    const b = size.rows[0]?.b
    if (b !== undefined) out.dbBytes = Number(b)
  } catch {
    /* size is optional */
  }
  const tablesByOid = async (dir: 'DESC' | 'ASC'): Promise<string[]> => {
    try {
      const r = await db.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
          `WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.oid ${dir} LIMIT 5`,
      )
      return r.rows.map((row) => String(row.relname))
    } catch {
      return []
    }
  }
  out.recentTables = await tablesByOid('DESC')
  out.oldestTables = await tablesByOid('ASC')
  out.tablesAt = new Date().toISOString()
  return out
}
