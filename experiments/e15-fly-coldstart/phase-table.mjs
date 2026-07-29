// E15 experiment 1: join the three clocks into one phase table.
//
//   node phase-table.mjs <label> [outdir]
//
// Reads the artifacts cold-cycle.sh leaves behind and prints one table that
// accounts for the client-visible total. The join is the point: no single clock
// spans the path, so the table is assembled from three that overlap.
//
//   PROXY (flyctl logs, wall clock, 1-second resolution)
//     "machine started in Xs"      - Fly's own view of VM start
//     "machine became reachable"   - when the proxy first got a TCP accept on
//                                    the internal port, i.e. when prebind bound
//   GUEST (/trace, wall clock in ms, anchored to guest kernel boot)
//     kernelToExecMs / nodeStartupMs / ZeroPG's manifestGet+lease+restore+
//     pgliteCreate / inner-wire-ready
//   CLIENT (connect-timing.mjs, this box's clock)
//     the phase split a real libpq client sees
//
// The proxy's timestamps are second-resolution, so they are used to ANCHOR
// (which second did the VM start in) and never to measure a sub-second phase.
// Everything quoted to the millisecond comes from the guest or the client,
// both of which stamp in milliseconds.
//
// Deliberately prints a RESIDUAL row. A table whose parts sum to less than the
// measured total is exactly the state E11 was in, and printing the shortfall
// rather than quietly letting the rows not add up is the difference between
// "accounted for" and "looks accounted for".

import { readFileSync, existsSync } from 'node:fs'

const LABEL = process.argv[2]
const DIR = process.argv[3] || '/tmp/e15'
if (!LABEL) {
  console.error('usage: node phase-table.mjs <label> [outdir]')
  process.exit(2)
}

const read = (suffix) => {
  const p = `${DIR}/${LABEL}.${suffix}`
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

const clientRaw = read('client.json')
const traceRaw = read('trace.json')
const proxyRaw = read('proxy.log')

const client = clientRaw ? JSON.parse(clientRaw.trim().split('\n').pop()) : null
const trace = traceRaw ? JSON.parse(traceRaw) : null

// Strip the ANSI colouring flyctl writes even when piped.
const proxyLines = (proxyRaw ?? '').replace(/\[[0-9;]*m/g, '').split('\n')
// LAST match, not first. `flyctl logs` replays a buffer before it starts
// tailing, so the file opens with lines from PREVIOUS reps. Taking the first
// match quoted rep 1's "machine started in 1.448s" under rep 3's heading - three
// consecutive reps reported an identical proxy number that was in fact one
// measurement printed three times.
const grab = (re) => {
  for (let i = proxyLines.length - 1; i >= 0; i--) {
    const m = proxyLines[i].match(re)
    if (m) return m
  }
  return null
}

const startedIn = grab(/machine started in ([\d.]+)s/)
const reachableIn = grab(/machine became reachable in ([\d.]+)s/)
const gaveUp = grab(/gave up after (\d+) attempts \(in ([\d.]+)s\)/)
const suspendLine = grab(/(suspend|resum)/i)

const stamp = (event) => trace?.stamps?.find((s) => s.event === event)
const procStart = stamp('proc-start')
const restore = trace?.restore ?? stamp('db-usable')?.restore ?? null

const row = (name, ms, note) =>
  console.log(
    `  ${name.padEnd(30)} ${(ms === null || ms === undefined ? '-' : Math.round(ms)).toString().padStart(7)} ms  ${note ?? ''}`,
  )

console.log(`\n=== ${LABEL} ===`)
if (client?.outcome) console.log(`  CLIENT OUTCOME: ${client.outcome} (reached phase ${client.reachedPhase})`)

console.log('\n-- proxy (flyctl logs, 1s resolution: anchors only) --')
console.log(`  machine started in      : ${startedIn ? startedIn[1] + 's' : 'not logged'}`)
console.log(`  became reachable in     : ${reachableIn ? reachableIn[1] + 's' : 'not logged'}`)
if (gaveUp) console.log(`  PROXY GAVE UP           : ${gaveUp[1]} attempts in ${gaveUp[2]}s`)
if (suspendLine) console.log(`  suspend/resume line     : ${suspendLine[0].slice(0, 120)}`)
if (trace?.resumes?.length) console.log(`  guest saw resume        : frozen ${trace.resumes.map((r) => r.frozenS + 's').join(', ')}`)

console.log('\n-- guest, from kernel boot (ms) --')
if (procStart) {
  row('kernel -> node exec', procStart.kernelToExecMs, 'init, containerd, image mount, entrypoint')
  row('node exec -> first user code', procStart.nodeStartupMs, `v8 ${procStart.v8StartMs}ms, bootstrap ${procStart.nodeBootstrapMs}ms`)
} else {
  console.log('  (no proc-start stamp; guest trace missing)')
}

const at = (e) => stamp(e)?.sinceKernelMs
const bound = at('public-port-bound')
if (bound !== undefined) row('  .. public 5432 bound at', bound, 'absolute, from kernel boot')

if (restore) {
  row('ZeroPG manifest GET', restore.manifestGetMs, 'first bucket round trip')
  row('ZeroPG lease acquire', restore.leaseMs, 'lease.json CAS')
  row('ZeroPG snapshot restore', restore.restoreMs, `${(restore.snapshotBytes / 1e6).toFixed(2)} MB from Tigris`)
  row('PGlite create (WASM boot)', restore.pgliteCreateMs, 'wasm compile + postgres start')
  row('  = ZeroPG.open total', restore.totalMs, `fresh: ${restore.fresh}`)
}
const wireAt = at('inner-wire-ready')
if (wireAt !== undefined) row('  .. wire listening at', wireAt, 'absolute, from kernel boot')

console.log('\n-- client (connect-timing.mjs, this box) --')
if (client && !client.outcome) {
  row('TCP connect', client.d_tcp, 'proxy accepts immediately')
  row('SSL negotiation wait', client.d_sslNeg, 'THE HOLD: whole boot happens here')
  row('startup handshake', client.d_startup, '')
  row('first row', client.d_query, '')
  row('TOTAL', client.totalMs, 'client-visible cold path')

  // The residual. Guest kernel boot is t=0 on the guest axis, and the client's
  // dial happened at some unknown point before that, so the two axes are joined
  // through the one event both can see: the wire becoming ready.
  if (wireAt !== undefined) {
    const preKernel = client.totalMs - client.d_startup - client.d_query - wireAt
    console.log('\n-- residual --')
    row('client total', client.totalMs)
    row('minus guest kernel->wire', wireAt, 'everything the guest could see')
    row('minus startup+query', client.d_startup + client.d_query, 'after the splice')
    row('= UNACCOUNTED', preKernel, 'dial -> guest kernel boot: Fly proxy + hypervisor')
  }
} else if (client) {
  console.log(`  no phase split: ${client.outcome}`)
}
console.log()
