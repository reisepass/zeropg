// E10, correctness half: the transaction rule.
//
// The per-burst tunnel design says the router may close the backend tunnel when
// a burst ends. That is only safe when the session is not inside a
// transaction - closing mid-transaction would silently roll back work the
// client believes is still open, which is data loss rather than a performance
// bug.
//
// The rule the spec proposes (SPEC-wire-router.md section 2): the router parses
// the wire, so it sees the ReadyForQuery status byte - 'I' idle, 'T' in a
// transaction, 'E' failed transaction. Close only on 'I'. Never on 'T' or 'E'.
//
// This is a REAL Postgres wire proxy, not a mock. It sits in front of a real
// backend, parses the actual byte stream in both directions, and applies the
// close rule to a real idle timer. The client is real psql. What is asserted is
// what the proxy actually did:
//
//   1. BEGIN; INSERT  -> gap longer than the idle timer -> the proxy must
//      REFUSE to close, because ReadyForQuery said 'T'. The COMMIT after the
//      gap must succeed and the row must be visible.
//   2. after COMMIT   -> ReadyForQuery says 'I' -> the same idle timer must
//      now actually close the tunnel.
//   3. a FAILED transaction ('E') must also be held open, then released once
//      ROLLBACK returns it to 'I'.
//
// Usage:
//   node txn-rule.mjs <backend-host> <backend-port> [listenPort] [idleCloseMs]

import { createServer, connect } from 'node:net'

const BACKEND_HOST = process.argv[2]
const BACKEND_PORT = Number(process.argv[3])
const LISTEN_PORT = Number(process.argv[4] || 55432)
const IDLE_CLOSE_MS = Number(process.argv[5] || 3000)

if (!BACKEND_HOST || !BACKEND_PORT) {
  console.error('usage: node txn-rule.mjs <backend-host> <backend-port> [listenPort] [idleCloseMs]')
  process.exit(2)
}

const t0 = Date.now()
const line = (obj) => console.log(JSON.stringify({ t: Date.now() - t0, ...obj }))

/** Every close decision the proxy made, which is what the test asserts on. */
const decisions = []

/**
 * Scan a backend->client byte stream for ReadyForQuery ('Z') messages and
 * return the status byte of the last one seen.
 *
 * Postgres backend messages are: 1 byte type, int32 length (including itself),
 * then length-4 bytes of payload. ReadyForQuery is type 'Z', length 5, payload
 * one status byte. We walk the framing properly rather than searching for a 'Z'
 * byte, because 'Z' (0x5a) appears constantly inside row data and a naive scan
 * would report transaction states that never happened.
 */
function scanReadyForQuery(buf, carry) {
  let acc = carry.length ? Buffer.concat([carry, buf]) : buf
  let off = 0
  let status = null
  while (off + 5 <= acc.length) {
    const type = acc[off]
    const len = acc.readInt32BE(off + 1)
    if (len < 4) break // malformed; stop rather than loop forever
    if (off + 1 + len > acc.length) break // incomplete message, wait for more
    if (type === 0x5a /* 'Z' */ && len === 5) status = String.fromCharCode(acc[off + 5])
    off += 1 + len
  }
  return { status, carry: acc.subarray(off) }
}

const SSL_REQUEST_CODE = 80877103
const GSSENC_REQUEST_CODE = 80877104

const server = createServer((client) => {
  const backend = connect({ host: BACKEND_HOST, port: BACKEND_PORT })
  let txnStatus = null // last ReadyForQuery status byte seen
  let carry = Buffer.alloc(0)
  // The SSL/GSSENC negotiation reply is a SINGLE BARE BYTE ('N' or 'S'), not a
  // length-framed message. If we start the message walker on it, the walker
  // reads 'N' as a type byte and the next four bytes - which are really the
  // head of AuthenticationOk - as a length, and every subsequent frame boundary
  // is wrong for the life of the connection. That desync is silent: it does not
  // error, it just never finds a ReadyForQuery, so the close rule sees null
  // forever and refuses every close. Refusing is the fail-SAFE direction, which
  // is exactly why this had to be caught deliberately rather than by the test
  // going red. Track the negotiation and skip that one byte.
  let expectNegotiationReply = false
  let negotiationConsumed = false
  let idleTimer = null
  let closed = false

  // The close rule under test. Fires whenever the tunnel has been quiet for
  // IDLE_CLOSE_MS, and decides whether it is allowed to tear the tunnel down.
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (closed) return
      // Only 'I' authorises a close. 'T' and 'E' are inside a transaction, and
      // null means we have not yet parsed a ReadyForQuery at all - which is a
      // parser problem, not an idle session, and must never be read as
      // permission to close.
      const mayClose = txnStatus === 'I'
      decisions.push({ at: Date.now() - t0, txnStatus, mayClose })
      const reason =
        txnStatus === 'I'
          ? 'ReadyForQuery=I, session is idle, safe to close'
          : txnStatus === null
            ? 'no ReadyForQuery parsed yet - refusing on principle, NOT a transaction observation'
            : `ReadyForQuery=${txnStatus}, session is inside a transaction, MUST NOT close`
      line({
        event: mayClose ? 'tunnel-close-ALLOWED' : 'tunnel-close-REFUSED',
        readyForQueryStatus: txnStatus,
        reason,
      })
      if (mayClose) {
        closed = true
        backend.end()
        client.end()
      } else {
        // Refused. Re-arm, so a transaction that stays open keeps being
        // re-evaluated rather than silently never closing.
        armIdleTimer()
      }
    }, IDLE_CLOSE_MS)
    idleTimer.unref?.()
  }

  client.on('data', (b) => {
    // Spot the 8-byte SSLRequest/GSSENCRequest so the single-byte reply it
    // provokes can be skipped rather than fed to the message walker.
    if (!negotiationConsumed && b.length >= 8 && b.readInt32BE(0) === 8) {
      const code = b.readInt32BE(4)
      if (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE) {
        expectNegotiationReply = true
        line({ event: 'ssl-negotiation-request', code })
      }
    }
    backend.write(b)
    armIdleTimer()
  })

  backend.on('data', (b) => {
    client.write(b)
    if (expectNegotiationReply) {
      // First byte of this chunk is the bare 'N'/'S' negotiation reply.
      line({ event: 'ssl-negotiation-reply', reply: String.fromCharCode(b[0]) })
      expectNegotiationReply = false
      negotiationConsumed = true
      b = b.subarray(1)
      if (b.length === 0) {
        armIdleTimer()
        return
      }
    }
    const r = scanReadyForQuery(b, carry)
    carry = r.carry
    if (r.status && r.status !== txnStatus) {
      txnStatus = r.status
      line({ event: 'ready-for-query', status: txnStatus })
    } else if (r.status) {
      txnStatus = r.status
    }
    armIdleTimer()
  })

  const shut = () => {
    if (idleTimer) clearTimeout(idleTimer)
    backend.destroy()
    client.destroy()
  }
  client.on('error', shut)
  backend.on('error', shut)
  client.on('close', shut)
  backend.on('close', shut)
})

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  line({ event: 'proxy-listening', port: LISTEN_PORT, backend: `${BACKEND_HOST}:${BACKEND_PORT}`, idleCloseMs: IDLE_CLOSE_MS })
})

// Dump the decision log on exit so the harness can assert on it.
process.on('SIGTERM', () => {
  line({ event: 'decisions', decisions })
  process.exit(0)
})
process.on('SIGINT', () => {
  line({ event: 'decisions', decisions })
  process.exit(0)
})
