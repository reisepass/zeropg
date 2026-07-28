// E11 addendum: hold the client during cold start, so the Fly proxy's wake
// budget is not lost by ~100ms.
//
// THE RACE, measured. On a stopped Machine the Fly proxy accepts the client's
// TCP connection instantly and then retries the internal port while the VM
// boots. It gives up after ~8.4s:
//
//   21:12:20  Starting machine
//   21:12:22  machine started in 1.37s
//   21:12:27  waiting for machine to be reachable on 0.0.0.0:5432
//   21:12:30  gave up after 15 attempts (in 8.07s)     <- proxy quits
//   21:12:30  wire-up port 5432                        <- we bind, just too late
//
// ZeroPGServer binds 5432 only AFTER the PGlite restore (~4.2s) finishes, and
// the total lands either side of the proxy's budget essentially at random: one
// run logged "machine became reachable in 8.468s" (client served) and the next
// "gave up after 15 attempts (in 8.374s)" (client dropped). Same code, ~100ms
// apart. That is why psql failed every time while the raw probe sometimes won.
//
// THE FIX, which is the spec's own "hold the connection during a cold start"
// (SPEC-wire-router.md section 4) applied one layer out. Bind 5432 in the FIRST
// TICK of the process, before any restore work. The port is then reachable ~1s
// after boot rather than ~4.5s, well inside the proxy's budget. Accepted
// clients are parked - their bytes buffered, nothing sent - until the real wire
// is listening on an internal port, then spliced through. libpq is content to
// wait: it has sent SSLRequest and is waiting for a reply, which is exactly the
// hold ZeroPGServer already relies on for HTTP cold starts.
//
// This lives in experiments/ deliberately. It demonstrates that the E11 failure
// is ours and is fixable; the real fix belongs inside @zeropg/server, where the
// wire front-end can bind early and hold natively instead of being fronted by a
// second listener.
//
//   node prebind.mjs        (in place of `node server.mjs`)

import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'

const PUBLIC_PORT = Number(process.env.ZEROPG_WIRE_PORT || 5432)
// The real server is moved to an internal port; we own the public one.
const INNER_PORT = Number(process.env.ZEROPG_INNER_WIRE_PORT || 55432)

const log = (event, extra = {}) => console.log(JSON.stringify({ prebind: true, event, ...extra }))

const t0 = Date.now()
let innerReady = false
const parked = []

// 1. Own the public port immediately. This is the whole point: it happens
//    before any restore work, so the Fly proxy finds the port reachable within
//    ~1s of the VM booting.
const front = createServer((client) => {
  const waitedFrom = Date.now()
  if (innerReady) return splice(client, waitedFrom)
  // Park it. Buffer anything the client sends (libpq's SSLRequest arrives
  // immediately) and reply nothing until the backend exists.
  const buf = []
  const onData = (b) => buf.push(b)
  client.on('data', onData)
  client.on('error', () => {})
  parked.push({ client, buf, onData, waitedFrom })
  log('client-parked', { parked: parked.length, sinceStartMs: Date.now() - t0 })
})

front.listen(PUBLIC_PORT, '0.0.0.0', () =>
  log('public-port-bound', { port: PUBLIC_PORT, sinceStartMs: Date.now() - t0 }),
)

function splice(client, waitedFrom, pre = []) {
  const inner = connect({ host: '127.0.0.1', port: INNER_PORT }, () => {
    for (const b of pre) inner.write(b)
    client.pipe(inner)
    inner.pipe(client)
    log('client-spliced', { heldMs: Date.now() - waitedFrom })
  })
  inner.on('error', (e) => {
    log('inner-error', { msg: String(e.message) })
    client.destroy()
  })
  client.on('error', () => inner.destroy())
}

// 2. Start the real server on the internal port.
const child = spawn(process.execPath, ['server.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, ZEROPG_WIRE_PORT: String(INNER_PORT), ZEROPG_WIRE_HOST: '127.0.0.1' },
})
child.on('exit', (code) => {
  log('server-exited', { code })
  process.exit(code ?? 1)
})

// 3. Poll the internal port; release the parked clients the moment it answers.
const probe = setInterval(() => {
  if (innerReady) return
  const s = connect({ host: '127.0.0.1', port: INNER_PORT }, () => {
    s.destroy()
    innerReady = true
    clearInterval(probe)
    log('inner-wire-ready', { sinceStartMs: Date.now() - t0, parked: parked.length })
    for (const p of parked.splice(0)) {
      p.client.off('data', p.onData)
      splice(p.client, p.waitedFrom, p.buf)
    }
  })
  s.on('error', () => s.destroy())
}, 100)
probe.unref?.()

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutdown', { signal: sig })
    child.kill(sig)
  })
}
