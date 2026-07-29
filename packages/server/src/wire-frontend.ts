// SSL/GSSENC negotiation front-end for the PGlite Postgres wire.
//
// THE PROBLEM: @electric-sql/pglite-socket (0.2.x) does not implement Postgres'
// SSL/GSSENC negotiation. A libpq/pgx client at its DEFAULT sslmode=prefer opens
// the connection and first sends an 8-byte SSLRequest (int32 length=8, int32
// code=80877103) before any StartupMessage. pglite-socket buffers those 8 bytes
// as if they were the head of a StartupMessage and never replies, so the client
// hangs silently until timeout. Same for GSSENCRequest (code 80877104). Every
// consumer had to remember ?sslmode=disable / PGSSLMODE=disable, and forgetting
// gave a silent hang with no error - the worst possible failure mode.
//
// THE FIX: a tiny TCP front-end owns the public port and peeks the first 8 bytes
// of each connection.
//   - SSLRequest / GSSENCRequest  -> reply a single 'N' (not supported), then
//     continue the SAME socket as plaintext. libpq at sslmode=prefer falls back
//     to plaintext and re-sends a real StartupMessage; at sslmode=require it
//     errors cleanly instead of hanging (the correct outcome, not a regression).
//   - anything else               -> it is already a StartupMessage (or a
//     CancelRequest); the bytes are forwarded untouched.
// The socket is then piped to a PGLiteSocketServer bound on a private loopback
// port. The public port callers connect to is this front-end's port.
//
// Framing hazards handled: the SSLRequest and the StartupMessage may arrive in
// the same TCP segment, and conversely the 8 request bytes may arrive split
// across segments. We buffer until we have 8 bytes before deciding, forward any
// already-read remainder, and never drop bytes.

import { createServer, connect, type Server, type Socket } from 'node:net'

const SSL_REQUEST_CODE = 80877103
const GSSENC_REQUEST_CODE = 80877104

/** The subset of PGLiteSocketServer this front-end drives. */
export interface InnerSocketServer {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface WireFrontendOptions {
  /** Host to bind the public listener. Default 127.0.0.1. */
  host?: string
  /** Public port to bind. 0 / omitted picks a free port (read back via `.port`). */
  port?: number
  /** Build the inner PGLiteSocketServer, already targeted at a private loopback
   *  port this front-end chose. Kept as a factory so this module never needs to
   *  import the optional @electric-sql/pglite-socket dependency itself.
   *
   *  Mutually exclusive with `onConnection`: either the front-end proxies to an
   *  inner server, or the caller terminates the protocol itself. */
  createInner?: (cfg: { host: string; port: number }) => InnerSocketServer
  /**
   * Terminate the protocol in-process instead of proxying to an inner server.
   * Called once per connection, after SSL/GSSENC negotiation and after the
   * connection cap has been checked and its slot taken, with the bytes already
   * read from the socket (the StartupMessage, possibly partial, possibly with
   * more behind it).
   *
   * The socket arrives PAUSED so no bytes can be lost in the gap: the callee
   * must attach its own 'data' listener and resume it. The slot is released on
   * socket close, so the callee does not have to.
   *
   * This is what the wire router uses. Routing by database name requires
   * reading the StartupMessage, and a proxy to a single inner server has
   * already chosen the database before it can read one.
   */
  onConnection?: (client: Socket, pending: Buffer) => void
  /** Max concurrent client connections. Over-cap connections are refused with a
   *  real ErrorResponse (SQLSTATE 53300). Must match the inner server's own
   *  maxConnections so the cap is enforced HERE, where we can speak protocol,
   *  rather than by the inner server, which cannot. */
  maxConnections?: number
  /** Name used in the over-cap message to tell the operator which knob to turn
   *  (e.g. 'maxConnections'). */
  limitOptionName?: string
  /** Limit quoted in the over-cap message. Defaults to maxConnections, but a
   *  caller that reserves slots for itself should report the USER-VISIBLE budget
   *  instead: ZeroPGServer adds PostgREST's pool to the enforced cap, and
   *  quoting that sum would name a number the user never configured. */
  reportedLimit?: number
}

/**
 * Encode a Postgres ErrorResponse ('E'). pglite-socket's own over-cap path
 * writes the raw string "Too many connections\n" and ends the socket, which is
 * not protocol: libpq reports "server closed the connection unexpectedly" and
 * node-postgres reports "Connection terminated unexpectedly", both of which read
 * like the server crashed. A real ErrorResponse gives the client a SQLSTATE and
 * a message it can print.
 *
 * Wire format: 'E', int32 length, then NUL-terminated (fieldCode, value) pairs,
 * terminated by a zero byte. S/V severity, C SQLSTATE, M message are the fields
 * every driver reads.
 */
function errorResponse(severity: string, code: string, message: string): Buffer {
  const fields = [
    ['S', severity],
    ['V', severity],
    ['C', code],
    ['M', message],
  ] as const
  const parts: Buffer[] = []
  for (const [key, value] of fields) {
    parts.push(Buffer.from(key, 'ascii'), Buffer.from(value, 'utf8'), Buffer.from([0]))
  }
  parts.push(Buffer.from([0])) // end of field list
  const body = Buffer.concat(parts)
  const out = Buffer.alloc(5 + body.length)
  out.write('E', 0, 'ascii')
  out.writeInt32BE(4 + body.length, 1) // length covers itself, not the type byte
  body.copy(out, 5)
  return out
}

/** Pick a free TCP port by binding an ephemeral server and reading it back. */
function freePort(host: string): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, host, () => {
      const addr = s.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => res(p))
    })
  })
}

/**
 * A Postgres-wire front-end that answers SSL/GSSENC negotiation with 'N' and
 * proxies plaintext to an inner PGLiteSocketServer on a private loopback port.
 * The reported `.port` is the public port callers connect to.
 */
export class WireFrontend {
  private readonly host: string
  private readonly requestedPort: number
  private readonly createInner: WireFrontendOptions['createInner']
  private readonly onConnection: WireFrontendOptions['onConnection']

  private readonly maxConnections: number
  private readonly limitOptionName: string
  private readonly reportedLimit: number

  private front: Server | null = null
  private inner: InnerSocketServer | null = null
  private innerPort = 0
  private boundPort = 0
  private readonly conns = new Set<Socket>()
  /** Connections that got past the cap and were handed to the inner server.
   *  Counted separately from `conns`: a socket still negotiating has not taken
   *  a slot yet, and one refused over-cap never takes one. */
  private live = 0
  private stopped = false

  constructor(opts: WireFrontendOptions) {
    this.host = opts.host ?? '127.0.0.1'
    this.requestedPort = opts.port && opts.port > 0 ? opts.port : 0
    this.createInner = opts.createInner
    this.onConnection = opts.onConnection
    if (!this.createInner === !this.onConnection) {
      throw new Error(
        'WireFrontend needs exactly one of createInner (proxy to an inner socket server) or ' +
          'onConnection (terminate the protocol in-process)',
      )
    }
    this.maxConnections = opts.maxConnections ?? 100
    this.limitOptionName = opts.limitOptionName ?? 'maxConnections'
    this.reportedLimit = opts.reportedLimit ?? this.maxConnections
  }

  /** Connections currently held against the cap. */
  get activeConnections(): number {
    return this.live
  }

  /** The public port callers connect to (valid after start()). */
  get port(): number {
    return this.boundPort
  }

  async start(): Promise<void> {
    // Inner PGLiteSocketServer on a private loopback port. Its own maxConnections
    // still governs concurrency since every front-end connection maps to exactly
    // one inner connection. Skipped entirely in onConnection mode, where nothing
    // is proxied and no private port is needed.
    if (this.createInner) {
      this.innerPort = await freePort('127.0.0.1')
      this.inner = this.createInner({ host: '127.0.0.1', port: this.innerPort })
      await this.inner.start()
    }

    // Public front-end listener.
    const front = createServer((client) => this.handleConnection(client))
    this.front = front
    try {
      await new Promise<void>((res, rej) => {
        front.once('error', rej)
        front.listen(this.requestedPort, this.host, () => {
          front.removeListener('error', rej)
          res()
        })
      })
    } catch (e) {
      // Inner came up but the public bind failed: don't leak the inner listener.
      await this.inner?.stop().catch(() => {})
      this.inner = null
      throw e
    }
    const addr = front.address()
    this.boundPort = typeof addr === 'object' && addr ? addr.port : this.requestedPort
  }

  private handleConnection(client: Socket): void {
    this.conns.add(client)
    client.once('close', () => this.conns.delete(client))
    client.on('error', () => client.destroy())

    let buf: Buffer = Buffer.alloc(0)
    let decided = false

    const onData = (chunk: Buffer): void => {
      if (decided) return
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      // Consume any leading SSL/GSSENC negotiation packets.
      while (!decided) {
        if (buf.length < 8) return // need more bytes before deciding
        const len = buf.readInt32BE(0)
        const code = buf.readInt32BE(4)
        if (len === 8 && (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE)) {
          buf = buf.subarray(8)
          client.write(Buffer.from('N')) // SSL/GSS not supported; fall back to plaintext
          continue // a further negotiation packet, or the StartupMessage, may follow
        }
        // Not a negotiation packet: it is a StartupMessage (or CancelRequest).
        // Hand the connection - plus the bytes we already read - to the inner server.
        decided = true
        this.handoff(client, buf, onData)
        return
      }
    }

    client.on('data', onData)
  }

  private handoff(client: Socket, pending: Buffer, onData: (c: Buffer) => void): void {
    // Hold the client while we dial the inner server so no bytes are emitted and
    // lost in the gap. The paused internal buffer is released, in order and after
    // our manual write of `pending`, once we pipe below.
    client.pause()
    client.removeListener('data', onData)

    // Enforce the cap HERE rather than letting the inner server do it. Its own
    // over-cap path writes a raw non-protocol string, which surfaces to clients
    // as "server closed the connection unexpectedly" / "Connection terminated
    // unexpectedly" - indistinguishable from a crash. We own the public port, so
    // we can answer in protocol. Checked after negotiation because the client is
    // only ready to parse an ErrorResponse once it has stopped expecting an
    // SSL negotiation byte.
    if (this.live >= this.maxConnections) {
      client.write(
        errorResponse(
          'FATAL',
          '53300', // too_many_connections
          `too many connections for this zeropg instance (limit ${this.reportedLimit}). ` +
            `Close idle connections, lower your pool size, or raise the ${this.limitOptionName} option.`,
        ),
      )
      client.end()
      return
    }

    this.live++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.live--
    }
    client.once('close', release)

    // In-process termination (the wire router): hand over the paused socket and
    // the bytes already read. The callee resumes it.
    if (this.onConnection) {
      this.onConnection(client, pending)
      return
    }

    const inner = connect({ host: '127.0.0.1', port: this.innerPort })

    let torn = false
    const teardown = (): void => {
      if (torn) return
      torn = true
      client.destroy()
      inner.destroy()
    }
    inner.on('error', teardown)
    client.on('error', teardown)
    inner.on('close', teardown)
    client.on('close', teardown)

    inner.once('connect', () => {
      if (pending.length) inner.write(pending)
      // Bidirectional plaintext proxy. pipe() resumes the client and propagates
      // end/close in both directions.
      client.pipe(inner)
      inner.pipe(client)
      client.resume()
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Close the public listener first so no new connections arrive.
    if (this.front) {
      await new Promise<void>((res) => this.front!.close(() => res()))
      this.front = null
    }
    for (const c of this.conns) c.destroy()
    this.conns.clear()
    // Then the inner server, which frees the private loopback port.
    if (this.inner) {
      await this.inner.stop()
      this.inner = null
    }
  }
}
