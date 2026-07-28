// E9 probe service: a trivial Cloud Run service that accepts a WebSocket and
// holds it open doing nothing.
//
// Question it exists to answer: does an open WebSocket keep a Cloud Run
// instance billable and awake for the whole duration of the connection? If it
// does, tunnelling a long-lived Postgres client connection over WebSocket pins
// the instance awake and the scale-to-zero economics of the wire-router shim
// collapse back to always-on.
//
// Zero dependencies on purpose: the RFC 6455 handshake and frame writer below
// are ~80 lines, which is cheaper than an npm install in the image and keeps
// the probe honest about what it is doing.

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 8080)
const BOOT_ID = randomUUID().slice(0, 8)
const BOOT_AT = Date.now()

// Proof-of-liveness: a monotonic tick driven by a plain setInterval. If the
// instance is throttled to zero CPU while the socket is open, this counter
// stops advancing in wall-clock terms and the gap shows up in the ticks the
// client receives. That distinguishes "instance alive and scheduled" from
// "instance alive but CPU-throttled", which the billing docs treat
// differently.
let ticks = 0
setInterval(() => { ticks++ }, 1000).unref?.()

const log = (obj) => console.log(JSON.stringify({ boot: BOOT_ID, ...obj }))

log({ event: 'boot', port: PORT, node: process.version })

const server = createServer((req, res) => {
  const uptimeMs = Date.now() - BOOT_AT
  if (req.url?.startsWith('/status')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ boot: BOOT_ID, uptimeMs, ticks, sockets: openSockets }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(`e9-ws-pin boot=${BOOT_ID} uptimeMs=${uptimeMs} ticks=${ticks} sockets=${openSockets}\n`)
})

let openSockets = 0

// --- RFC 6455 ---------------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Server->client text frame. Server frames are never masked. */
function textFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy()
    return
  }

  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  const id = randomUUID().slice(0, 8)
  const openedAt = Date.now()
  openSockets++
  log({ event: 'ws-open', conn: id, sockets: openSockets, ticks, uptimeMs: openedAt - BOOT_AT })

  // Send one frame at open so the client can pin the instance identity, then
  // go completely silent. No keepalive, no ping: the point is to observe what
  // the platform does to an idle-but-open connection, and any traffic we
  // generate would contaminate that.
  socket.write(textFrame(JSON.stringify({ boot: BOOT_ID, conn: id, ticks, at: openedAt })))

  // Log server-side liveness once a minute. These lines are the record of
  // whether the instance was scheduled during the hold, independent of
  // anything the client observes.
  const heartbeat = setInterval(() => {
    log({
      event: 'ws-heartbeat',
      conn: id,
      heldMs: Date.now() - openedAt,
      ticks,
      uptimeMs: Date.now() - BOOT_AT,
    })
  }, 60_000)

  // We never expect inbound data during the hold. Decode just enough to spot
  // a client close frame (opcode 0x8) so a deliberate client-side teardown is
  // distinguishable in the logs from a platform-initiated one, and so an
  // unread socket does not apply backpressure.
  socket.on('data', (buf) => {
    if (buf.length >= 1 && (buf[0] & 0x0f) === 0x8) {
      log({ event: 'ws-client-close-frame', conn: id, heldMs: Date.now() - openedAt })
      socket.write(Buffer.from([0x88, 0x00]))
      socket.end()
    }
  })

  const done = (why) => (err) => {
    clearInterval(heartbeat)
    openSockets = Math.max(0, openSockets - 1)
    log({
      event: 'ws-close',
      conn: id,
      why,
      err: err ? String(err.message || err) : undefined,
      heldMs: Date.now() - openedAt,
      ticks,
      sockets: openSockets,
    })
  }
  socket.on('close', done('close'))
  socket.on('error', done('error'))
})

// Do not let Node time the socket out on its own; we want the platform's
// behavior, not ours.
server.headersTimeout = 0
server.requestTimeout = 0
server.timeout = 0
server.keepAliveTimeout = 0

server.listen(PORT, () => log({ event: 'listening', port: PORT }))
