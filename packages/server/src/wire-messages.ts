// Postgres backend-message encoders and a framer, shared by WireFrontend and
// the wire router.
//
// Deliberately dependency-free (not even node:net) so `@zeropg/client` can keep
// deep-importing `@zeropg/server/wire-frontend` without dragging PGlite in.
//
// Every message a backend sends has the same envelope: one ASCII type byte,
// then an int32 length that COVERS ITSELF BUT NOT THE TYPE BYTE. Getting that
// off-by-one wrong is the classic wire bug, so it is encoded in exactly one
// place here (`frame`) and never open-coded elsewhere.

/** One (fieldCode, value) pair of an ErrorResponse / NoticeResponse. */
export interface ErrorField {
  /** Single-character field code: S severity, V severity (non-localized),
   *  C SQLSTATE, M message, D detail, H hint, R routine. */
  code: string
  value: string
}

/** Wrap a payload in the standard `type + int32 length` envelope. */
function frame(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(5 + payload.length)
  out.write(type, 0, 'ascii')
  out.writeInt32BE(4 + payload.length, 1) // length covers itself, not the type byte
  payload.copy(out, 5)
  return out
}

/** NUL-terminated C string. */
function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
}

/**
 * Encode an ErrorResponse ('E') from raw fields.
 *
 * The alternative - closing the socket, or writing a bare string the way
 * pglite-socket's over-cap path does - surfaces to clients as "server closed
 * the connection unexpectedly" (libpq) or "Connection terminated unexpectedly"
 * (node-postgres). Both read like a crash. A real ErrorResponse gives the client
 * a SQLSTATE it can branch on and a message it can print.
 */
export function encodeErrorResponse(fields: readonly ErrorField[]): Buffer {
  const parts: Buffer[] = []
  for (const f of fields) {
    parts.push(Buffer.from(f.code, 'ascii'), cstr(f.value))
  }
  parts.push(Buffer.from([0])) // end of field list
  return frame('E', Buffer.concat(parts))
}

/**
 * The common shape: a FATAL error with a SQLSTATE and a message. `S` and `V`
 * are both sent because `V` is the non-localized severity added in protocol 3.0
 * minor 0 / server 9.6, and some drivers read one and some the other.
 */
export function fatalErrorResponse(
  sqlstate: string,
  message: string,
  extra: { detail?: string; hint?: string } = {},
): Buffer {
  const fields: ErrorField[] = [
    { code: 'S', value: 'FATAL' },
    { code: 'V', value: 'FATAL' },
    { code: 'C', value: sqlstate },
    { code: 'M', value: message },
  ]
  if (extra.detail) fields.push({ code: 'D', value: extra.detail })
  if (extra.hint) fields.push({ code: 'H', value: extra.hint })
  return encodeErrorResponse(fields)
}

/** AuthenticationOk ('R' with int32 0). */
export const AUTHENTICATION_OK: Buffer = frame('R', (() => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(0, 0)
  return b
})())

/** ParameterStatus ('S'): a key/value pair the client caches for the session. */
export function encodeParameterStatus(key: string, value: string): Buffer {
  return frame('S', Buffer.concat([cstr(key), cstr(value)]))
}

/**
 * BackendKeyData ('K'). Omitting it is legal in the letter of the protocol but
 * node-postgres reads processID/secretKey unconditionally, so always send it.
 * The values must be per-connection and unguessable: PGlite hardcodes
 * pid=42 secret=2875488 on every connection of every instance, which is useless
 * as cancellation key material and is not ours to copy.
 */
export function encodeBackendKeyData(processId: number, secretKey: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeInt32BE(processId | 0, 0)
  b.writeInt32BE(secretKey | 0, 4)
  return frame('K', b)
}

/** ReadyForQuery ('Z'). 'I' idle, 'T' in a transaction, 'E' failed transaction. */
export function encodeReadyForQuery(status: 'I' | 'T' | 'E'): Buffer {
  return frame('Z', Buffer.from(status, 'ascii'))
}

/**
 * NegotiateProtocolVersion ('v'). Sent when the client asked for a 3.x minor
 * version above what the backend implements: it names the highest minor we will
 * speak, plus any startup options we did not recognize. Without it a 3.2 client
 * assumes 3.2 semantics against a 3.0 backend.
 */
export function encodeNegotiateProtocolVersion(
  newestMinor: number,
  unrecognizedOptions: readonly string[] = [],
): Buffer {
  const head = Buffer.alloc(8)
  head.writeInt32BE(newestMinor, 0)
  head.writeInt32BE(unrecognizedOptions.length, 4)
  return frame('v', Buffer.concat([head, ...unrecognizedOptions.map((o) => cstr(o))]))
}

/** One framed backend message pulled out of a byte block. */
export interface BackendMessage {
  /** ASCII type byte, e.g. 'S' for ParameterStatus. */
  type: string
  /** The whole message including the type byte and length prefix. */
  bytes: Buffer
  /** The body after the length prefix. */
  payload: Buffer
}

/**
 * Split a block of backend bytes into messages. Used to take PGlite's real
 * handshake apart; NOT a streaming parser, so the caller must hand it whole
 * messages. A trailing partial message is ignored rather than throwing, and the
 * number of bytes consumed is recoverable by summing `bytes.length`.
 */
export function splitBackendMessages(buf: Buffer): BackendMessage[] {
  const out: BackendMessage[] = []
  let pos = 0
  while (pos + 5 <= buf.length) {
    const len = buf.readInt32BE(pos + 1)
    if (len < 4) break // malformed; refuse to loop forever
    const end = pos + 1 + len
    if (end > buf.length) break // partial trailing message
    out.push({
      type: String.fromCharCode(buf[pos]!),
      bytes: buf.subarray(pos, end),
      payload: buf.subarray(pos + 5, end),
    })
    pos = end
  }
  return out
}

/** Decode a ParameterStatus payload into its key and value. */
export function decodeParameterStatus(payload: Buffer): { key: string; value: string } {
  const split = payload.indexOf(0)
  const key = payload.toString('utf8', 0, split === -1 ? payload.length : split)
  const rest = split === -1 ? Buffer.alloc(0) : payload.subarray(split + 1)
  const vEnd = rest.indexOf(0)
  const value = rest.toString('utf8', 0, vEnd === -1 ? rest.length : vEnd)
  return { key, value }
}
