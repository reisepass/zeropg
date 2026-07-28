// Local real-wire mode (docs/ORM-ADAPTER-NOTES.md §1 — "the single biggest
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

import type { PGlite } from '@electric-sql/pglite'
import { resolve } from 'node:path'
// Deep import, NOT the '@zeropg/server' barrel: the barrel re-exports
// ZeroPGServer, which pulls @zeropg/objectstore-fs and with it a hard
// @electric-sql/pglite import. Importing it here would make merely loading
// @zeropg/client fail for a postgres://-only project that has no PGlite
// installed. wire-frontend.js depends on nothing but node:net.
import { WireFrontend } from '@zeropg/server/wire-frontend'
import { acquireDatadirLock, type DatadirLock } from './lockfile.js'
import { loadPGlite, nativeDatadirLockEnabled } from './pglite.js'
import { recordOpen } from './breadcrumb.js'

// @electric-sql/pglite-socket is an OPTIONAL peer: only `serveWire` needs it, and
// it is loaded on demand so merely importing @zeropg/client (for memory:// /
// file://) never requires it to be installed. Loaded lazily with an actionable
// error if the wire feature is used without the dep present.
async function loadSocketServer(): Promise<
  new (cfg: { db: PGlite; host: string; port: number; maxConnections: number }) => {
    start(): Promise<void>
    stop(): Promise<void>
  }
> {
  try {
    return (await import('@electric-sql/pglite-socket')).PGLiteSocketServer as never
  } catch {
    throw new Error(
      'serveWire() requires the optional peer dependency @electric-sql/pglite-socket. ' +
        'Install it: npm i @electric-sql/pglite-socket',
    )
  }
}

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
  /** PGlite contrib/extension modules to load into the engine, e.g.
   * `{ citext, pgcrypto }` from `@electric-sql/pglite/contrib/*`. Required for
   * schemas that use those types (a real Prisma app like Rallly needs citext +
   * pgcrypto). Passed straight to `PGlite.create({ extensions })`. */
  extensions?: Record<string, unknown>
  /** The PGlite build already takes its own datadir lock (the fork) — skip the
   * wrapper lock so the two don't fight over `<datadir>.lock`. See
   * {@link ConnectOptions.nativeDatadirLock}. Also honored via
   * ZEROPG_NATIVE_DATADIR_LOCK=1 and the PGlite `managesDataDirLock` marker. */
  nativeDatadirLock?: boolean
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

/** Start a localhost Postgres-wire server backed by PGlite. */
export async function serveWire(opts: ServeWireOptions = {}): Promise<WireServer> {
  const host = opts.host ?? '127.0.0.1'
  // Load before nativeDatadirLockEnabled(), which reads a marker off the build.
  const PGliteClass = await loadPGlite()

  let lock: DatadirLock | null = null
  let pglite: PGlite
  if (opts.dataDir) {
    const abs = resolve(opts.dataDir)
    // Stand down when PGlite locks the datadir itself (see connectFile).
    lock = nativeDatadirLockEnabled(opts)
      ? null
      : await acquireDatadirLock(abs, { acquireTimeoutMs: opts.acquireTimeoutMs })
    try {
      pglite = await PGliteClass.create({ dataDir: abs, extensions: opts.extensions as never })
    } catch (e) {
      if (lock) await lock.release()
      throw e
    }
    recordOpen(abs)
  } else {
    pglite = await PGliteClass.create({ extensions: opts.extensions as never })
  }

  const PGLiteSocketServer = await loadSocketServer()
  // The front-end owns the public port and answers SSLRequest/GSSENCRequest (see
  // WireFrontend). Without it, libpq/pgx at their default sslmode=prefer hang:
  // pglite-socket does not implement SSL negotiation. The inner PGLiteSocketServer
  // is bound by the front-end on a private loopback port.
  const server = new WireFrontend({
    host,
    port: opts.port && opts.port > 0 ? opts.port : 0,
    createInner: (cfg) =>
      new PGLiteSocketServer({
        db: pglite,
        host: cfg.host,
        port: cfg.port,
        maxConnections: opts.maxConnections ?? 100,
      }),
  })
  try {
    await server.start()
  } catch (e) {
    await pglite.close()
    if (lock) await lock.release()
    throw e
  }
  const port = server.port

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
