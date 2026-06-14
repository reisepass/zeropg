// ZeroPGServer — a STANDALONE "dedicated Postgres instance": one scale-to-zero
// container that holds the writer lease + PGlite + the object-storage durable
// home (ZeroPG), and exposes faces a *remote* app connects to. This is pure
// composition over the existing engine — no new storage logic.
//
// Faces, all inside this one container:
//   1. Storage core      — ZeroPG (ObjectStoreFS + lease + PGlite). Single
//                          writer = this server.
//   2. Wire protocol     — @electric-sql/pglite-socket exposes the SAME PGlite
//                          instance over the REAL Postgres wire protocol on a
//                          LOCAL TCP port. On Cloud Run / Code Engine this stays
//                          loopback-only (those platforms are HTTP-only and can
//                          NOT accept raw 5432); it is what makes the server
//                          Fly-ready for raw libpq later, and what PostgREST
//                          talks to here and now.
//   3. PostgREST (default-on) — pointed at the local wire port -> an auto REST
//                          API per schema, reverse-proxied under /rest on the
//                          single public HTTP port. ZEROPG_POSTGREST=off skips it.
//   4. HTTP control face — /wake (warm the instance), /ready (restore progress),
//                          POST /sql (SQL over HTTP), /metrics. The single public
//                          port multiplexes these + the /rest proxy, so the whole
//                          thing fits an HTTP-only serverless platform.
//
// A remote client calls /wake, polls /ready, then queries via /rest or POST /sql.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BlobStore } from '@zeropg/blobstore'
import { ZeroPG, FencedError, LockedError, type Durability } from '@zeropg/objectstore-fs'
import { PostgrestProcess, postgrestBootstrapSql } from './postgrest.js'

let PGLiteSocketServer: typeof import('@electric-sql/pglite-socket').PGLiteSocketServer

export type BootPhase = 'init' | 'restoring' | 'wire' | 'postgrest' | 'ready' | 'error'

export interface ZeroPGServerOptions {
  store: BlobStore
  /** Public HTTP port (control face + /rest proxy). Default 8080 / $PORT. */
  port?: number
  /** Local Postgres wire-protocol port. Default 5432. */
  wirePort?: number
  /** Host the wire server binds to. Default 127.0.0.1 (loopback) — correct for
   *  HTTP-only platforms (Cloud Run / Code Engine) where raw 5432 is never
   *  exposed. Set to 0.0.0.0 on Fly.io where the proxy forwards a public TCP
   *  port to it. */
  wireHost?: string
  /** Local PostgREST port (loopback; reverse-proxied under /rest). Default 3000. */
  restPort?: number
  /** Lease holder id (instance identity). */
  holder?: string
  durability?: Durability
  leaseTtlMs?: number
  acquireTimeoutMs?: number
  /** Empty-datadir seed snapshot (skips initdb on a fresh DB). */
  seedSnapshot?: Uint8Array
  /** Idempotent app schema SQL run once after restore (before PostgREST starts). */
  schemaSql?: string
  /** Turn PostgREST on (default) or off. */
  postgrest?: boolean
  /** Path to the postgrest binary (default 'postgrest' on PATH). */
  postgrestBin?: string
  /** Schemas PostgREST exposes. Default 'public'. */
  restSchemas?: string
  /** Human label for the landing page / metrics. */
  label?: string
}

interface BootTimings {
  restoreMs: number
  wireMs: number
  postgrestMs: number
  totalMs: number
}

export class ZeroPGServer {
  private db: ZeroPG | null = null
  private wire: import('@electric-sql/pglite-socket').PGLiteSocketServer | null = null
  private pgrest: PostgrestProcess | null = null
  private http: Server | null = null

  private phase: BootPhase = 'init'
  private bootError: string | null = null
  private readyMs = 0
  private requestsServed = 0
  private bootTimings: BootTimings = { restoreMs: 0, wireMs: 0, postgrestMs: 0, totalMs: 0 }

  readonly opts: Required<
    Pick<
      ZeroPGServerOptions,
      'port' | 'wirePort' | 'wireHost' | 'restPort' | 'postgrest' | 'postgrestBin' | 'restSchemas' | 'label'
    >
  > &
    ZeroPGServerOptions
  private readonly processStart = performance.now()

  private constructor(opts: ZeroPGServerOptions) {
    this.opts = {
      ...opts,
      port: opts.port ?? Number(process.env.PORT ?? 8080),
      wirePort: opts.wirePort ?? Number(process.env.ZEROPG_WIRE_PORT ?? 5432),
      wireHost: opts.wireHost ?? process.env.ZEROPG_WIRE_HOST ?? '127.0.0.1',
      restPort: opts.restPort ?? Number(process.env.ZEROPG_REST_PORT ?? 3000),
      postgrest: opts.postgrest ?? !/^(off|false|0)$/i.test(process.env.ZEROPG_POSTGREST ?? ''),
      postgrestBin: opts.postgrestBin ?? process.env.ZEROPG_POSTGREST_BIN ?? 'postgrest',
      restSchemas: opts.restSchemas ?? process.env.ZEROPG_REST_SCHEMAS ?? 'public',
      label: opts.label ?? process.env.APP_LABEL ?? 'zeropg standalone',
    }
  }

  /** Construct, start the HTTP face immediately (so /wake + /ready answer during
   *  cold start), and kick off DB restore + wire + PostgREST in the background. */
  static async start(opts: ZeroPGServerOptions): Promise<ZeroPGServer> {
    const srv = new ZeroPGServer(opts)
    srv.listen()
    void srv.boot()
    return srv
  }

  private log(event: string, extra: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ event, ...extra }))
  }

  private async boot(): Promise<void> {
    const o = this.opts
    try {
      this.phase = 'restoring'
      const t0 = performance.now()
      this.db = await ZeroPG.open({
        store: o.store,
        holder: o.holder ?? `standalone-${process.pid}`,
        durability: o.durability ?? 'sleep',
        leaseTtlMs: o.leaseTtlMs ?? 60_000,
        acquireTimeoutMs: o.acquireTimeoutMs ?? 90_000,
        seedSnapshot: o.seedSnapshot,
      })
      this.bootTimings.restoreMs = performance.now() - t0
      this.log('db-open', { restoreMs: Math.round(this.bootTimings.restoreMs), boot: this.db.bootTimings })

      if (o.schemaSql) await this.db.raw.exec(o.schemaSql)
      if (o.postgrest) await this.db.raw.exec(postgrestBootstrapSql())

      // 2. Wire protocol over a LOCAL TCP port (loopback). Fly-ready; here it is
      //    what PostgREST connects to.
      this.phase = 'wire'
      const tw = performance.now()
      if (!PGLiteSocketServer) {
        ;({ PGLiteSocketServer } = await import('@electric-sql/pglite-socket'))
      }
      this.wire = new PGLiteSocketServer({
        db: this.db.raw,
        port: o.wirePort,
        host: o.wireHost,
        // PostgREST opens a small pool; allow several concurrent loopback conns.
        maxConnections: 10,
      })
      await this.wire.start()
      this.bootTimings.wireMs = performance.now() - tw
      this.log('wire-up', { port: o.wirePort, ms: Math.round(this.bootTimings.wireMs) })

      // 3. PostgREST, default-on, pointed at the wire port.
      if (o.postgrest) {
        this.phase = 'postgrest'
        const tp = performance.now()
        this.pgrest = new PostgrestProcess({
          bin: o.postgrestBin,
          wirePort: o.wirePort,
          restPort: o.restPort,
          schemas: o.restSchemas,
          onLog: (line) => this.log('postgrest', { line }),
        })
        this.pgrest.start()
        await this.pgrest.waitReady()
        this.bootTimings.postgrestMs = performance.now() - tp
        this.log('postgrest-up', { port: o.restPort, ms: Math.round(this.bootTimings.postgrestMs) })
      }

      this.phase = 'ready'
      this.readyMs = performance.now() - this.processStart
      this.bootTimings.totalMs = this.readyMs
      this.log('ready', { readyMs: Math.round(this.readyMs), postgrest: o.postgrest, timings: this.bootTimings })
    } catch (e) {
      this.phase = 'error'
      this.bootError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      this.log('boot-error', { error: this.bootError })
    }
  }

  // ---- HTTP face ----

  private listen() {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e) =>
        this.json(res, 500, { error: e instanceof Error ? e.message : String(e) }),
      )
    })
    this.http.listen(this.opts.port, () => this.log('listening', { port: this.opts.port }))
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    const s = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
    res.end(s)
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  private readinessBody() {
    return {
      ready: this.phase === 'ready',
      phase: this.phase,
      error: this.bootError,
      readyMs: this.phase === 'ready' ? Math.round(this.readyMs) : null,
      postgrest: this.opts.postgrest,
      restBasePath: this.opts.postgrest ? '/rest' : null,
      bootTimings: this.phase === 'ready' ? this.bootTimings : undefined,
      restore: this.db?.bootTimings,
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // Health — cheap, no DB, does not count as a served request.
    if (path === '/up' || path === '/healthz') {
      return this.json(res, this.phase === 'error' ? 503 : 200, {
        ok: this.phase === 'ready',
        phase: this.phase,
      })
    }

    // /wake — a remote client calls this first. The HTTP request itself already
    // woke this instance from zero; we just report readiness so the client can
    // start polling /ready. (Boot auto-starts at process start.)
    if (path === '/wake') {
      return this.json(res, 200, { woke: true, ...this.readinessBody() })
    }

    // /ready — restore/boot progress so a remote client polls until ready.
    if (path === '/ready') {
      return this.json(res, this.phase === 'ready' ? 200 : 503, this.readinessBody())
    }

    this.requestsServed++

    if (path === '/metrics') return this.metrics(res)

    // SQL over HTTP — kept alongside the wire + REST faces.
    if (path === '/sql' && req.method === 'POST') return this.sql(req, res)

    // PostgREST reverse proxy: everything under /rest -> the local PostgREST.
    if (path === '/rest' || path.startsWith('/rest/')) return this.proxyRest(req, res, url)

    if (path === '/' || path === '') return this.landing(res)

    return this.json(res, 404, { error: 'not found' })
  }

  private async sql(req: IncomingMessage, res: ServerResponse) {
    if (!this.db) return this.json(res, 503, this.readinessBody())
    const raw = (await this.readBody(req)).toString()
    try {
      const { sql } = JSON.parse(raw) as { sql: string }
      const t0 = performance.now()
      const r = await this.db.query(sql)
      // DDL changes the schema PostgREST introspected at startup; nudge it to
      // reload its cache so new tables/columns appear under /rest immediately.
      if (this.pgrest && /\b(create|alter|drop|grant|revoke|comment)\b/i.test(sql)) {
        this.pgrest.reloadSchema()
      }
      return this.json(res, 200, {
        rows: r.rows,
        ms: Math.round((performance.now() - t0) * 100) / 100,
        execMs: Math.round(r.execMs * 100) / 100,
        commit: r.commit,
        durability: this.db.durabilityMode,
      })
    } catch (e) {
      const status = e instanceof FencedError || e instanceof LockedError ? 423 : 400
      return this.json(res, status, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async proxyRest(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!this.opts.postgrest) return this.json(res, 404, { error: 'postgrest disabled (ZEROPG_POSTGREST=off)' })
    if (this.phase !== 'ready' || !this.pgrest) return this.json(res, 503, this.readinessBody())
    // Strip the /rest prefix; PostgREST serves at its own root.
    const rest = url.pathname.slice('/rest'.length) || '/'
    const target = `http://127.0.0.1:${this.opts.restPort}${rest}${url.search}`
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue
      const lk = k.toLowerCase()
      if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? undefined : await this.readBody(req)
    try {
      const upstream = await fetch(target, {
        method,
        headers,
        body: body && body.length ? body : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      const outHeaders: Record<string, string> = {}
      upstream.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'content-length') return
        outHeaders[key] = value
      })
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(upstream.status, outHeaders)
      res.end(buf)
    } catch (e) {
      this.json(res, 502, { error: `rest proxy: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  private async metrics(res: ServerResponse) {
    const mem = process.memoryUsage()
    const pgrestRss = this.pgrest?.rssBytes() ?? 0
    let dbBytes = '0'
    if (this.db) {
      try {
        const sz = await this.db.raw.query<{ b: string }>(
          'SELECT pg_database_size(current_database())::text b',
        )
        dbBytes = sz.rows[0]?.b ?? '0'
      } catch {
        /* ignore */
      }
    }
    return this.json(res, 200, {
      label: this.opts.label,
      phase: this.phase,
      readyMs: this.phase === 'ready' ? Math.round(this.readyMs) : null,
      requestsServed: this.requestsServed,
      postgrest: this.opts.postgrest,
      durability: this.db?.durabilityMode ?? null,
      pendingFlush: this.db?.pendingFlush ?? false,
      fencingToken: this.db?.fencingToken ?? null,
      dbBytes,
      // RAM split: the Node writer process vs the PostgREST Haskell process. The
      // standalone experiment compares serverRssMB with PostgREST on vs off.
      serverRssMB: Math.round(mem.rss / 1e6),
      postgrestRssMB: Math.round(pgrestRss / 1e6),
      totalRssMB: Math.round((mem.rss + pgrestRss) / 1e6),
      bootTimings: this.phase === 'ready' ? this.bootTimings : null,
    })
  }

  private landing(res: ServerResponse) {
    const o = this.opts
    const restLine = o.postgrest
      ? `REST (PostgREST): GET ${'<this-url>'}/rest/<table>`
      : `REST disabled (ZEROPG_POSTGREST=off)`
    const body = `${o.label} — zeropg standalone dedicated Postgres

A real Postgres (PGlite) whose durable home is an object-storage bucket, in one
scale-to-zero container. A remote app connects over HTTP.

Faces:
  Wake:  GET  /wake            (call first; the request wakes the instance)
  Ready: GET  /ready           (poll until {"ready":true})
  SQL:   POST /sql  {"sql":"…"}
  ${restLine}
  Metrics: GET /metrics

Wire protocol (real Postgres, libpq) is bound to loopback for Fly.io / raw TCP
later; this HTTP-only platform exposes the faces above.
`
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
  }

  /** Flush + release lease + stop child/socket. Called on SIGTERM. */
  async shutdown(): Promise<void> {
    try {
      await this.pgrest?.stop()
    } catch {
      /* ignore */
    }
    try {
      await this.wire?.stop()
    } catch {
      /* ignore */
    }
    try {
      if (this.db) await this.db.close() // sleep-mode flush + lease release
    } catch (e) {
      this.log('shutdown-flush-failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Wire SIGTERM/SIGINT to a graceful flush + lease release, then exit. */
  installSignalHandlers() {
    const onSig = (signal: string) => {
      this.log('shutdown', { signal, pendingFlush: this.db?.pendingFlush ?? false })
      void this.shutdown().finally(() => process.exit(0))
    }
    process.on('SIGTERM', () => onSig('SIGTERM'))
    process.on('SIGINT', () => onSig('SIGINT'))
  }
}
