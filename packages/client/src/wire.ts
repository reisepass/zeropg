// Local real-wire mode (ORM-ADAPTER-NOTES.md §1 — "the single biggest
// compatibility win"). PGlite is in-process only, but plenty of the Postgres
// ecosystem (Prisma's migration engine, `drizzle-kit push`, `psql`, TablePlus,
// any `pg`-based tool) insists on a real `postgres://` wire connection. This
// stands up a localhost Postgres-wire endpoint backed by one PGlite instance,
// via @electric-sql/pglite-socket, so those tools "just work" locally and a dev
// can author + apply schema exactly as they would against RDS — byte-identical
// to prod, since it IS Postgres.
//
// One PGlite, one writer: the datadir is held under the same E1 cross-process
// lock as the embedded engine, so a wire server and an embedded connect() can't
// both open it. The socket multiplexes many TCP connections (an ORM pool) onto
// the single serialized PGlite — which is exactly the single-writer model.

import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { acquireDatadirLock, type DatadirLock } from './lockfile.js'

export interface ServeWireOptions {
  /** Datadir to back the wire server. Omit for an ephemeral in-memory database. */
  dataDir?: string
  /** Port to listen on. Omit / 0 to pick a free port (read it back from `.port`). */
  port?: number
  /** Host to bind. Default 127.0.0.1 (localhost only — this is a dev convenience). */
  host?: string
  /** Max concurrent TCP connections. Default 100 so an ORM connection pool can
   * attach; queries still serialize through the single PGlite. */
  maxConnections?: number
  /** Lock acquire timeout for the datadir (ms). Default 10s. */
  acquireTimeoutMs?: number
}

export interface WireServer {
  /** The connection string to hand an ORM / psql, e.g. postgres://127.0.0.1:54xxx/postgres */
  readonly url: string
  readonly host: string
  readonly port: number
  /** The underlying PGlite, if a caller also wants in-process access. */
  readonly pglite: PGlite
  /** Stop the socket server, release the lock, close PGlite. */
  stop(): Promise<void>
}

/** Pick a free TCP port by binding an ephemeral server and reading it back. */
function freePort(host: string): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, host, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => res(port))
    })
  })
}

/** Start a localhost Postgres-wire server backed by PGlite. */
export async function serveWire(opts: ServeWireOptions = {}): Promise<WireServer> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port && opts.port > 0 ? opts.port : await freePort(host)

  let lock: DatadirLock | null = null
  let pglite: PGlite
  if (opts.dataDir) {
    const abs = resolve(opts.dataDir)
    lock = await acquireDatadirLock(abs, { acquireTimeoutMs: opts.acquireTimeoutMs })
    try {
      pglite = await PGlite.create({ dataDir: abs })
    } catch (e) {
      await lock.release()
      throw e
    }
  } else {
    pglite = await PGlite.create()
  }

  const server = new PGLiteSocketServer({
    db: pglite,
    host,
    port,
    maxConnections: opts.maxConnections ?? 100,
  })
  try {
    await server.start()
  } catch (e) {
    await pglite.close()
    if (lock) await lock.release()
    throw e
  }

  let stopped = false
  return {
    url: `postgres://${host}:${port}/postgres`,
    host,
    port,
    pglite,
    async stop() {
      if (stopped) return
      stopped = true
      await server.stop()
      await pglite.close()
      if (lock) await lock.release()
    },
  }
}
