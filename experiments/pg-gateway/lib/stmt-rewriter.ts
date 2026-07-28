// Per-connection prepared-statement and portal namespacing.
//
// The problem: many wire connections are multiplexed onto ONE PGlite instance,
// which is ONE Postgres session. Prepared statements are session-scoped. So when
// connection B prepares `s1` and connection A already has an `s1`, B gets
// 42P05 duplicate_prepared_statement. This blocks every driver that uses NAMED
// prepared statements with no DSN escape hatch - Rust sqlx and Diesel most
// importantly.
//
// The fix: rewrite the names on the wire so each connection gets its own
// namespace. `s1` from connection 3 becomes `c3_s1` on the backend.
//
// Messages carrying a STATEMENT name:
//   Parse    'P'  cstring stmtName, cstring query, int16 nParams, int32[] types
//   Bind     'B'  cstring portalName, cstring stmtName, ...
//   Describe 'D'  byte 'S', cstring name
//   Close    'C'  byte 'S', cstring name
// Messages carrying a PORTAL name (also session-scoped, same collision):
//   Bind     'B'  cstring portalName (first field)
//   Execute  'E'  cstring portalName, int32 maxRows
//   Describe 'D'  byte 'P', cstring name
//   Close    'C'  byte 'P', cstring name
//
// The unnamed statement and unnamed portal ('') are left alone: they are already
// per-session scratch, and prefixing them would turn an implicit-reuse pattern
// into a named one that nothing ever closes.

const CODE = {
  Parse: 0x50, // 'P'
  Bind: 0x42, // 'B'
  Describe: 0x44, // 'D'
  Close: 0x43, // 'C'
  Execute: 0x45, // 'E'
} as const

const STATEMENT = 0x53 // 'S'
const PORTAL = 0x50 // 'P'

function cstringEnd(buf: Uint8Array, from: number): number {
  let i = from
  while (i < buf.length && buf[i] !== 0) i++
  return i // index of the NUL
}

/**
 * Rewrites statement/portal names in a buffer that may contain several messages.
 * Returns a new buffer when anything changed, otherwise the original.
 */
export function rewriteOutgoing(data: Uint8Array, prefix: string): Uint8Array {
  const pfx = new TextEncoder().encode(prefix)
  const parts: Uint8Array[] = []
  let changed = false
  let off = 0

  while (off < data.length) {
    const type = data[off]
    // Startup/SSLRequest packets have no type byte, but by the time we are
    // rewriting we are past the handshake. Any message shorter than a header is
    // a partial frame we must not touch.
    if (off + 5 > data.length) {
      parts.push(data.subarray(off))
      break
    }
    const len = new DataView(data.buffer, data.byteOffset + off + 1, 4).getInt32(0)
    const end = off + 1 + len
    if (len < 4 || end > data.length) {
      // truncated frame, pass through untouched
      parts.push(data.subarray(off))
      break
    }

    const body = data.subarray(off + 5, end)
    // offsets WITHIN body of each name to prefix
    const targets: { start: number; end: number }[] = []

    if (type === CODE.Parse) {
      const e = cstringEnd(body, 0)
      if (e > 0) targets.push({ start: 0, end: e })
    } else if (type === CODE.Bind) {
      const p1 = cstringEnd(body, 0) // portal name
      if (p1 > 0) targets.push({ start: 0, end: p1 })
      const s0 = p1 + 1
      const s1 = cstringEnd(body, s0) // statement name
      if (s1 > s0) targets.push({ start: s0, end: s1 })
    } else if (type === CODE.Describe || type === CODE.Close) {
      const kind = body[0]
      if (kind === STATEMENT || kind === PORTAL) {
        const e = cstringEnd(body, 1)
        if (e > 1) targets.push({ start: 1, end: e })
      }
    } else if (type === CODE.Execute) {
      const e = cstringEnd(body, 0) // portal name
      if (e > 0) targets.push({ start: 0, end: e })
    }

    if (targets.length === 0) {
      parts.push(data.subarray(off, end))
    } else {
      changed = true
      const newBody = new Uint8Array(body.length + pfx.length * targets.length)
      let src = 0
      let dst = 0
      for (const t of targets) {
        newBody.set(body.subarray(src, t.start), dst)
        dst += t.start - src
        newBody.set(pfx, dst)
        dst += pfx.length
        newBody.set(body.subarray(t.start, t.end), dst)
        dst += t.end - t.start
        src = t.end
      }
      newBody.set(body.subarray(src), dst)

      const out = new Uint8Array(5 + newBody.length)
      out[0] = type
      new DataView(out.buffer).setInt32(1, 4 + newBody.length)
      out.set(newBody, 5)
      parts.push(out)
    }
    off = end
  }

  if (!changed) return data
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * Strips the prefix back out of anything flowing to the client.
 *
 * Backend messages do not echo statement names in the normal path, but
 * ErrorResponse and NoticeResponse embed them in human-readable text - e.g.
 * `prepared statement "c3_s1" already exists`. Leaving that leaks our namespacing
 * into the driver's error string, and drivers do parse those.
 */
export function rewriteIncoming(data: Uint8Array, prefix: string): Uint8Array {
  // Only rewrite if the prefix actually appears, to avoid copying every DataRow.
  const pfx = new TextEncoder().encode(prefix)
  if (!containsBytes(data, pfx)) return data

  const ERROR = 0x45 // 'E' ErrorResponse
  const NOTICE = 0x4e // 'N' NoticeResponse
  const parts: Uint8Array[] = []
  let off = 0
  let changed = false

  while (off < data.length) {
    if (off + 5 > data.length) {
      parts.push(data.subarray(off))
      break
    }
    const type = data[off]
    const len = new DataView(data.buffer, data.byteOffset + off + 1, 4).getInt32(0)
    const end = off + 1 + len
    if (len < 4 || end > data.length) {
      parts.push(data.subarray(off))
      break
    }

    if (type === ERROR || type === NOTICE) {
      const body = data.subarray(off + 5, end)
      if (containsBytes(body, pfx)) {
        // Fields are: byte code, cstring value, ... terminated by a 0 byte.
        // Rewriting the text means re-emitting the whole message with a new length.
        const text = new TextDecoder().decode(body)
        const stripped = text.split(`"${prefix}`).join('"')
        if (stripped !== text) {
          const nb = new TextEncoder().encode(stripped)
          const out = new Uint8Array(5 + nb.length)
          out[0] = type
          new DataView(out.buffer).setInt32(1, 4 + nb.length)
          out.set(nb, 5)
          parts.push(out)
          changed = true
          off = end
          continue
        }
      }
    }
    parts.push(data.subarray(off, end))
    off = end
  }

  if (!changed) return data
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || hay.length < needle.length) return false
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}
