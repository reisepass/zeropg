// E10 probe service: the per-BURST WebSocket tunnel.
//
// E9 answered "does a HELD tunnel pin the instance?" (yes, 1:1). E10 asks the
// different question: if the tunnel is opened per query burst and closed
// immediately, what does the NEXT burst pay? Three outcomes are possible and
// this service is built to tell them apart without relying on the billing
// metric alone:
//
//   BOOT_ID   changes  -> the instance died during the gap. Full cold start.
//   BOOT_ID   same, ticks advanced ~1/s across the gap -> instance stayed
//             awake WITH CPU. Warm, and (per E9) billed.
//   BOOT_ID   same, ticks stalled across the gap       -> instance stayed
//             resident but CPU-throttled. Warm and free: the good outcome.
//
// The tick counter is the load-bearing part. `billable_instance_time` is
// reported in 60s buckets with minutes of lag, so it cannot resolve a 5s gap;
// the ticks can, and they are measured inside the container.
//
// Zero dependencies, same as E9: the RFC 6455 handshake, frame writer and (new
// here, because the client now talks back) the masked-frame reader are ~120
// lines total.

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 8080)
const BOOT_ID = randomUUID().slice(0, 8)
const BOOT_AT = Date.now()

// Monotonic 1Hz tick. Compared against wall clock by the client, this is the
// direct read on whether the instance was SCHEDULED while no socket was open.
//
// The tick alone is not enough to conclude "full CPU". A setInterval callback
// is nearly free, so it can keep firing on schedule even on an instance
// throttled to a few percent of a core - which is exactly the state Cloud Run
// is documented to put idle instances in, and exactly the state that would be
// warm-and-FREE. So each tick also runs a fixed CPU-bound unit of work and
// records how long it took. Constant work time = a real core. Work time
// ballooning while ticks keep pace = scheduled but throttled.
let ticks = 0
const WORK_ITERS = 2_000_000
/** Fixed-cost busy loop. Result is returned so it cannot be optimized away. */
function cpuWorkUnit() {
  let x = 0
  for (let i = 0; i < WORK_ITERS; i++) x = (x + i * 2654435761) % 4294967296
  return x
}
// Ring buffer of the last ~1200 samples (20 minutes at 1Hz), so a client
// reconnecting after a long gap can read back what the CPU was doing while
// nothing was connected.
const samples = []
let workSink = 0
setInterval(() => {
  const s = Date.now()
  workSink += cpuWorkUnit()
  const workMs = Date.now() - s
  ticks++
  samples.push({ tick: ticks, at: s, workMs })
  if (samples.length > 1200) samples.shift()
}, 1000).unref?.()

/** Samples strictly after a given tick number, for gap inspection. */
const samplesSince = (afterTick) => samples.filter((s) => s.tick > afterTick)

const log = (obj) => console.log(JSON.stringify({ boot: BOOT_ID, ...obj }))

log({ event: 'boot', port: PORT, node: process.version })

let openSockets = 0
let burstsServed = 0

const server = createServer((req, res) => {
  const uptimeMs = Date.now() - BOOT_AT
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ boot: BOOT_ID, uptimeMs, ticks, sockets: openSockets, bursts: burstsServed }))
})

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

/**
 * Minimal client->server frame reader. Client frames are always masked. Returns
 * a list of {opcode, payload} and the number of bytes consumed. Only handles
 * unfragmented frames, which is all our own client emits.
 */
function readFrames(buf) {
  const out = []
  let off = 0
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f
    const masked = (buf[off + 1] & 0x80) !== 0
    let len = buf[off + 1] & 0x7f
    let p = off + 2
    if (len === 126) {
      if (p + 2 > buf.length) break
      len = buf.readUInt16BE(p)
      p += 2
    } else if (len === 127) {
      if (p + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(p))
      p += 8
    }
    const maskKey = masked ? buf.subarray(p, p + 4) : null
    if (masked) p += 4
    if (p + len > buf.length) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    out.push({ opcode, payload })
    off = p + len
  }
  return { frames: out, consumed: off }
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

  // The hello frame is what the client times time-to-first-byte against. It
  // carries the two numbers the whole experiment turns on: which instance this
  // is, and how many ticks that instance has accumulated.
  const hello = () => JSON.stringify({
    type: 'hello',
    boot: BOOT_ID,
    conn: id,
    ticks,
    uptimeMs: Date.now() - BOOT_AT,
    at: Date.now(),
    bursts: burstsServed,
  })
  socket.write(textFrame(hello()))

  let acc = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk])
    const { frames, consumed } = readFrames(acc)
    acc = acc.subarray(consumed)
    for (const f of frames) {
      if (f.opcode === 0x8) {
        log({ event: 'ws-client-close-frame', conn: id, heldMs: Date.now() - openedAt })
        socket.write(Buffer.from([0x88, 0x00]))
        socket.end()
        return
      }
      if (f.opcode === 0x1 || f.opcode === 0x2) {
        // Stand-in for a query burst: the client sends one message, we reply
        // once. Deliberately trivial - this experiment measures what the
        // PLATFORM does between bursts, not what a database does during one.
        burstsServed++
        const req = f.payload.toString('utf8')
        let sinceTick = -1
        try { sinceTick = JSON.parse(req).sinceTick ?? -1 } catch { /* not JSON */ }
        // When the client asks, hand back the per-second CPU samples covering
        // the gap it just slept through. This is the record of what the
        // instance was doing while NOTHING was connected to it, which is the
        // only window the experiment actually cares about.
        const gapSamples = sinceTick >= 0 ? samplesSince(sinceTick) : []
        socket.write(textFrame(JSON.stringify({
          type: 'reply',
          boot: BOOT_ID,
          conn: id,
          ticks,
          uptimeMs: Date.now() - BOOT_AT,
          at: Date.now(),
          echo: req.slice(0, 120),
          bursts: burstsServed,
          gapSamples,
        })))
      }
    }
  })

  const done = (why) => (err) => {
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

server.headersTimeout = 0
server.requestTimeout = 0
server.timeout = 0
server.keepAliveTimeout = 0

server.listen(PORT, () => log({ event: 'listening', port: PORT }))
