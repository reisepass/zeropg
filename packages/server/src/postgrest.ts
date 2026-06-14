// PostgREST manager: spawns the single static Haskell binary pointed at our
// LOCAL Postgres wire port (the pglite-socket server), so a remote app gets an
// auto-generated REST API over the PGlite database for free. PostgREST is ON by
// default; set ZEROPG_POSTGREST=off to skip it entirely and save the RSS the RAM
// experiment measures (results/standalone-*.jsonl).
//
// FUTURE (do NOT build now): the only reason this server carries a ~?MB Haskell
// binary is the auto-REST surface. If the measured RAM/footprint cost is not
// worth it, a JS reimplementation of the PostgREST-style "table -> REST" mapping
// (introspect schema over the wire port, serve /<table> with filter/order/limit)
// would drop the binary and the extra process. The RAM delta recorded by the
// experiment is the input to that decision.

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface PostgrestOptions {
  /** Path to the postgrest binary. */
  bin: string
  /** Local Postgres wire port PostgREST connects to (the pglite-socket server). */
  wirePort: number
  /** Wire host (default 127.0.0.1). */
  wireHost?: string
  /** Postgres role PostgREST authenticates as (PGlite superuser). */
  dbUser?: string
  /** Database name in the connection string. */
  dbName?: string
  /** Port PostgREST serves its REST API on (local; we reverse-proxy to it). */
  restPort: number
  /** Schemas to expose. */
  schemas?: string
  /** Role used for anonymous (unauthenticated) requests. */
  anonRole?: string
  /** Log sink for the child's stdout/stderr. */
  onLog?: (line: string) => void
}

export class PostgrestProcess {
  private child: ChildProcess | null = null
  readonly restPort: number
  private readonly opts: Required<Omit<PostgrestOptions, 'onLog'>> & Pick<PostgrestOptions, 'onLog'>

  constructor(opts: PostgrestOptions) {
    this.restPort = opts.restPort
    this.opts = {
      bin: opts.bin,
      wirePort: opts.wirePort,
      wireHost: opts.wireHost ?? '127.0.0.1',
      dbUser: opts.dbUser ?? 'postgres',
      dbName: opts.dbName ?? 'postgres',
      restPort: opts.restPort,
      schemas: opts.schemas ?? 'public',
      anonRole: opts.anonRole ?? 'anon',
      onLog: opts.onLog,
    }
  }

  /** The PostgREST child PID, for RSS measurement (null when not running). */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Resident set size of the PostgREST process in bytes (linux /proc), or 0. */
  rssBytes(): number {
    const pid = this.pid
    if (pid == null) return 0
    try {
      // /proc/<pid>/statm: field 2 is resident pages.
      const pages = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1])
      return pages * 4096
    } catch {
      return 0
    }
  }

  start(): void {
    const o = this.opts
    // PostgREST reads its whole config from env (PGRST_*), no config file needed.
    // No password: pglite-socket accepts any startup and there is exactly one
    // (single-writer) database behind it.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // sslmode=disable is REQUIRED: pglite-socket (0.2.x) does not implement the
      // SSLRequest/GSSENCRequest negotiation, so a default libpq client (which
      // probes for TLS first) sends an 8-byte SSLRequest the socket buffers as an
      // "incomplete message" and the connection deadlocks. Disabling TLS makes
      // libpq send the StartupMessage straight away. (Loopback only — no TLS loss.)
      PGRST_DB_URI: `postgres://${o.dbUser}@${o.wireHost}:${o.wirePort}/${o.dbName}?sslmode=disable`,
      PGRST_DB_SCHEMAS: o.schemas,
      PGRST_DB_ANON_ROLE: o.anonRole,
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: String(o.restPort),
      // PGlite is a single in-process session multiplexed by pglite-socket. A pool
      // of 1 matches that (PGlite runs one query at a time anyway) and avoids
      // cross-connection session state surprises.
      PGRST_DB_POOL: '1',
      PGRST_DB_POOL_ACQUISITION_TIMEOUT: '10',
      // Prepared statements are keyed per session, but every pooled connection
      // lands on the SAME PGlite session via the multiplexer, so libpq's auto
      // prepared statements collide ("prepared statement \"0\" already exists",
      // 42P05). Turn them off — exactly the connection-pooler-in-transaction-mode
      // guidance PostgREST itself prints for this error.
      PGRST_DB_PREPARED_STATEMENTS: 'false',
      PGRST_LOG_LEVEL: 'error',
    }
    this.child = spawn(o.bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const pipe = (buf: Buffer) => {
      const s = buf.toString().trimEnd()
      if (s) o.onLog?.(s)
    }
    this.child.stdout?.on('data', pipe)
    this.child.stderr?.on('data', pipe)
    this.child.on('exit', (code, sig) => {
      o.onLog?.(`postgrest exited code=${code} signal=${sig}`)
      this.child = null
    })
  }

  /** Poll the REST port until PostgREST answers (schema cache loaded). */
  async waitReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastErr = 'timeout'
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('postgrest exited before becoming ready')
      try {
        // Root returns the OpenAPI description once the schema cache is built.
        const res = await fetch(`http://127.0.0.1:${this.restPort}/`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.status < 500) return
        lastErr = `status ${res.status}`
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`postgrest not ready after ${timeoutMs}ms: ${lastErr}`)
  }

  /** Tell PostgREST to re-introspect the schema (SIGUSR1) so tables/columns
   *  created after startup appear under /rest without a restart. */
  reloadSchema(): void {
    this.child?.kill('SIGUSR1')
  }

  async stop(): Promise<void> {
    const c = this.child
    if (!c) return
    this.child = null
    await new Promise<void>((resolve) => {
      c.once('exit', () => resolve())
      c.kill('SIGTERM')
      setTimeout(() => {
        c.kill('SIGKILL')
        resolve()
      }, 2000).unref?.()
    })
  }
}

/** SQL that makes PostgREST's role model work on a fresh PGlite database: an
 *  anonymous role with full CRUD on the public schema (demo-grade — wide open).
 *  Idempotent; run on every boot after restore. */
export function postgrestBootstrapSql(anonRole = 'anon'): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${anonRole}') THEN
    CREATE ROLE ${anonRole} NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO ${anonRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${anonRole};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${anonRole};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${anonRole};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${anonRole};
`.trim()
}
