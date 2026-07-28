// Run: tsx packages/server/test/startup-packet.test.ts
//
// The startup-packet parser is the load-bearing piece of the wire router:
// nothing else in the stack reads the `database` field (PGlite discards it,
// pglite-socket only checks readInt32BE(4) === 196608), so a bug here is a
// mis-route, and a mis-route hands one tenant another tenant's database.
//
// It also sits on a public TCP port reading pre-authentication bytes, so the
// hostile cases below are not padding. Every declared length in the input is
// attacker-controlled.

import {
  parseStartupPacket,
  MAX_STARTUP_PACKET_LENGTH,
  PROTOCOL_3_0,
  SSL_REQUEST_CODE,
  GSSENC_REQUEST_CODE,
  CANCEL_REQUEST_CODE,
  type StartupParseResult,
} from '../src/startup-packet.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

/** Build a real StartupMessage the way libpq does. */
function startup(params: Record<string, string>, protocol = PROTOCOL_3_0): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(k, 'utf8'), Buffer.from([0]), Buffer.from(v, 'utf8'), Buffer.from([0]))
  }
  parts.push(Buffer.from([0]))
  const body = Buffer.concat(parts)
  const out = Buffer.alloc(8 + body.length)
  out.writeInt32BE(8 + body.length, 0)
  out.writeInt32BE(protocol, 4)
  body.copy(out, 8)
  return out
}

/** An 8-byte fixed negotiation packet. */
function req(code: number, length = 8): Buffer {
  const b = Buffer.alloc(8)
  b.writeInt32BE(length, 0)
  b.writeInt32BE(code, 4)
  return b
}

function main(): void {
  console.log('startup-packet parser')

  // --- the routing field, which is the entire point --------------------------
  {
    const r = parseStartupPacket(startup({ user: 'alice', database: 'analytics' }))
    ok(r.kind === 'startup', 'a normal StartupMessage parses')
    if (r.kind !== 'startup') return
    ok(r.user === 'alice', `user is read out (${r.user})`)
    ok(r.database === 'analytics', `database is read out (${r.database}) - this is what routes`)
    ok(r.protocol === PROTOCOL_3_0, 'protocol 3.0 recognized')
    ok(r.protocolMajor === 3 && r.protocolMinor === 0, 'protocol split into major/minor')
  }

  // libpq omits `database` when it equals the user. A router that did not apply
  // the default would answer 3D000 for a plain `psql -U alice`.
  {
    const r = parseStartupPacket(startup({ user: 'alice' }))
    ok(r.kind === 'startup', 'a StartupMessage with no database parses')
    if (r.kind !== 'startup') return
    ok(r.database === 'alice', 'database defaults to user when omitted, as Postgres does')
  }
  {
    const r = parseStartupPacket(startup({ user: 'alice', database: '' }))
    ok(r.kind === 'startup' && r.database === 'alice', 'an EMPTY database also falls back to user')
  }

  // Every other parameter must survive: `options` carries -c settings and
  // application_name is what shows up in logs.
  {
    const r = parseStartupPacket(
      startup({
        user: 'bob',
        database: 'shop',
        application_name: 'myapp',
        options: '-c search_path=x',
        client_encoding: 'UTF8',
      }),
    )
    ok(r.kind === 'startup', 'a packet with many parameters parses')
    if (r.kind !== 'startup') return
    ok(r.parameters.application_name === 'myapp', 'application_name preserved')
    ok(r.parameters.options === '-c search_path=x', 'options preserved verbatim')
    ok(Object.keys(r.parameters).length === 5, 'every parameter is kept, none dropped')
  }

  // Database names are not ASCII-only and are not identifier-safe. If the
  // parser mangled these, the lookup would miss and the client would get 3D000
  // for a database that exists.
  for (const name of ['Ünïcödé', '日本語db', 'has space', 'has"quote', "has'apos", 'MiXeDcAsE']) {
    const r = parseStartupPacket(startup({ user: 'u', database: name }))
    ok(
      r.kind === 'startup' && r.database === name,
      `database name round-trips exactly: ${JSON.stringify(name)}`,
    )
  }

  // --- the four packets that are NOT StartupMessages --------------------------
  {
    const r = parseStartupPacket(req(SSL_REQUEST_CODE))
    ok(r.kind === 'ssl-request', 'SSLRequest is distinguished from a StartupMessage')
  }
  {
    const r = parseStartupPacket(req(GSSENC_REQUEST_CODE))
    ok(r.kind === 'gssenc-request', 'GSSENCRequest is distinguished')
  }
  {
    const b = Buffer.alloc(16)
    b.writeInt32BE(16, 0)
    b.writeInt32BE(CANCEL_REQUEST_CODE, 4)
    b.writeInt32BE(42, 8)
    b.writeInt32BE(2875488, 12)
    const r = parseStartupPacket(b)
    ok(r.kind === 'cancel-request', 'CancelRequest is distinguished')
    if (r.kind !== 'cancel-request') return
    ok(r.processId === 42 && r.secretKey === 2875488, 'CancelRequest pid/secret decoded')
  }

  // A code match alone is not enough. pglite-socket effectively matches on the
  // code only; a packet whose declared length disagrees with its own fixed
  // format is malformed and must not be accepted.
  {
    const r = parseStartupPacket(req(SSL_REQUEST_CODE, 9))
    ok(r.kind === 'error', 'SSLRequest with a wrong declared length is rejected, not accepted')
  }

  // --- need-more is a distinct outcome from error -----------------------------
  // Conflating these is the classic bug: treat need-more as an error and every
  // segmented client hangs up; treat an error as need-more and the parser
  // buffers a malicious peer forever.
  {
    ok(parseStartupPacket(Buffer.alloc(0)).kind === 'need-more', 'empty input -> need-more')
    ok(parseStartupPacket(Buffer.alloc(7)).kind === 'need-more', '7 bytes -> need-more')
    const full = startup({ user: 'alice', database: 'db' })
    for (let n = 8; n < full.length; n++) {
      const r = parseStartupPacket(full.subarray(0, n))
      if (r.kind !== 'need-more') {
        throw new Error(`FAIL: ${n}/${full.length} bytes gave ${r.kind}, expected need-more`)
      }
    }
    passed++
    console.log(`  ok  every truncation of a valid packet (8..${full.length - 1}) -> need-more`)
    ok(parseStartupPacket(full).kind === 'startup', 'the complete packet then parses')
  }

  // A CancelRequest declares 16 but may arrive in two segments.
  {
    const b = Buffer.alloc(16)
    b.writeInt32BE(16, 0)
    b.writeInt32BE(CANCEL_REQUEST_CODE, 4)
    ok(parseStartupPacket(b.subarray(0, 12)).kind === 'need-more', 'partial CancelRequest -> need-more')
  }

  // --- hostile input. None of these may throw, hang, or over-read -------------
  {
    // The allocation-bomb shape: a declared length of 2 GB. Must be refused on
    // the number alone, without waiting for 2 GB of bytes to arrive.
    const b = Buffer.alloc(8)
    b.writeInt32BE(0x7fffffff, 0)
    b.writeInt32BE(PROTOCOL_3_0, 4)
    const r = parseStartupPacket(b)
    ok(r.kind === 'error', 'a 2 GB declared length is refused immediately, not buffered')
    ok(
      r.kind === 'error' && /maximum/.test(r.message),
      'the oversize refusal says why (it names the maximum)',
    )
  }
  {
    const b = Buffer.alloc(8)
    b.writeInt32BE(MAX_STARTUP_PACKET_LENGTH + 1, 0)
    b.writeInt32BE(PROTOCOL_3_0, 4)
    ok(parseStartupPacket(b).kind === 'error', 'one byte over the maximum is refused')
  }
  {
    // Negative length. readInt32BE is signed, so this is the sign-flip case.
    const b = Buffer.alloc(8)
    b.writeInt32BE(-1, 0)
    b.writeInt32BE(PROTOCOL_3_0, 4)
    ok(parseStartupPacket(b).kind === 'error', 'a negative declared length is refused')
  }
  {
    const b = Buffer.alloc(8)
    b.writeInt32BE(0, 0)
    b.writeInt32BE(PROTOCOL_3_0, 4)
    ok(parseStartupPacket(b).kind === 'error', 'a zero declared length is refused')
  }
  {
    // Declared length SHORTER than the data present. The parser must honour the
    // declared end and refuse, never read into the trailing bytes - those bytes
    // may belong to a different message.
    const good = startup({ user: 'alice', database: 'secret' })
    const lying = Buffer.concat([good])
    lying.writeInt32BE(12, 0) // claims 12 bytes; the NUL list is not inside it
    const r = parseStartupPacket(lying)
    ok(
      r.kind === 'error' || (r.kind === 'startup' && r.length === 12),
      'a length shorter than the data does not read past the declared end',
    )
    ok(
      !(r.kind === 'startup' && r.database === 'secret'),
      'the parser did NOT pick up a field that lies beyond the declared length',
    )
  }
  {
    // Missing terminating NUL on a value: the classic over-read. The buffer
    // ends exactly at the declared length with a key/value still open.
    const body = Buffer.concat([Buffer.from('user\0alice', 'utf8')])
    const b = Buffer.alloc(8 + body.length)
    b.writeInt32BE(8 + body.length, 0)
    b.writeInt32BE(PROTOCOL_3_0, 4)
    body.copy(b, 8)
    const r = parseStartupPacket(b)
    ok(r.kind === 'error', 'a value with no NUL terminator is a parse error, not an over-read')
  }
  {
    // Missing NUL on a KEY.
    const body = Buffer.from('user', 'utf8')
    const b = Buffer.alloc(8 + body.length)
    b.writeInt32BE(8 + body.length, 0)
    b.writeInt32BE(PROTOCOL_3_0, 4)
    body.copy(b, 8)
    ok(parseStartupPacket(b).kind === 'error', 'a key with no NUL terminator is a parse error')
  }
  {
    // No `user` at all. The protocol requires it.
    const r = parseStartupPacket(startup({ database: 'db' }))
    ok(r.kind === 'error', 'a StartupMessage with no user is refused')
    ok(r.kind === 'error' && /user/.test(r.message), 'the refusal names the missing parameter')
  }
  {
    const r = parseStartupPacket(startup({ user: '' }))
    ok(r.kind === 'error', 'an EMPTY user is refused (it is not a valid identity)')
  }
  {
    // Protocol 2.0. A real thing that real old clients send.
    const r = parseStartupPacket(startup({ user: 'a' }, 131072))
    ok(r.kind === 'error', 'protocol 2.0 is refused with an error, not silently accepted')
  }
  {
    // Protocol 3.3 (a future MINOR). The protocol says answer
    // NegotiateProtocolVersion and continue at 3.0, so the PARSER must not
    // reject it - that decision belongs to the caller.
    const r = parseStartupPacket(startup({ user: 'a', database: 'd' }, (3 << 16) | 3))
    ok(r.kind === 'startup', 'a future 3.x MINOR version still parses (caller negotiates)')
    ok(r.kind === 'startup' && r.protocolMinor === 3, 'the minor version is reported to the caller')
  }
  {
    // Pure garbage, including the byte 0x16 that a PG17 sslnegotiation=direct
    // client leads with. Must be a clean error, never a throw.
    const cases: Buffer[] = [
      Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01]),
      Buffer.from('GET / HTTP/1.1\r\n\r\n', 'utf8'),
      Buffer.alloc(64, 0xff),
      Buffer.alloc(64, 0x00),
    ]
    for (const c of cases) {
      let r: StartupParseResult
      try {
        r = parseStartupPacket(c)
      } catch (e) {
        throw new Error(`FAIL: parser THREW on garbage input: ${String(e)}`)
      }
      ok(
        r.kind === 'error' || r.kind === 'need-more',
        `garbage input ${JSON.stringify(c.subarray(0, 8).toString('hex'))} -> ${r.kind}, no throw`,
      )
    }
  }
  {
    // Fuzz: random bytes must never throw and never claim to be a valid
    // startup packet by accident with an empty user.
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(Math.random() * 64)
      const b = Buffer.alloc(n)
      for (let j = 0; j < n; j++) b[j] = Math.floor(Math.random() * 256)
      let r: StartupParseResult
      try {
        r = parseStartupPacket(b)
      } catch (e) {
        throw new Error(`FAIL: parser THREW on ${b.toString('hex')}: ${String(e)}`)
      }
      if (r.kind === 'startup' && !r.user) {
        throw new Error(`FAIL: parser accepted an empty user from ${b.toString('hex')}`)
      }
    }
    passed++
    console.log('  ok  5000 random inputs: no throw, no packet accepted with an empty user')
  }

  // A packet exactly at the maximum must be ACCEPTED - the boundary is
  // inclusive, and an off-by-one here would refuse a legal long `options`.
  {
    // Size the padding by measuring rather than by counting NULs by hand.
    const overhead = startup({ user: 'u', options: '' }).length
    const pad = 'x'.repeat(MAX_STARTUP_PACKET_LENGTH - overhead)
    const b = startup({ user: 'u', options: pad })
    ok(b.length === MAX_STARTUP_PACKET_LENGTH, `built a packet of exactly the maximum (${b.length})`)
    const r = parseStartupPacket(b)
    ok(r.kind === 'startup', 'a packet of exactly MAX_STARTUP_PACKET_LENGTH is accepted')
  }

  console.log(`\n${passed} assertions passed`)
}

main()
