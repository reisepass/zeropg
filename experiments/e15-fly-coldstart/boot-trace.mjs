// E15 experiment 1: account for the whole ~10.5s cold path, not the ~5.6s E11
// could name.
//
// E11 measured the client-visible cold total at 10.3-10.6s and could only
// attribute ~5.6s of it: "machine started in 1.37s" from the Fly proxy plus a
// ~4.2s PGlite restore. The other ~5s had no owner. Guessing which knob to turn
// before that gap has a name is wasted work, so this file exists purely to
// timestamp the boot path end to end.
//
// This is prebind.mjs from E11 (same parking behaviour, unchanged in substance -
// it is proven and this experiment must not perturb the thing it measures) with
// one addition: every phase boundary is stamped against THREE clocks, because no
// single one spans the whole path.
//
//   /proc/uptime      seconds since the VM's KERNEL booted. This is the only
//                     clock that can see time spent before Node exists - image
//                     pull, init, containerd. Reading it in the first tick and
//                     subtracting process.uptime() gives kernel-boot -> node-exec,
//                     which is invisible to any in-process timer and is the
//                     single largest candidate for the unaccounted seconds.
//   performance.nodeTiming
//                     nodeStart / v8Start / bootstrapComplete - how much of the
//                     process's own life was spent becoming a Node runtime
//                     before user code ran.
//   Date.now()        wall clock, emitted as ISO on every line, so these events
//                     can be laid alongside `flyctl logs` proxy timestamps
//                     ("Starting machine", "machine started in", "became
//                     reachable in"). Without a shared wall clock the in-VM
//                     trace and the proxy trace cannot be joined.
//
// The child (server.mjs) stamps the same three clocks from ITS first line and
// inherits T0_WALL, so parent and child phases land on one timeline.

import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs'

// The parent's stamps are the ones that bracket the whole path - kernel->exec,
// Node startup, public-port-bound, inner-wire-ready - and they are produced by a
// process with no HTTP face. Appending them to a file the child serves under
// /trace is what makes the table readable out of band. Scraping them back out of
// `flyctl logs` is not an option for experiment 2: Fly documents dropping log
// lines around a resume, and the dropped ones would be exactly these.
const TRACE_FILE = process.env.ZEROPG_TRACE_FILE || '/tmp/prebind-trace.jsonl'
// Truncate per process, not per boot. Fly documents that `stop` resets the
// rootfs but `suspend` does NOT, so on a resume this file survives with the
// previous boot's stamps in it - and that is wanted: after a resume there IS no
// new boot, and a file that still shows the original one is the correct record
// of a process that never restarted. Truncating here (at exec) rather than on a
// timer keeps the two cases honest without special-casing either.
try {
  writeFileSync(TRACE_FILE, '')
} catch {
  /* tracing must never be able to kill the thing it traces */
}

// ---- first-tick clock reads. Nothing may precede these. ----
const T_WALL = Date.now()
const PROC_UPTIME_S = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
const NODE_UPTIME_S = process.uptime()
// Kernel boot -> this process's EXEC. Everything the platform did before Node
// existed: VM start, init, container runtime, image mount, entrypoint.
const KERNEL_TO_EXEC_MS = Math.round((PROC_UPTIME_S - NODE_UPTIME_S) * 1000)
// Kernel boot -> THIS LINE, which is the first user code in the image. The two
// differ by however long Node took to become Node, and on a shared-cpu-1x that
// is seconds, not milliseconds - so the distinction is not pedantry. The first
// version of this file anchored sinceKernelMs to KERNEL_TO_EXEC_MS and silently
// subtracted the whole Node startup from every stamp, which is most of the gap
// this experiment exists to find.
const KERNEL_TO_USERCODE_MS = Math.round(PROC_UPTIME_S * 1000)
const nt = performance.nodeTiming

const PUBLIC_PORT = Number(process.env.ZEROPG_WIRE_PORT || 5432)
const INNER_PORT = Number(process.env.ZEROPG_INNER_WIRE_PORT || 55432)

const t0 = T_WALL
const log = (event, extra = {}) => {
  const line = JSON.stringify({
    trace: 'prebind',
    event,
    at: new Date().toISOString(),
    sinceUserCodeMs: Date.now() - t0,
    // Since the GUEST KERNEL booted. This is the axis the whole phase table is
    // laid out on: it is the only in-guest number comparable across the
    // parent/child process boundary AND against the proxy's own view, because
    // the proxy's "machine started" is roughly when this clock's zero was.
    sinceKernelMs: KERNEL_TO_USERCODE_MS + (Date.now() - t0),
    ...extra,
  })
  console.log(line)
  try {
    appendFileSync(TRACE_FILE, line + '\n')
  } catch {
    // Tracing must never be able to kill the thing it traces.
  }
}

// The first line of user code in the whole image. Everything before it belongs
// to the platform or to Node itself, and this line says how much of each.
log('proc-start', {
  kernelUptimeMs: KERNEL_TO_USERCODE_MS,
  nodeUptimeMs: Math.round(NODE_UPTIME_S * 1000),
  // Platform time before Node was exec'd. If the unaccounted seconds live here,
  // no amount of application tuning will touch them.
  kernelToExecMs: KERNEL_TO_EXEC_MS,
  // Node becoming Node: exec -> our first line. process.uptime() measures
  // exactly that span, and on shared-cpu-1x it is the second-biggest phase in
  // the whole cold path.
  nodeStartupMs: Math.round(NODE_UPTIME_S * 1000),
  // Sub-split of the above, from Node's own timing origin.
  nodeBootstrapMs: Math.round(nt.bootstrapComplete - nt.nodeStart),
  v8StartMs: Math.round(nt.v8Start - nt.nodeStart),
})

let innerReady = false
const parked = []

// Own the public port in the first tick (E11's fix, unchanged). The stamp on
// this event is what the Fly proxy's "became reachable" should track.
const front = createServer((client) => {
  const waitedFrom = Date.now()
  if (innerReady) return splice(client, waitedFrom)
  const buf = []
  const onData = (b) => buf.push(b)
  client.on('data', onData)
  client.on('error', () => {})
  parked.push({ client, buf, onData, waitedFrom })
  log('client-parked', { parked: parked.length })
})

front.listen(PUBLIC_PORT, '0.0.0.0', () => log('public-port-bound', { port: PUBLIC_PORT }))

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

log('spawning-server')
const child = spawn(process.execPath, ['server.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ZEROPG_WIRE_PORT: String(INNER_PORT),
    ZEROPG_WIRE_HOST: '127.0.0.1',
    // Shared origin so the child's stamps are on the parent's timeline, and the
    // kernel offset so the child can report sinceKernelMs without re-deriving it.
    ZEROPG_TRACE_T0: String(t0),
    ZEROPG_TRACE_KERNEL_OFFSET: String(KERNEL_TO_USERCODE_MS),
  },
})
child.on('exit', (code) => {
  log('server-exited', { code })
  process.exit(code ?? 1)
})

// Poll the inner port at a 20ms cadence rather than E11's 100ms. At 100ms the
// measurement's own granularity is a material slice of a phase we are trying to
// resolve, and the poll is a loopback connect to a closed port - it costs
// nothing worth counting.
const probe = setInterval(() => {
  if (innerReady) return
  const s = connect({ host: '127.0.0.1', port: INNER_PORT }, () => {
    s.destroy()
    innerReady = true
    clearInterval(probe)
    log('inner-wire-ready', { parked: parked.length })
    for (const p of parked.splice(0)) {
      p.client.off('data', p.onData)
      splice(p.client, p.waitedFrom, p.buf)
    }
  })
  s.on('error', () => s.destroy())
}, 20)
probe.unref?.()

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutdown', { signal: sig })
    child.kill(sig)
  })
}
