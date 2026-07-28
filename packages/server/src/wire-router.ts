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

/** How long eviction waits for a message already inside the engine to finish.
 *  Short, because it only covers ONE in-flight protocol message, not a whole
 *  client session. Overrunning it aborts the eviction rather than flushing
 *  underneath a write that is still landing. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

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
  /**
   * How long eviction waits for the victim's in-flight engine message to
   * finish before giving up on it. Default 5000. Exceeding it aborts that
   * eviction (the database stays warm) rather than flushing under a write.
   */
  drainTimeoutMs?: number
  /**
   * Background flush cadence for raw-wire writes, milliseconds. Default 5000,
   * matching ZeroPGServer's wireFlushTimer.
   *
   * This timer is not optional bookkeeping, it is the ONLY thing that makes a
   * wire write durable. Wire messages reach PGlite directly and never pass
   * through ZeroPG.query()/exec(), so they never set the dirty flag a durable
   * commit is gated on. Set to 0 only in tests that mean to race it.
   */
  flushIntervalMs?: number
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
  private readonly drainTimeoutMs: number
  private readonly flushIntervalMs: number
  private flushTimer: NodeJS.Timeout | null = null
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
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000
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
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => void this.flushAll(), this.flushIntervalMs)
      this.flushTimer.unref?.()
    }
    this.onLog('router-listening', { port: this.port, maxWarm: this.maxWarm })
  }

  /**
   * Commit every warm database that has pending writes.
   *
   * Section 6.5 of the spec: the wire path needs a background timer and the
   * HTTP path does not. Raw-wire writes bypass ZeroPG.query()/exec() and with
   * them the dirty flag that gates a durable commit, so without this they sit
   * in a WASM heap that a close, a crash, or an eviction can take with it.
   */
  private async flushAll(): Promise<void> {
    for (const entry of [...this.warm.values()]) {
      if (entry.evicting) continue // its own eviction owns the flush
      try {
        if (entry.instance.pendingWrites && !(await entry.instance.pendingWrites())) continue
        await entry.instance.flush()
      } catch (e) {
        this.onLog('flush-failed', {
          database: entry.name,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
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
    for (;;) {
      const existing = this.warm.get(database)
      // An entry being evicted is not attachable: its lease is about to go.
      // Wait for the eviction to finish, then loop and start a fresh instance.
      if (existing && !existing.evicting) return existing
      if (existing) {
        await this.evictions.get(database)?.catch(() => {})
        continue
      }
      const inFlight = this.opening.get(database)
      if (inFlight) return inFlight
      break
    }

    const source = this.catalog(database)
    if (!source) throw new UnknownDatabaseError(database)

    while (this.warm.size + this.opening.size >= this.maxWarm) {
      await this.makeRoom(database)
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

  // ---- Eviction (spec section 5): the step that can lose data ----

  /** Evictions in progress, by database name. */
  private readonly evictions = new Map<string, Promise<void>>()

  /**
   * Free one slot for `wanted`, or throw WarmSetFullError.
   *
   * LRU order, but a failed flush is NOT a failed admission: section 5 says
   * refusing to evict is always better than losing writes, so a victim whose
   * flush fails stays warm and the next-least-recently-used one is tried
   * instead. Only when every candidate has been tried does admission fail, and
   * then it fails in protocol rather than by evicting something unsafely.
   */
  private async makeRoom(wanted: string): Promise<void> {
    const candidates = [...this.warm.values()]
      .filter((e) => !e.evicting)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)

    const refused: string[] = []
    for (const victim of candidates) {
      try {
        await this.evict(victim, `making room for "${wanted}"`)
        return
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        refused.push(`${victim.name} (${msg})`)
        this.onLog('eviction-refused', { database: victim.name, wanted, error: msg })
      }
    }

    // Nothing could be evicted. Either something else is already evicting (in
    // which case waiting is right) or every candidate refused.
    const inFlight = [...this.evictions.values()]
    if (inFlight.length && refused.length === 0) {
      await Promise.allSettled(inFlight)
      return
    }
    throw new WarmSetFullError(
      wanted,
      this.maxWarm,
      refused.length
        ? `no resident database could be evicted safely: ${refused.join('; ')}`
        : `${[...this.warm.keys(), ...this.opening.keys()].join(', ')} ${
            this.warm.size + this.opening.size === 1 ? 'is' : 'are'
          } already resident`,
    )
  }

  /**
   * The eviction protocol, spec section 5, in order and with no steps skipped.
   *
   *   1. Stop accepting new connections for that database.
   *   2. Drain or forcibly fail in-flight connections with 57P01 admin_shutdown.
   *   3. Flush and CONFIRM it committed.
   *   4. Release the lease.
   *   5. Close the instance and free the memory.
   *
   * If step 3 fails, do NOT proceed: the entry is restored to service and the
   * caller picks a different victim. This is not defensive style, it is the
   * whole point. Eviction is a lease handoff, and taking the lease from an
   * awake sleep-durability instance is a live-verified way to drop its
   * unflushed writes. Raw-wire writes are exactly the writes at risk, because
   * they never pass through ZeroPG.query()/exec() and so never set the dirty
   * flag; only the background timer or this flush commits them.
   */
  private async evict(entry: WarmEntry, reason: string): Promise<void> {
    const existing = this.evictions.get(entry.name)
    if (existing) return existing

    const run = (async (): Promise<void> => {
      const t0 = this.now()
      // 1. Stop accepting new connections for that database. Set FIRST, before
      //    anything destructive, so a connection arriving mid-eviction waits
      //    for a fresh instance instead of attaching to a doomed lease.
      entry.evicting = true

      // 2. Drain or forcibly fail in-flight connections with admin_shutdown.
      //    Queued messages are rejected rather than executed: running them
      //    against an instance that is about to close would either lose their
      //    results or, worse, apply writes after the flush that is supposed to
      //    capture everything.
      const attached = [...this.connections].filter((c) => c.entry === entry)
      entry.queue.clearAll(`database "${entry.name}" is being evicted`)
      for (const conn of attached) {
        this.fail(
          conn,
          '57P01', // admin_shutdown
          `terminating connection: database "${entry.name}" is being unloaded from this router (${reason})`,
        )
        conn.entry = null
        entry.refs--
      }
      //    A message already inside execProtocolRawStream cannot be cancelled.
      //    Wait it out, and treat a timeout as a refusal: flushing under a write
      //    that is still landing is precisely the race this protocol exists to
      //    prevent.
      try {
        await entry.queue.whenIdle(this.drainTimeoutMs)
      } catch (e) {
        entry.evicting = false
        throw new Error(`drain failed: ${e instanceof Error ? e.message : String(e)}`)
      }

      // 3. Flush and CONFIRM. A rejection here aborts the eviction.
      try {
        await entry.instance.flush()
        entry.lastFlushError = null
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        entry.lastFlushError = msg
        entry.evicting = false
        entry.lastUsedAt = this.now() // do not immediately re-pick this victim
        this.onLog('eviction-flush-failed', { database: entry.name, reason, error: msg })
        throw new Error(`flush failed, refusing to evict: ${msg}`)
      }

      // 4 + 5. Only now: release the lease and free the memory. close() on the
      //        ZeroPG source does both, in that order.
      this.warm.delete(entry.name)
      try {
        await entry.instance.close()
      } catch (e) {
        // The flush already committed, so the data is safe in the bucket. A
        // failed close leaks memory and possibly a lease until it expires,
        // which is worth logging but is not a correctness problem.
        this.onLog('eviction-close-failed', {
          database: entry.name,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      this.onLog('evicted', {
        database: entry.name,
        reason,
        ms: Math.round(this.now() - t0),
        connectionsTerminated: attached.length,
      })
    })()

    this.evictions.set(entry.name, run)
    try {
      await run
    } finally {
      this.evictions.delete(entry.name)
    }
  }

  /** Evict a database by name. Returns false when it is not resident. Exposed
   *  so an operator (or a test) can force the protocol without waiting for LRU
   *  pressure. Throws if the flush fails, exactly as the LRU path does. */
  async evictDatabase(name: string, reason = 'requested'): Promise<boolean> {
    const entry = this.warm.get(name)
    if (!entry) return false
    await this.evict(entry, reason)
    return true
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
    // An evicting entry has already failed this connection with 57P01 and
    // cleared its queue; queuing more would execute against an instance whose
    // flush has been taken.
    if (!entry || conn.closed || entry.evicting) return
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
    // Null when the connection was never routed, or when eviction already
    // detached it (which decremented refs then). Either way there is no
    // reference of ours left to release.
    if (!entry) return
    conn.entry = null
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
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
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
