// Postgres StartupMessage parser.
//
// WHY THIS IS NEW CODE. To route a connection to a database by name, something
// has to read the `database` field out of the StartupMessage. Nothing in the
// stack we build on does:
//
//   - PGlite DISCARDS it. Two startup packets with different `user` and
//     different `database` produce byte-identical 429-byte responses. It is a
//     single-user backend that is already logged in.
//   - pglite-socket NEVER PARSES it. The only protocol field it reads is
//     `readInt32BE(4) === 196608`; everything else is forwarded as opaque bytes.
//
// So this parser is the load-bearing piece of the router, and it is the reason
// the wire frontend work is justified independently of TLS and SCRAM (both of
// which are theater on loopback; routing is theater nowhere).
//
// WIRE FORMAT (protocol 3.x). No message-type byte - the StartupMessage is the
// one frontend message that leads with its length:
//
//   int32  length          (covers itself; the whole packet)
//   int32  protocol        (major << 16 | minor; 3.0 == 196608)
//   then NUL-terminated key/value string pairs, terminated by a single NUL:
//   "user\0alice\0database\0app\0options\0-c x=y\0\0"
//
// Four other packets arrive in the same position and are NOT StartupMessages.
// They are distinguished only by the value in the protocol slot, which is why
// this parser returns a discriminated union rather than throwing on them:
//
//   80877103  SSLRequest       len 8
//   80877104  GSSENCRequest    len 8
//   80877102  CancelRequest    len 16, then int32 pid, int32 secret
//   1234.5679 (unused here)
//
// HOSTILE INPUT IS THE NORMAL CASE. This parser sits on a public TCP port and
// sees the first bytes any peer chooses to send, before authentication. Every
// length is attacker-controlled. The rules below are therefore not defensive
// style, they are the contract:
//
//   - A declared length is never trusted as an allocation size. It is range
//     checked against MAX_STARTUP_PACKET_LENGTH first (Postgres itself uses
//     10000 bytes; we match it).
//   - Reading is never allowed past the declared packet end, so a missing final
//     NUL cannot walk into adjacent heap.
//   - Incomplete input is a distinct result from invalid input. `need-more`
//     means "call me again with more bytes"; a caller that treats it as an
//     error hangs the client, and a caller that treats an error as `need-more`
//     buffers forever. They must not be conflated.

/** Postgres' own PQ_STARTUP_MSG_LENGTH_MAX (src/include/libpq/pqcomm.h). A
 *  StartupMessage larger than this is refused before anything is allocated. */
export const MAX_STARTUP_PACKET_LENGTH = 10000

export const PROTOCOL_3_0 = 196608
export const SSL_REQUEST_CODE = 80877103
export const GSSENC_REQUEST_CODE = 80877104
export const CANCEL_REQUEST_CODE = 80877102

/** A parsed 3.x StartupMessage. */
export interface StartupMessage {
  kind: 'startup'
  /** Total bytes consumed from the input buffer. */
  length: number
  /** Raw protocol number as sent, e.g. 196608 for 3.0, 196659 for 3.3. */
  protocol: number
  protocolMajor: number
  protocolMinor: number
  /** The `user` parameter. Required by the protocol; absent is a parse error. */
  user: string
  /** The `database` parameter. Postgres defaults it to `user` when the client
   *  omits it, and libpq relies on that default, so we apply it here rather
   *  than making every caller remember to. */
  database: string
  /** Every key/value pair as sent, including `user` and `database`. */
  parameters: Record<string, string>
}

export interface SslRequest {
  kind: 'ssl-request'
  length: 8
}

export interface GssEncRequest {
  kind: 'gssenc-request'
  length: 8
}

export interface CancelRequest {
  kind: 'cancel-request'
  length: 16
  processId: number
  secretKey: number
}

/** Not enough bytes yet. Not an error: buffer more and call again. */
export interface NeedMore {
  kind: 'need-more'
}

/** Malformed or refused. The connection cannot proceed. `sqlstate` is the code
 *  to put in the ErrorResponse; `message` is safe to show a client. */
export interface StartupParseError {
  kind: 'error'
  sqlstate: string
  message: string
}

export type StartupParseResult =
  | StartupMessage
  | SslRequest
  | GssEncRequest
  | CancelRequest
  | NeedMore
  | StartupParseError

const err = (sqlstate: string, message: string): StartupParseError => ({
  kind: 'error',
  sqlstate,
  message,
})

/**
 * Parse the first packet of a Postgres connection.
 *
 * Returns `need-more` when `buf` does not yet hold the whole packet - the
 * caller must buffer and retry, and must NOT treat that as a failure. Returns
 * `error` for anything malformed; that is terminal.
 *
 * Never throws on any input, including truncated, oversized, or random bytes.
 */
export function parseStartupPacket(buf: Buffer): StartupParseResult {
  // The length prefix itself is 4 bytes, and the code/protocol is 4 more.
  // Below 8 bytes nothing can be decided: SSLRequest is exactly 8.
  if (buf.length < 8) return { kind: 'need-more' }

  const length = buf.readInt32BE(0)
  const code = buf.readInt32BE(4)

  // Fixed-shape negotiation packets. Checked BEFORE the generic length
  // validation because their lengths are exact constants, and matching on the
  // code alone (as pglite-socket effectively does) would accept a packet whose
  // declared length disagrees with its own format.
  if (code === SSL_REQUEST_CODE) {
    if (length !== 8) return err('08P01', `SSLRequest must be 8 bytes, got length ${length}`)
    return { kind: 'ssl-request', length: 8 }
  }
  if (code === GSSENC_REQUEST_CODE) {
    if (length !== 8) return err('08P01', `GSSENCRequest must be 8 bytes, got length ${length}`)
    return { kind: 'gssenc-request', length: 8 }
  }
  if (code === CANCEL_REQUEST_CODE) {
    if (length !== 16) return err('08P01', `CancelRequest must be 16 bytes, got length ${length}`)
    if (buf.length < 16) return { kind: 'need-more' }
    return {
      kind: 'cancel-request',
      length: 16,
      processId: buf.readInt32BE(8),
      secretKey: buf.readInt32BE(12),
    }
  }

  // From here it must be a StartupMessage. Validate the length BEFORE using it
  // for anything: it is the first attacker-controlled number we see.
  //
  // The minimum legal StartupMessage is 4 (length) + 4 (protocol) + 1 (the
  // terminating NUL of an empty parameter list) = 9. A 3.0 client always sends
  // `user`, so 9 never appears in practice, but accepting it here and failing
  // on the missing `user` below produces a far better error message than a
  // length complaint would.
  if (length < 9) {
    return err('08P01', `startup packet length ${length} is too small to be a StartupMessage`)
  }
  if (length > MAX_STARTUP_PACKET_LENGTH) {
    return err(
      '08P01',
      `startup packet length ${length} exceeds the maximum of ${MAX_STARTUP_PACKET_LENGTH} bytes`,
    )
  }
  // Only now, with length known sane, do we ask for the rest of it.
  if (buf.length < length) return { kind: 'need-more' }

  const protocolMajor = (code >> 16) & 0xffff
  const protocolMinor = code & 0xffff
  if (protocolMajor !== 3) {
    // Protocol 2 clients (and garbage that happens to decode as one) get a
    // clear refusal rather than a hang. 3.x MINOR versions are deliberately
    // NOT rejected here: the protocol says a server that does not support a
    // minor version answers NegotiateProtocolVersion and continues at 3.0, so
    // that decision belongs to the caller, not to the parser.
    return err(
      '08P01',
      `unsupported frontend protocol ${protocolMajor}.${protocolMinor}: server supports 3.0 to 3.${protocolMinor > 0 ? protocolMinor : 0}`,
    )
  }

  // Parameter list. Bounded strictly by the DECLARED packet end, not by the
  // buffer end: a buffer may legitimately hold the next message's bytes too,
  // and reading into them would leak one connection's traffic into another's
  // routing decision.
  const end = length
  let pos = 8
  const parameters: Record<string, string> = {}

  while (pos < end) {
    // A lone NUL terminates the list.
    if (buf[pos] === 0) {
      pos++
      break
    }
    const keyEnd = buf.indexOf(0, pos)
    if (keyEnd === -1 || keyEnd >= end) {
      return err('08P01', 'startup packet ended inside a parameter name (missing NUL terminator)')
    }
    const key = buf.toString('utf8', pos, keyEnd)
    pos = keyEnd + 1
    if (pos > end) {
      return err('08P01', `startup packet ended after parameter name "${key}" with no value`)
    }
    const valEnd = buf.indexOf(0, pos)
    if (valEnd === -1 || valEnd >= end) {
      return err(
        '08P01',
        `startup packet ended inside the value of parameter "${key}" (missing NUL terminator)`,
      )
    }
    parameters[key] = buf.toString('utf8', pos, valEnd)
    pos = valEnd + 1
  }

  // `user` is the one parameter the protocol requires. Postgres itself answers
  // a missing one with 3D000-adjacent noise; we are explicit instead.
  const user = parameters.user
  if (user === undefined || user === '') {
    return err('08P01', 'startup packet has no "user" parameter, which the protocol requires')
  }

  // libpq omits `database` when it equals the user name, and expects the server
  // to apply that default. A router that skipped this would route those
  // connections to the empty string and answer 3D000 for a perfectly ordinary
  // `psql -U alice` with no -d.
  const database = parameters.database !== undefined && parameters.database !== ''
    ? parameters.database
    : user

  return {
    kind: 'startup',
    length,
    protocol: code,
    protocolMajor,
    protocolMinor,
    user,
    database,
    parameters,
  }
}
