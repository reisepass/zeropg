// @zeropg/client — the unified connection-string client (Track E2).
//
//   import { connect } from '@zeropg/client'
//   const db = await connect(process.env.DATABASE_URL)   // or connect()
//   const { rows } = await db.query('select 1 as n')
//
// One factory, one node-postgres-shaped interface, four engines behind it, zero
// app-code change across the ladder (DESIGN §5 made literal). Only DATABASE_URL
// changes from laptop to bucket to a graduated postgres:// host.
//
//   memory://                     embedded PGlite, in-process, ephemeral
//   file://./dev.db               embedded PGlite, NodeFS datadir (E1 lock + HMR pin)
//   http(s)://host                bucket-backed scale-to-zero zeropg over HTTP /sql
//   gs|r2|s3|cos://bucket/prefix  embedded bucket-backed zeropg  (NOT YET WIRED — see below)
//   postgres://… / postgresql://… graduated real Postgres via node-postgres

import { connectFile, connectMemory } from './pglite.js'
import { connectRemote } from './remote.js'
import { connectPostgres } from './postgres.js'
import type { Client, ConnectOptions } from './types.js'

export type {
  Client,
  ConnectOptions,
  Engine,
  FieldInfo,
  QueryResult,
  Queryable,
} from './types.js'
export {
  acquireDatadirLock,
  LockTimeoutError,
  type DatadirLock,
  type AcquireOptions,
} from './lockfile.js'

const DEFAULT_URL = 'memory://'

function schemeOf(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (!m) throw new Error(`connect: '${url}' is not a connection URL (expected scheme://…)`)
  return m[1].toLowerCase()
}

/** Strip the `file:` scheme, keeping the path verbatim so relative paths
 * (`file://./dev.db`, `file:dev.db`) and absolute paths (`file:///var/db`)
 * both round-trip. We do NOT use the URL parser here: it mangles a relative
 * `./dev.db` into a bogus host component. */
function filePath(url: string): string {
  const rest = url.replace(/^file:/i, '').replace(/^\/\//, '')
  if (!rest) throw new Error(`connect: ${url} has no path (use file://./dev.db or file:///abs/path)`)
  return rest
}

/**
 * Resolve a connection string to a live {@link Client}. With no argument, reads
 * `process.env.DATABASE_URL`, falling back to `memory://`.
 */
export async function connect(url?: string, opts: ConnectOptions = {}): Promise<Client> {
  const target = url ?? process.env.DATABASE_URL ?? DEFAULT_URL
  const scheme = schemeOf(target)

  switch (scheme) {
    case 'memory':
      return connectMemory()
    case 'file':
      return connectFile(filePath(target), opts)
    case 'http':
    case 'https':
      return connectRemote(target, opts)
    case 'postgres':
    case 'postgresql':
      return connectPostgres(target)
    case 'gs':
    case 'r2':
    case 's3':
    case 'cos':
      throw new Error(
        `connect: bucket-scheme '${scheme}://' (embedded bucket-backed engine) is not wired yet. ` +
          'For a deployed scale-to-zero instance use its http(s):// URL today; ' +
          'embedded ObjectStoreFS-from-URL is the next increment of Track E2.',
      )
    default:
      throw new Error(`connect: unsupported scheme '${scheme}://' in ${target}`)
  }
}
