// The wire router: one TCP port, many databases, routed by the `database` field
// of the Postgres StartupMessage.
//
// Step 1 of docs/SPEC-wire-router.md section 8. What it does, in order:
//
//   1. WireFrontend owns the public port and answers SSLRequest/GSSENCRequest.
//   2. This module parses the StartupMessage (packages/server/src/startup-packet.ts).
//   3. It resolves `database` to a placement. Local only for now: known name ->
//      warm or start here; unknown name -> ErrorResponse 3D000
//      invalid_catalog_name, which is what a real Postgres answers.
//   4. It emits PGlite's REAL harvested handshake (see handshake.ts), never the
//      client's startup packet forwarded on and never a synthesized block.
//   5. Every subsequent frontend message goes through the per-instance
//      QueryQueue so transactions on the shared PGlite session stay isolated.
//
// WHY THE STARTUP PACKET IS NOT FORWARDED. Verified against PGlite 0.5.2 on
// this box: it answers a StartupMessage with a byte-identical 428-byte block no
// matter what user/database/application_name the packet carries, and a fresh
// instance answers a bare Query correctly with no startup packet ever sent. It
// is a single-user backend that is already logged in. Forwarding the client's
// packet would produce a SECOND handshake on the wire after ours - a duplicate
// ReadyForQuery, which desynchronizes any pipelining client - and would buy
// nothing, since PGlite discards every field in it.

import type { Socket } from 'node:net'
import { randomInt } from 'node:crypto'
import {
  parseStartupPacket,
  PROTOCOL_3_0,
  type StartupMessage,
} from './startup-packet.js'
import {
  decodeParameterStatus,
  encodeNegotiateProtocolVersion,
  fatalErrorResponse,
  splitBackendMessages,
} from './wire-messages.js'
import { Handshake } from './handshake.js'
import { QueryQueue } from './wire-queue.js'
import { WireFrontend } from './wire-frontend.js'
import {
  WarmEntry,
  WarmSetFullError,
  type Catalog,
  type RoutedInstance,
} from './warm-set.js'

/** Highest protocol minor version this router speaks. PGlite is a 3.0 backend. */
const NEWEST_PROTOCOL_MINOR = 0

/** Guard against a client that never finishes its StartupMessage: without it a
 *  half-open socket holds a connection slot forever. Postgres calls this
 *  authentication_timeout and defaults it to 60s. */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000

export interface WireRouterOptions {
  /** Resolve a database name to a source, or null for "no such database". */
  catalog: Catalog
  /** Public host to bind. Default 127.0.0.1. */
  host?: string
  /** Public port. 0 / omitted picks a free one (read back via `.port`). */
  port?: number
  /** Max concurrent client connections across ALL databases. */
  maxConnections?: number
  /**
   * How many databases stay resident at once. Capacity is counted in INSTANCES:
   * PGlite's resident memory is roughly constant per instance (about 400 MB on
   * Linux) and nearly independent of database size, so this is a flat count and
   * not a byte budget. Default 1.
   */
  maxWarm?: number
  /** Milliseconds a connection may take to send a complete StartupMessage. */
  startupTimeoutMs?: number
  /** Structured log sink. Defaults to silence. */
  onLog?: (event: string, fields: Record<string, unknown>) => void
  /** Injectable monotonic clock (tests / LRU determinism). */
  now?: () => number
}

/** One attached client connection. */
class Connection {
  static nextId = 1
  readonly id = Connection.nextId++
  /** Per-connection cancellation key material. NOT PGlite's hardcoded
   *  pid=42/secret=2875488, which is identical on every connection ever made. */
  readonly processId = randomInt(1, 0x7fffffff)
  readonly secretKey = randomInt(1, 0x7fffffff)
  entry: WarmEntry | null = null
  /** Frontend bytes not yet split into whole messages. */
  buf: Buffer = Buffer.alloc(0)
  closed = false

  constructor(readonly socket: Socket) {}
}

export class WireRouter {
  private readonly frontend: WireFrontend
  private readonly catalog: Catalog
  private readonly maxWarm: number
  private readonly startupTimeoutMs: number
  private readonly onLog: (event: string, fields: Record<string, unknown>) => void
  private readonly now: () => number

  /** Resident databases, by name. */
  private readonly warm = new Map<string, WarmEntry>()
  /** In-flight opens, so two connections racing for the same cold database
   *  produce one instance rather than two writers fighting over one lease. */
  private readonly opening = new Map<string, Promise<WarmEntry>>()
  private readonly connections = new Set<Connection>()
  private stopped = false

  constructor(opts: WireRouterOptions) {
    this.catalog = opts.catalog
    this.maxWarm = opts.maxWarm ?? 1
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.onLog = opts.onLog ?? (() => {})
    this.now = opts.now ?? (() => performance.now())
    if (this.maxWarm < 1) throw new Error('maxWarm must be at least 1')
    this.frontend = new WireFrontend({
      host: opts.host,
      port: opts.port,
      maxConnections: opts.maxConnections,
      limitOptionName: 'maxConnections',
      onConnection: (client, pending) => this.accept(client, pending),
    })
  }

  /** Public port callers connect to (valid after start()). */
  get port(): number {
    return this.frontend.port
  }

  /** Names of the databases currently resident, most recently used last. */
  get warmDatabases(): string[] {
    return [...this.warm.values()]
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .map((e) => e.name)
  }

  async start(): Promise<void> {
    await this.frontend.start()
    this.onLog('router-listening', { port: this.port, maxWarm: this.maxWarm })
  }

  // ---- Connection handling ----

  private accept(socket: Socket, pending: Buffer): void {
    const conn = new Connection(socket)
    this.connections.add(conn)

    // authentication_timeout: a client that connects and never completes its
    // StartupMessage must not hold a connection slot indefinitely.
    const timer = setTimeout(() => {
      if (conn.entry) return // already routed; the timeout only covers startup
      this.fail(conn, '08P01', `no complete startup packet within ${this.startupTimeoutMs}ms`)
    }, this.startupTimeoutMs)
    timer.unref?.()

    const cleanup = (): void => {
      clearTimeout(timer)
      void this.detach(conn)
    }
    socket.once('close', cleanup)
    socket.on('error', () => socket.destroy())

    socket.on('data', (chunk: Buffer) => {
      conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk
      // Serialized: routing is async, and a second chunk arriving mid-route
      // must not start a second route. Once entry is set we are in steady
      // state and pump() is what drains.
      if (!conn.entry) {
        if (!this.routing.has(conn)) void this.route(conn).finally(() => clearTimeout(timer))
        return
      }
      this.pump(conn)
    })

    // The frontend hands the socket over paused with whatever it already read.
    if (pending.length) conn.buf = pending
    socket.resume()
    if (conn.buf.length) void this.route(conn).finally(() => clearTimeout(timer))
  }

  /** Connections with a route in flight, so a second data chunk does not start
   *  a second one. */
  private readonly routing = new Set<Connection>()

  private async route(conn: Connection): Promise<void> {
    if (conn.entry || conn.closed || this.routing.has(conn)) return
    const parsed = parseStartupPacket(conn.buf)
    if (parsed.kind === 'need-more') return
    if (parsed.kind === 'error') {
      this.fail(conn, parsed.sqlstate, parsed.message)
      return
    }
    if (parsed.kind === 'cancel-request') {
      // Cancellation is not implementable against PGlite today: there is no
      // cancel path into the WASM backend, and statement_timeout is inert
      // there. Closing without a reply is protocol-legal - the protocol says a
      // CancelRequest gets no response of any kind - and is honest, where
      // pretending to cancel would not be.
      this.onLog('cancel-request-ignored', { processId: parsed.processId })
      conn.socket.end()
      return
    }
    if (parsed.kind === 'ssl-request' || parsed.kind === 'gssenc-request') {
      // WireFrontend consumes these before handing the socket over, so seeing
      // one here means a client sent a second after negotiation completed.
      this.fail(conn, '08P01', 'unexpected SSL/GSS negotiation request after the connection was negotiated')
      return
    }

    const startup: StartupMessage = parsed
    conn.buf = conn.buf.subarray(startup.length)
    this.routing.add(conn)
    try {
      // Protocol minor above ours: tell the client what we will actually speak,
      // before the handshake. Silence would leave a 3.2 client assuming 3.2
      // semantics against a 3.0 backend.
      if (startup.protocol !== PROTOCOL_3_0 && startup.protocolMajor === 3) {
        conn.socket.write(encodeNegotiateProtocolVersion(NEWEST_PROTOCOL_MINOR))
      }

      const entry = await this.acquire(startup.database)
      if (conn.closed) {
        // Client hung up during a cold start. Undo the reference we are about
        // to not take, so the entry is evictable again.
        entry.lastUsedAt = this.now()
        return
      }
      entry.refs++
      entry.lastUsedAt = this.now()
      conn.entry = entry

      conn.socket.write(
        entry.handshake.forConnection(conn.processId, conn.secretKey, {
          // PGlite reports both of these as "" regardless of what the client
          // sent. We parsed the startup packet, so we can be correct.
          application_name: startup.parameters.application_name ?? '',
          session_authorization: startup.user,
        }),
      )
      this.onLog('routed', {
        connection: conn.id,
        database: startup.database,
        user: startup.user,
        warm: this.warm.size,
      })
      // Anything the client pipelined behind its startup packet is already in
      // conn.buf and must run now: no further 'data' event is guaranteed.
      this.pump(conn)
    } catch (e) {
      this.failFromError(conn, startup.database, e)
    } finally {
      this.routing.delete(conn)
    }
  }

  /** Turn a placement failure into the right protocol-legal ErrorResponse. */
  private failFromError(conn: Connection, database: string, e: unknown): void {
    if (e instanceof UnknownDatabaseError) {
      this.fail(conn, '3D000', e.message)
      return
    }
    if (e instanceof WarmSetFullError) {
      this.fail(conn, e.sqlstate, e.message)
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    this.onLog('route-failed', { connection: conn.id, database, error: msg })
    // 08006 connection_failure: the database exists but could not be brought up.
    this.fail(conn, '08006', `could not start database "${database}": ${msg}`)
  }

  /** Send a FATAL ErrorResponse and close. Never just drop the socket: a bare
   *  disconnect is reported by every client as "server closed the connection
   *  unexpectedly", which reads like a crash. */
  private fail(conn: Connection, sqlstate: string, message: string): void {
    if (conn.closed) return
    conn.closed = true
    try {
      conn.socket.write(fatalErrorResponse(sqlstate, message))
    } catch {
      // Socket already gone; nothing to report to.
    }
    conn.socket.end()
  }

  // ---- Placement ----

  /** Resolve a name to a resident instance, starting it if needed. */
  private async acquire(database: string): Promise<WarmEntry> {
    const existing = this.warm.get(database)
    if (existing) return existing

    const inFlight = this.opening.get(database)
    if (inFlight) return inFlight

    const source = this.catalog(database)
    if (!source) throw new UnknownDatabaseError(database)

    if (this.warm.size + this.opening.size >= this.maxWarm) {
      // Warm set > 1 with the full eviction protocol is step 2 of the build
      // order. Until then, refuse in protocol rather than evict unsafely:
      // eviction is a lease handoff and taking the lease from an awake
      // sleep-durability instance drops its unflushed writes.
      throw new WarmSetFullError(
        database,
        this.maxWarm,
        `${[...this.warm.keys(), ...this.opening.keys()].join(', ')} ${
          this.warm.size + this.opening.size === 1 ? 'is' : 'are'
        } already resident`,
      )
    }

    const open = (async (): Promise<WarmEntry> => {
      const t0 = this.now()
      const instance = await source.open()
      const queue = new QueryQueue(instance.engine)
      const handshake = await Handshake.harvest(instance.engine)
      const entry = new WarmEntry(database, instance, queue, handshake, this.now)
      this.warm.set(database, entry)
      this.onLog('database-warm', {
        database,
        ms: Math.round(this.now() - t0),
        serverVersion: handshake.get('server_version'),
        parameters: handshake.parameterCount,
      })
      return entry
    })()
    this.opening.set(database, open)
    try {
      return await open
    } finally {
      this.opening.delete(database)
    }
  }

  // ---- Steady state ----

  /**
   * Split whole frontend messages out of the buffer and queue them.
   *
   * Framing: every frontend message after the startup packet is
   * `type byte + int32 length`, where the length covers itself but not the type
   * byte, so a message occupies `1 + length` bytes.
   */
  private pump(conn: Connection): void {
    const entry = conn.entry
    if (!entry || conn.closed) return
    for (;;) {
      if (conn.buf.length < 5) return
      const len = conn.buf.readInt32BE(1)
      if (len < 4) {
        this.fail(conn, '08P01', `invalid message length ${len}`)
        return
      }
      const total = 1 + len
      if (conn.buf.length < total) return
      const msg = conn.buf.subarray(0, total)
      conn.buf = conn.buf.subarray(total)

      const type = String.fromCharCode(msg[0]!)
      if (type === 'X') {
        // Terminate. Roll back an abandoned transaction before the socket dies,
        // or the shared session stays inside it and starves every other client.
        void entry.queue.rollbackIfOwned(conn.id).finally(() => conn.socket.end())
        return
      }

      entry.lastUsedAt = this.now()
      void entry.queue
        .enqueue(conn.id, msg, (data) => this.forward(conn, entry, data))
        .catch((e) => {
          if (conn.closed) return
          const m = e instanceof Error ? e.message : String(e)
          this.fail(conn, '58000', `query failed on the backend: ${m}`)
        })
    }
  }

  /** Write backend bytes to the client, watching for ParameterStatus updates on
   *  the way past so the cached handshake does not go stale. */
  private forward(conn: Connection, entry: WarmEntry, data: Uint8Array): void {
    const buf = Buffer.from(data)
    // ParameterStatus values drift after boot: a single `SET TimeZone` emits
    // six of them, and PGlite sends them only to the setter. Left unobserved,
    // the next connection would be handed the boot-time value and would render
    // timestamps against a timezone the backend no longer holds - silent, with
    // no error anywhere.
    if (buf.includes(0x53 /* 'S' */)) {
      for (const m of splitBackendMessages(buf)) {
        if (m.type !== 'S') continue
        const { key, value } = decodeParameterStatus(m.payload)
        if (entry.handshake.observe(key, value)) {
          this.onLog('parameter-drift', { database: entry.name, key, value })
        }
      }
    }
    if (!conn.closed && conn.socket.writable) conn.socket.write(buf)
  }

  private async detach(conn: Connection): Promise<void> {
    if (!this.connections.delete(conn)) return
    conn.closed = true
    const entry = conn.entry
    if (!entry) return
    entry.queue.clearForHandler(conn.id)
    // A client that disconnects inside BEGIN leaves the SHARED session in an
    // open transaction. No later handler could ever end it, and the queue's
    // transaction-affinity rule would then make every other connection wait
    // forever, so unwind it here.
    await entry.queue.rollbackIfOwned(conn.id)
    entry.refs--
    entry.lastUsedAt = this.now()
  }

  // ---- Shutdown ----

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.frontend.stop()
    for (const conn of [...this.connections]) conn.socket.destroy()
    this.connections.clear()
    for (const entry of this.warm.values()) {
      // Flush before close, for the same reason eviction does: raw-wire writes
      // bypass ZeroPG.query()/exec() and so bypass the dirty flag. A close that
      // skipped this would drop them.
      try {
        await entry.instance.flush()
      } catch (e) {
        this.onLog('shutdown-flush-failed', {
          database: entry.name,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      await entry.instance.close().catch(() => {})
    }
    this.warm.clear()
  }
}

/** No database of that name. Answered with 3D000 invalid_catalog_name, which is
 *  exactly what a real Postgres says for `psql -d nope`. */
export class UnknownDatabaseError extends Error {
  constructor(readonly database: string) {
    super(`database "${database}" does not exist`)
    this.name = 'UnknownDatabaseError'
  }
}
