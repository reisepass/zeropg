// E11 step 3: connect-to-first-row, broken into phases.
//
//   node connect-timing.mjs <host> <port> [label]
//
// `psql -c "select 1"` wall clock is not the number we want: it folds in psql
// process startup and this box's RTT to the region. This speaks the wire
// directly and timestamps each phase, so a cold Machine's start time is
// separable from network latency:
//
//   tcpConnectMs   socket() -> connected. On a STOPPED Machine this is where
//                  Fly's start would show up IF the proxy holds the connection
//                  while booting - which is E11's central question. If instead
//                  it refuses, this throws ECONNREFUSED and that IS the answer.
//   sslNegMs       SSLRequest -> the single-byte 'N'/'S' reply. First evidence
//                  the application (not just the proxy) is listening.
//   startupMs      StartupMessage -> ReadyForQuery. Covers auth + the whole
//                  handshake block.
//   firstRowMs     Query -> DataRow. The actual first row.
//   totalMs        socket() -> first row.
//
// Zero dependencies: a StartupMessage, a simple Query and enough of the backend
// message framing to spot DataRow and ReadyForQuery is ~80 lines, and it keeps
// the timing free of any driver's own connection setup.

import { connect } from 'node:net'

const HOST = process.argv[2]
const PORT = Number(process.argv[3] || 5432)
const LABEL = process.argv[4] || 'run'
if (!HOST) {
  console.error('usage: node connect-timing.mjs <host> <port> [label]')
  process.exit(2)
}

const SSL_REQUEST_CODE = 80877103

/** int32-length-prefixed startup packet: protocol 3.0 + key/value pairs. */
function startupMessage(params) {
  const parts = []
  for (const [k, v] of Object.entries(params)) {
    parts.push(Buffer.from(k, 'utf8'), Buffer.from([0]), Buffer.from(v, 'utf8'), Buffer.from([0]))
  }
  const body = Buffer.concat([...parts, Buffer.from([0])])
  const buf = Buffer.alloc(8 + body.length)
  buf.writeInt32BE(8 + body.length, 0)
  buf.writeInt32BE(196608, 4) // 3.0
  body.copy(buf, 8)
  return buf
}

/** 'Q' simple query. */
function queryMessage(sql) {
  const s = Buffer.from(sql, 'utf8')
  const buf = Buffer.alloc(6 + s.length)
  buf[0] = 0x51 // 'Q'
  buf.writeInt32BE(5 + s.length, 1)
  s.copy(buf, 5)
  buf[5 + s.length] = 0
  return buf
}

const t = {}
/** Set as soon as any outcome has been printed, so exactly one line is emitted
 *  per run regardless of which path the connection took. */
let reported = false
const t0 = process.hrtime.bigint()
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6

let phase = 'tcp'
let carry = Buffer.alloc(0)
let sawFirstRow = false

const sock = connect({ host: HOST, port: PORT })

sock.on('connect', () => {
  t.tcpConnectMs = ms()
  phase = 'ssl'
  // Exactly what libpq at its default sslmode sends first.
  const req = Buffer.alloc(8)
  req.writeInt32BE(8, 0)
  req.writeInt32BE(SSL_REQUEST_CODE, 4)
  sock.write(req)
})

sock.on('data', (chunk) => {
  if (phase === 'ssl') {
    t.sslNegMs = ms()
    t.sslReply = String.fromCharCode(chunk[0])
    phase = 'startup'
    sock.write(startupMessage({ user: 'postgres', database: 'postgres' }))
    chunk = chunk.subarray(1)
    if (chunk.length === 0) return
  }

  carry = carry.length ? Buffer.concat([carry, chunk]) : chunk
  let off = 0
  while (off + 5 <= carry.length) {
    const type = carry[off]
    const len = carry.readInt32BE(off + 1)
    if (len < 4 || off + 1 + len > carry.length) break

    if (type === 0x5a /* 'Z' ReadyForQuery */) {
      if (phase === 'startup') {
        t.startupMs = ms()
        phase = 'query'
        sock.write(queryMessage('select 1'))
      } else if (phase === 'query' && sawFirstRow) {
        t.totalMs = ms()
        reported = true
        report()
        sock.end()
        return
      }
    } else if (type === 0x44 /* 'D' DataRow */ && !sawFirstRow) {
      sawFirstRow = true
      t.firstRowMs = ms()
    } else if (type === 0x45 /* 'E' ErrorResponse */) {
      t.error = carry.subarray(off + 5, off + 1 + len).toString('utf8').replace(/\0/g, ' ').trim()
    }
    off += 1 + len
  }
  carry = carry.subarray(off)
})

function report() {
  console.log(JSON.stringify({
    label: LABEL,
    host: HOST,
    port: PORT,
    tcpConnectMs: round(t.tcpConnectMs),
    sslNegMs: round(t.sslNegMs),
    sslReply: t.sslReply,
    startupMs: round(t.startupMs),
    firstRowMs: round(t.firstRowMs),
    totalMs: round(t.totalMs),
    // Phase durations, which is what the write-up quotes.
    d_tcp: round(t.tcpConnectMs),
    d_sslNeg: round(t.sslNegMs - t.tcpConnectMs),
    d_startup: round(t.startupMs - t.sslNegMs),
    d_query: round(t.firstRowMs - t.startupMs),
    error: t.error,
  }))
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null)

sock.on('error', (e) => {
  reported = true
  console.log(JSON.stringify({
    label: LABEL, host: HOST, port: PORT,
    outcome: 'SOCKET-ERROR', code: e.code, msg: String(e.message),
    reachedPhase: phase, atMs: round(ms()), partial: t,
  }))
  process.exit(1)
})

// A cold Machine can accept the TCP connection at the proxy and then have the
// peer hang up before the handshake completes - the socket simply ends, with no
// error event. Without this the process exited silently and reported nothing,
// which reads as "no result" when it is in fact a meaningful outcome.
sock.on('close', (hadError) => {
  if (reported) return
  reported = true
  console.log(JSON.stringify({
    label: LABEL, host: HOST, port: PORT,
    outcome: 'CLOSED-BEFORE-FIRST-ROW', hadError,
    reachedPhase: phase, atMs: round(ms()), partial: t,
  }))
  process.exit(1)
})

// If the Fly proxy HOLDS the connection while a stopped Machine boots, that
// hold shows up as a long tcpConnect or a long silence, not an error. Bound it
// so the run cannot hang forever, and report how far it got.
setTimeout(() => {
  console.log(JSON.stringify({
    label: LABEL, host: HOST, port: PORT,
    outcome: 'TIMEOUT-120s', reachedPhase: phase, partial: t,
  }))
  process.exit(1)
}, 120_000).unref?.()
