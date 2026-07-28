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
  type OpenPhase,
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

/** Total ceiling on a cold-start hold, spec section 4. 30s sits about 3x above
 *  the measured 11s worst-case restore, and a restore that has not landed in
 *  30s is not going to. The reason to cap at all is operator diagnosability: a
 *  stuck bucket should surface as a specific Postgres error in the application
 *  log within half a minute, not as a connection that never answers. A silent
 *  hang is the exact failure mode this work exists to remove, so converting
 *  ECONNREFUSED into an unbounded wait would be a lateral move. */
const DEFAULT_HOLD_MAX_MS = 30_000

/** Ceiling on the LEASING phase alone. Capped separately from restoring because
 *  the two fail for unrelated reasons and want different fixes: a contended
 *  lease is a second writer, a slow restore is a slow bucket. Deliberately well
 *  under the total, since lease acquisition is a couple of object-store round
 *  trips when uncontended, while ZeroPG's own acquireTimeoutMs can be 90s -
 *  long enough that holding a client for it would be worse than failing. */
const DEFAULT_LEASE_HOLD_MS = 10_000

/** SQLSTATE for "the database system is starting up". Real Postgres emits this
 *  same code for the same situation, so every retry layer that already
 *  understands Postgres - pgbouncer, HikariCP, pgx, Prisma, node-postgres' own
 *  error classification - handles it correctly with no new code anywhere.
 *  Inventing a code would forfeit all of that. */
const SQLSTATE_CANNOT_CONNECT_NOW = '57P03'

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
   * COLD-START HOLDING, spec section 4.
   *
   * When true (the default), a connection to a cold database completes its
   * handshake IMMEDIATELY and its first query is held until the database is
   * ready, rather than the connection waiting for the whole cold start before
   * it is told anything.
   *
   * Why the handshake, specifically: ReadyForQuery is where every client
   * library stops its connect-phase timer and starts its query-phase one.
   * node-postgres arms connectionTimeoutMillis on connect and clears it inside
   * _handleReadyForQuery; libpq's PQconnectPoll reaches CONNECTION_OK there.
   * Connect-phase budgets are commonly 5-10s and are what a cold start blows
   * (Prisma's connect_timeout is 5s, which is how a slow restore becomes
   * P1001); query-phase budgets are unbounded by default in libpq, pg, pgx and
   * pgjdbc. Answering the handshake early moves the wait from a budget that is
   * usually too small into one that is usually infinite. Measured with a
   * prototype: node-postgres at library defaults against an 11s restore
   * connected in 4ms and returned correct rows at 10880ms.
   *
   * Set false to make a cold connection wait for the database before it is
   * answered at all.
   */
  holdColdStarts?: boolean
  /** Total ceiling on a cold-start hold, ms. Default 30000. 0 means hold
   *  forever, which some operators prefer; it is not the default because a
   *  silent unbounded hang is exactly the failure mode being removed. */
  holdMaxMs?: number
  /** Ceiling on the leasing phase alone, ms. Default 10000. Must be at most
   *  holdMaxMs, asserted at construction rather than left to chance. */
  leaseHoldMs?: number
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
  /** True once the handshake block has gone out. Under cold-start holding it
   *  goes out BEFORE the database exists, so this is what stops the normal path
   *  from sending a second one and handing the client a duplicate
   *  ReadyForQuery. */
  handshakeSent = false
  /** Milliseconds this connection spent held waiting for a cold start. */
  heldMs = 0

  constructor(readonly socket: Socket) {}
}

export class WireRouter {
  private readonly frontend: WireFrontend
  private readonly catalog: Catalog
  private readonly maxWarm: number
  private readonly startupTimeoutMs: number
  private readonly drainTimeoutMs: number
  private readonly holdColdStarts: boolean
  private readonly holdMaxMs: number
  private readonly leaseHoldMs: number
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
    this.holdColdStarts = opts.holdColdStarts ?? true
    this.holdMaxMs = opts.holdMaxMs ?? DEFAULT_HOLD_MAX_MS
    this.leaseHoldMs = opts.leaseHoldMs ?? DEFAULT_LEASE_HOLD_MS
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000
    this.onLog = opts.onLog ?? (() => {})
    this.now = opts.now ?? (() => performance.now())
    if (this.maxWarm < 1) throw new Error('maxWarm must be at least 1')
    // Assert the relationship rather than trusting the defaults to stay in
    // sync: a leasing cap above the total ceiling means a contended lease
    // silently holds a client for the longer of the two.
    if (this.holdMaxMs > 0 && this.leaseHoldMs > this.holdMaxMs) {
      throw new Error(
        `leaseHoldMs (${this.leaseHoldMs}) must not exceed holdMaxMs (${this.holdMaxMs}): ` +
          'the phase cap cannot outlast the total hold it is part of',
      )
    }
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

      const overrides = {
        // PGlite reports both of these as "" regardless of what the client
        // sent. We parsed the startup packet, so we can be correct.
        application_name: startup.parameters.application_name ?? '',
        session_authorization: startup.user,
      }

      // Warm path: no hold needed, the real handshake is already in hand.
      // Cold path: hold, per spec section 4 and the ceilings above.
      const warm = this.warm.get(startup.database)
      const entry =
        warm && !warm.evicting
          ? warm
          : await this.coldStart(conn, startup, overrides)
      if (conn.closed) {
        // Client hung up during the cold start. Leave the database warm (the
        // next connection benefits) but touch it so LRU does not treat it as
        // ancient.
        entry.lastUsedAt = this.now()
        return
      }
      entry.refs++
      entry.lastUsedAt = this.now()
      conn.entry = entry

      // In the held case coldStart() already sent the handshake, and sending a
      // second would give the client a duplicate ReadyForQuery.
      if (!conn.handshakeSent) {
        conn.handshakeSent = true
        conn.socket.write(entry.handshake.forConnection(conn.processId, conn.secretKey, overrides))
      }
      this.onLog('routed', {
        connection: conn.id,
        database: startup.database,
        user: startup.user,
        warm: this.warm.size,
        held: conn.heldMs > 0 ? Math.round(conn.heldMs) : undefined,
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

  // ---- Cold-start holding (spec section 4) ----

  /**
   * Bring a cold database up while the client believes it is already connected.
   *
   * The order is the load-bearing part:
   *
   *   1. Wait for the LEASING phase to complete, saying nothing. Until the
   *      lease is ours we do not own this database, and answering a handshake
   *      would be asserting something we cannot yet claim. Leasing is fast
   *      (a couple of object-store round trips) and every stack tolerates a
   *      connect that has not completed yet - libpq waits indefinitely,
   *      node-postgres' connectionTimeoutMillis defaults to off, pgx has none.
   *   2. The moment leasing succeeds, send the handshake. The client is now
   *      "connected", and the honest claim behind that is "we own this database
   *      and are materializing it".
   *   3. Hold the client's queries through the restore. They are already
   *      accumulating in conn.buf; nothing is queued into an engine that does
   *      not exist. When ready, pump() runs them in order.
   *
   * Both phases are capped SEPARATELY so the resulting error names the one it
   * died in: "phase=leasing" means a second writer, "phase=restoring" means a
   * slow bucket, and those have nothing to do with each other.
   */
  private async coldStart(
    conn: Connection,
    startup: StartupMessage,
    overrides: Record<string, string>,
  ): Promise<WarmEntry> {
    const t0 = this.now()
    if (!this.holdColdStarts) {
      // Holding off: the client waits for the whole cold start before it is
      // told anything, which is the pre-holding behavior.
      return this.acquire(startup.database)
    }

    // Never hold for a database that does not exist. The catalog answers this
    // instantly, so an unknown name is knowable BEFORE the handshake goes out -
    // and it has to be, because 3D000 after a handshake is a different thing
    // entirely: the driver has already resolved connect() successfully and
    // surfaces the error asynchronously instead of failing the connection.
    // `psql -d typo` must fail the way it does against real Postgres.
    if (!this.catalog(startup.database)) throw new UnknownDatabaseError(startup.database)

    // Nothing to copy a handshake from yet (a fully cold process, first ever
    // connection). Rather than guessing 15 ParameterStatus values - the exact
    // silent-corruption risk handshake.ts exists to remove - fall back to
    // waiting for the real one. The client pays the cold start on its connect
    // budget this once; every connection after it is held properly.
    const template = this.templateHandshake()
    if (!template) {
      this.onLog('cold-start-unheld', { connection: conn.id, database: startup.database })
      return this.acquire(startup.database)
    }

    let phase: OpenPhase = 'admitting'
    // Each phase gets its own clock, so a slow one cannot consume another's
    // budget. The alternative - one running total - made an eviction that took
    // eight seconds to flush report "phase=leasing, 10s elapsed" about a lease
    // that was never contended, which points an operator at the wrong problem.
    let phaseStartedAt = t0
    let leased: (() => void) | null = null
    // Resolves when the source reports it has the lease. A source that never
    // reports phases leaves this pending, and the leasing cap below then
    // effectively covers the whole open, which is the safe direction: the hold
    // is shorter, not longer.
    const leasedPromise = new Promise<void>((res) => {
      leased = res
    })

    const opening = this.acquire(startup.database, (p) => {
      phase = p
      phaseStartedAt = this.now()
      if (p === 'restoring') leased!()
    })
    // Swallowed here only so an early rejection does not surface as an
    // unhandled rejection; `opening` is awaited for real below.
    opening.catch(() => {})

    // Phase 1: leasing. Silent, and capped tighter than the total.
    //
    // The gate races the lease against the open FAILING, so that anything
    // decided before the lease - a full warm set, a fenced lease, a catalog
    // source that refuses outright - reaches the client as a failed connect.
    // Once the handshake is out the client has resolved connect() successfully
    // and any later error arrives asynchronously instead, which is a materially
    // different thing for a pool to handle. Only the RESTORE, which cannot be
    // known quickly, is worth converting into a hold. A successful open that
    // never reported a phase also passes through here, so a source without
    // phase reporting still works.
    //
    // The cap applies per phase, not to the sum: admitting and leasing each get
    // leaseHoldMs, measured from when that phase began.
    await this.raceHold(
      Promise.race([leasedPromise, opening.then(() => undefined)]),
      this.leaseHoldMs,
      () => phase,
      () => phaseStartedAt,
      startup.database,
    )

    // Phase 2: the handshake goes out NOW, before the restore finishes. This is
    // the whole point: ReadyForQuery is where every client stops its
    // connect-phase timer, so the restore is moved out of a 5-10s budget and
    // into one that is unbounded by default.
    if (!conn.closed && !conn.handshakeSent) {
      conn.handshakeSent = true
      conn.socket.write(template.forConnection(conn.processId, conn.secretKey, overrides))
      this.onLog('handshake-early', { connection: conn.id, database: startup.database })
    }

    // Phase 3: hold the client's queries through the restore, capped by the
    // total ceiling measured from the start of the restore. Measuring from t0
    // would let a slow admission eat the restore's budget, which is the same
    // cross-charging the per-phase clock above exists to prevent.
    const restoreStart = phaseStartedAt
    const entry = await this.raceHold(
      opening,
      this.holdMaxMs,
      () => phase,
      () => restoreStart,
      startup.database,
    )
    conn.heldMs = this.now() - t0
    this.onLog('cold-start-held', {
      connection: conn.id,
      database: startup.database,
      heldMs: Math.round(conn.heldMs),
    })
    return entry
  }

  /**
   * Await `work` under a ceiling, converting an overrun into an error that
   * names the phase and the elapsed time.
   *
   * The timeout does NOT cancel the work: the database keeps coming up and the
   * next connection gets it warm. Only this client's wait ends. Cancelling
   * would throw away a restore that is nearly done and make the next client pay
   * for it again.
   */
  private async raceHold<T>(
    work: Promise<T>,
    ms: number,
    phase: () => string,
    startedAt: () => number,
    database: string,
  ): Promise<T> {
    if (ms <= 0) return work // 0 means hold forever, per holdMaxMs
    // Re-arm rather than fire once: the deadline belongs to the CURRENT phase,
    // and a phase transition moves it. A single timer would charge whichever
    // phase happened to be running at its expiry for time the previous one
    // spent.
    for (;;) {
      const startedWhen = startedAt()
      const currentPhase = phase()
      const remaining = ms - (this.now() - startedWhen)
      if (remaining <= 0) {
        throw new HoldExpiredError(database, currentPhase, Math.round(this.now() - startedWhen))
      }
      let timer: NodeJS.Timeout | undefined
      const expired = Symbol('expired')
      const result = await Promise.race([
        work,
        new Promise<typeof expired>((res) => {
          timer = setTimeout(() => res(expired), remaining)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
      if (result !== expired) return result as T
      // Timer fired. If the phase moved on underneath us, the new phase gets
      // its own full budget; otherwise this really is an overrun.
      if (phase() === currentPhase && startedAt() === startedWhen) {
        throw new HoldExpiredError(database, currentPhase, Math.round(this.now() - startedWhen))
      }
    }
  }

  /**
   * A handshake block to send a client whose database is not up yet, or null if
   * this process has never harvested one.
   *
   * Copied from a resident database rather than synthesized. That is sound here
   * for a specific reason: every PGlite instance in one process answers with the
   * same block - same WASM build so the same server_version, same process TZ so
   * the same TimeZone, and the other thirteen values are constants. It is the
   * same backend software either way. What would NOT be sound is guessing the
   * values, which is the silent-corruption risk handshake.ts exists to remove:
   * a wrong TimeZone is a one-hour skew with no error anywhere.
   *
   * The router still keeps the harvested-per-database block for steady state,
   * so any drift observed on the real instance reaches later connections.
   */
  private templateHandshake(): Handshake | null {
    for (const entry of this.warm.values()) return entry.handshake
    return this.lastHandshake
  }

  /** The most recent handshake harvested in this process, kept after its
   *  database is evicted so a cold start still has a template. */
  private lastHandshake: Handshake | null = null

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
    if (e instanceof HoldExpiredError) {
      // 57P03 cannot_connect_now, which is what real Postgres emits for "the
      // database system is starting up". Every Postgres-aware retry layer
      // already handles it.
      this.onLog('hold-expired', {
        connection: conn.id,
        database,
        phase: e.phase,
        elapsedMs: e.elapsedMs,
      })
      this.fail(conn, SQLSTATE_CANNOT_CONNECT_NOW, e.message)
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

  /** Resolve a name to a resident instance, starting it if needed.
   *
   *  `onPhase` is only invoked when this call is the one that actually opens
   *  the instance. A caller that joins an open already in flight, or finds the
   *  database warm, never hears from it - correctly, since it is not paying for
   *  those phases. */
  private async acquire(
    database: string,
    onPhase?: (phase: OpenPhase) => void,
  ): Promise<WarmEntry> {
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
      // Making room means draining and FLUSHING another database to the object
      // store, which is real work on a real network and has nothing to do with
      // this database's lease. Reported as its own phase so a held client's
      // leasing cap is not charged for it, and so a hold that expires here says
      // "admitting" rather than blaming a lease that was never contended.
      onPhase?.('admitting')
      await this.makeRoom(database)
    }
    onPhase?.('leasing')

    const open = (async (): Promise<WarmEntry> => {
      const t0 = this.now()
      const instance = await source.open(onPhase)
      const queue = new QueryQueue(instance.engine)
      const handshake = await Handshake.harvest(instance.engine)
      // Kept after this database is evicted so a later cold start still has a
      // real block to hand a held client, instead of guessing 15 values.
      this.lastHandshake = handshake
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

/**
 * A cold-start hold ran past its ceiling. Answered with 57P03
 * cannot_connect_now.
 *
 * The message names the PHASE deliberately: "phase=leasing" tells an operator
 * another writer holds this database, "phase=restoring" tells them the bucket is
 * slow. Those have completely different fixes, and one merged timeout would
 * force them to guess which they were looking at.
 */
export class HoldExpiredError extends Error {
  constructor(
    readonly database: string,
    readonly phase: string,
    readonly elapsedMs: number,
  ) {
    super(
      `the database system is starting up (database="${database}", phase=${phase}, ` +
        `${Math.round(elapsedMs / 100) / 10}s elapsed)`,
    )
    this.name = 'HoldExpiredError'
  }
}
