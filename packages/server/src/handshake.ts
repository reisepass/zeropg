// Harvesting PGlite's REAL handshake, instead of synthesizing one.
//
// WHY NOT SYNTHESIZE. A handshake is 15 ParameterStatus messages the client
// caches for the whole session and never re-reads. Guess one wrong and the
// failure is silent: announcing TimeZone=Etc/GMT0 against a backend booted at
// Etc/GMT-1 gives every timestamp a one-hour skew in any driver that renders
// from PQparameterStatus("TimeZone"), with no error anywhere. DateStyle MDY vs
// DMY silently swaps day and month. server_version drives feature gating in
// pgjdbc, Npgsql and pg_dump. There is no reason to guess: the backend will
// tell us, and it costs one protocol round trip at boot.
//
// WHY NOT FORWARD THE CLIENT'S STARTUP PACKET. Verified on this box, PGlite
// 0.5.2: `execProtocolRaw(StartupMessage)` answers with a byte-identical
// 428-byte block regardless of the user, database or application_name in it,
// and a fresh instance answers a bare `Query` correctly with NO startup packet
// ever sent. So PGlite is a single-user backend that is already logged in - the
// startup packet is not an authentication step for it, and there is no
// double-authentication problem to solve, only a duplicate handshake to avoid.
// The router therefore never forwards the client's startup packet.
//
// WHAT WE STRIP AND WHY:
//
//   R  AuthenticationOk   - the router decides authentication, not PGlite. It
//                           emits its own R at the point in ITS state machine
//                           where auth actually succeeded.
//   K  BackendKeyData     - PGlite hardcodes pid=42 secret=2875488 on every
//                           connection of every instance. Replaying that gives
//                           every client on the box identical cancellation key
//                           material. The router generates per-connection
//                           random values instead.
//   Z  ReadyForQuery      - forced to 'I'. The harvest may run while the shared
//                           session is inside a transaction (a warm instance
//                           serving other connections), in which case the real
//                           byte is 'T', and a brand-new client told 'T' would
//                           believe it is already inside a transaction it never
//                           opened. Verified the harvest itself is side-effect
//                           free: taken during an open transaction, the
//                           transaction stays open and a later ROLLBACK still
//                           unwinds correctly.
//
// The 15 ParameterStatus messages pass through byte for byte.
//
// STALENESS. ParameterStatus values drift after boot: a `SET TimeZone` on the
// shared session emits six updates, and PGlite sends them only to the setter,
// so a router replaying a boot snapshot forever would hand later connections a
// value the backend no longer holds. `Handshake.observe()` exists for that:
// feed it ParameterStatus messages seen in the proxied stream and the cached
// block is rewritten, so the next connection gets the current truth.

import {
  AUTHENTICATION_OK,
  decodeParameterStatus,
  encodeBackendKeyData,
  encodeParameterStatus,
  encodeReadyForQuery,
  splitBackendMessages,
} from './wire-messages.js'

/** Encode a protocol-3.0 StartupMessage. Only used to provoke the handshake. */
export function encodeStartupMessage(params: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(k, 'utf8'), Buffer.from([0]), Buffer.from(v, 'utf8'), Buffer.from([0]))
  }
  parts.push(Buffer.from([0]))
  const body = Buffer.concat(parts)
  const out = Buffer.alloc(8 + body.length)
  out.writeInt32BE(8 + body.length, 0)
  out.writeInt32BE(196608, 4) // 3.0
  body.copy(out, 8)
  return out
}

/** The engine surface the harvester needs. Structural so this module never
 *  imports @electric-sql/pglite, which is an optional peer. */
export interface HarvestableEngine {
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>
}

/**
 * PGlite's real handshake, minus the parts the router owns.
 *
 * Immutable except through `observe()`, and cheap to emit: `block()` returns a
 * pre-concatenated Buffer, so serving a connection is one write.
 */
export class Handshake {
  /** ParameterStatus keys in the order the backend sent them. Order is kept
   *  because clients are allowed to depend on receiving them before
   *  ReadyForQuery, and reordering serves no purpose. */
  private readonly order: string[] = []
  private readonly values = new Map<string, string>()
  private cached: Buffer | null = null

  private constructor(order: string[], values: Map<string, string>) {
    this.order = order
    this.values = values
  }

  /**
   * Send one StartupMessage to the engine and keep the ParameterStatus block it
   * answers with. The user and database fields are irrelevant (PGlite discards
   * them) but are filled in so the packet is protocol-legal.
   */
  static async harvest(engine: HarvestableEngine): Promise<Handshake> {
    const raw = await engine.execProtocolRaw(
      encodeStartupMessage({ user: 'zeropg_router', database: 'postgres' }),
    )
    return Handshake.fromBlock(Buffer.from(raw))
  }

  /** Parse an already-captured handshake block. Split out for tests, which must
   *  not need a live 8-second PGlite boot to assert the stripping rules. */
  static fromBlock(block: Buffer): Handshake {
    const order: string[] = []
    const values = new Map<string, string>()
    for (const msg of splitBackendMessages(block)) {
      if (msg.type !== 'S') continue // R, K and Z are stripped; see the header
      const { key, value } = decodeParameterStatus(msg.payload)
      if (!values.has(key)) order.push(key)
      values.set(key, value)
    }
    if (order.length === 0) {
      throw new Error(
        'handshake harvest found no ParameterStatus messages: the engine did not answer a ' +
          'StartupMessage as expected',
      )
    }
    return new Handshake(order, values)
  }

  /** Current value of one announced parameter (e.g. server_version). */
  get(key: string): string | undefined {
    return this.values.get(key)
  }

  get parameterCount(): number {
    return this.order.length
  }

  /** Every announced parameter, in send order. */
  parameters(): Array<{ key: string; value: string }> {
    return this.order.map((k) => ({ key: k, value: this.values.get(k)! }))
  }

  /**
   * Record a ParameterStatus the backend emitted mid-session, so later
   * connections are told the current value rather than the boot-time one.
   * Returns true when the value actually changed.
   */
  observe(key: string, value: string): boolean {
    if (this.values.get(key) === value) return false
    if (!this.values.has(key)) this.order.push(key)
    this.values.set(key, value)
    this.cached = null
    return true
  }

  /** The ParameterStatus block alone, no R / K / Z. */
  block(): Buffer {
    if (!this.cached) {
      this.cached = Buffer.concat(
        this.order.map((k) => encodeParameterStatus(k, this.values.get(k)!)),
      )
    }
    return this.cached
  }

  /**
   * The full block to send one client: AuthenticationOk, the real
   * ParameterStatus messages, per-connection BackendKeyData, and
   * ReadyForQuery('I').
   *
   * `overrides` exist because two of PGlite's own values are wrong and the
   * router knows better: it sends application_name="" even when the client sent
   * one, and session_authorization="" rather than the user name. Both come
   * straight out of the startup packet we parsed.
   */
  forConnection(
    processId: number,
    secretKey: number,
    overrides: Record<string, string> = {},
  ): Buffer {
    const keys = [...this.order]
    for (const k of Object.keys(overrides)) if (!keys.includes(k)) keys.push(k)
    const params = keys.map((k) => encodeParameterStatus(k, overrides[k] ?? this.values.get(k) ?? ''))
    return Buffer.concat([
      AUTHENTICATION_OK,
      ...params,
      encodeBackendKeyData(processId, secretKey),
      encodeReadyForQuery('I'), // forced 'I'; see the header
    ])
  }
}
