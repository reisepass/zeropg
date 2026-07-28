// E9 client half: open one WebSocket to the probe service, hold it open with
// no traffic for N minutes, and report exactly when and how it ends.
//
//   node hold.mjs <wss-url> [holdMinutes]
//
// Emits one JSON line per event on stdout so the run is greppable.

const url = process.argv[2]
const holdMinutes = Number(process.argv[3] || 12)
if (!url) {
  console.error('usage: node hold.mjs <wss://host/wire> [holdMinutes]')
  process.exit(2)
}

const t0 = Date.now()
const line = (obj) => console.log(JSON.stringify({ t: Date.now() - t0, ...obj }))

line({ event: 'dial', url, holdMinutes })

const ws = new WebSocket(url)
let openedAt = 0

ws.onopen = () => {
  openedAt = Date.now()
  line({ event: 'open', connectMs: openedAt - t0 })
}

ws.onmessage = (e) => {
  line({ event: 'message', data: String(e.data) })
}

ws.onerror = (e) => {
  line({ event: 'error', heldMs: openedAt ? Date.now() - openedAt : null, msg: String(e.message || e.type) })
}

ws.onclose = (e) => {
  line({
    event: 'close',
    heldMs: openedAt ? Date.now() - openedAt : null,
    code: e.code,
    reason: String(e.reason || ''),
    wasClean: e.wasClean,
  })
  process.exit(0)
}

// Progress ticks so a long hold is visibly alive. These are client-local
// only; nothing is sent over the socket. Sending anything would defeat the
// experiment, which is specifically about an IDLE open connection.
const progress = setInterval(() => {
  if (openedAt) line({ event: 'holding', heldMs: Date.now() - openedAt, readyState: ws.readyState })
}, 60_000)

setTimeout(() => {
  clearInterval(progress)
  line({ event: 'hold-elapsed', heldMs: Date.now() - openedAt, readyState: ws.readyState })
  ws.close()
  setTimeout(() => process.exit(0), 2000)
}, holdMinutes * 60_000)
