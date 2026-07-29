// E15 server: the E11 standalone entry point plus the instrumentation that
// experiment 1 needs, and the lease probe that experiment 2 needs.
//
// Deliberately NOT a fork of application behaviour. Storage selection,
// durability, seeding and the ZeroPGServer composition are byte-for-byte E11's,
// because E15 measures the E11 configuration and must not measure a different
// server by accident. What is added is only observation:
//
//   1. Phase stamps on the SAME timeline as boot-trace.mjs (ZEROPG_TRACE_T0 /
//      ZEROPG_TRACE_KERNEL_OFFSET are inherited from the parent), so the child's
//      "first line of user code", "ZeroPG.open entered" and "wire listening"
//      slot between the parent's stamps instead of floating in their own clock.
//   2. A hand-rolled split of what ZeroPG.open() does NOT itemise. ZeroPG's own
//      bootTimings give manifestGet / lease / restore / pgliteCreate, which is
//      most of it, but "time spent importing @electric-sql/pglite" is charged to
//      nobody - and a WASM module of that size is a real candidate for the
//      unaccounted seconds. So the import is hoisted and timed explicitly.
//   3. GET /trace, which returns every stamp as JSON. Reading the trace out of
//      band beats scraping `flyctl logs`, whose delivery is asynchronous and
//      which drops lines around a resume (documented Fly behaviour).
//   4. GET /lease-state, which reports whether THIS process still holds the
//      lease it booted with, and re-validates against the bucket on demand.
//      Experiment 2's correctness question is precisely whether a resumed
//      process notices a lease it lost while frozen, and that cannot be asked
//      without a face that reports the answer.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { R2BlobStore } from '@zeropg/blobstore'
import type { BlobStore } from '@zeropg/blobstore'
import type { Durability } from '@zeropg/objectstore-fs'
import { ZeroPGServer } from '@zeropg/server'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- shared timeline, inherited from boot-trace.mjs ----
const T0 = Number(process.env.ZEROPG_TRACE_T0 || Date.now())
const KERNEL_OFFSET = Number(process.env.ZEROPG_TRACE_KERNEL_OFFSET || 0)
const TRACE_FILE = process.env.ZEROPG_TRACE_FILE || '/tmp/prebind-trace.jsonl'
const stamps: Array<Record<string, unknown>> = []

const readKernelUptimeMs = () => {
  try {
    return Math.round(Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000)
  } catch {
    return null
  }
}

function stamp(event: string, extra: Record<string, unknown> = {}) {
  const rec = {
    trace: 'server',
    event,
    at: new Date().toISOString(),
    sinceUserCodeMs: Date.now() - T0,
    sinceKernelMs: KERNEL_OFFSET + (Date.now() - T0),
    ...extra,
  }
  stamps.push(rec)
  console.log(JSON.stringify(rec))
  return rec
}

// The child's own first line. The gap between the parent's `spawning-server`
// and this is fork + exec + a second Node bootstrap + this module's whole ESM
// graph evaluation - a cost the prebind shape pays that a single-process server
// would not, and worth naming before anyone proposes removing prebind to save it.
//
// PGlite's module load is INSIDE that gap and cannot be separated out from here.
// An `await import('@electric-sql/pglite')` at this point measures zero, because
// esbuild hoists the bundle's static `import { PGlite }` to the top of the
// module: by the time any statement in this file runs, the WASM module is
// already loaded and the dynamic import is a cache hit. The first version of
// this file did exactly that and reported `importMs: 0`, which reads as "the
// import is free" when it means "the import already happened". What is
// reportable from here is the composite, so that is what is reported.
const nt = performance.nodeTiming
stamp('child-first-line', {
  childNodeBootstrapMs: Math.round(nt.bootstrapComplete - nt.nodeStart),
  // exec -> here: bootstrap plus ESM graph evaluation, PGlite's WASM load
  // included. The bundle is loaded by the time this runs, so this is the whole
  // module-load cost of the child in one number.
  childExecToUserCodeMs: Math.round(process.uptime() * 1000),
})

const DB_PREFIX = process.env.ZEROPG_PREFIX ?? 'e15/coldstart'

// Tigris only. E11's server.ts carried COS and GCS branches for the platforms it
// shared code with; on Fly the store is always the Tigris bucket and the dead
// branches would only be untested paths in a measurement binary.
function selectStore(): BlobStore {
  const endpoint = process.env.AWS_ENDPOINT_URL_S3
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const bucket = process.env.BUCKET_NAME ?? process.env.TIGRIS_BUCKET
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('missing Tigris config (AWS_ENDPOINT_URL_S3 / AWS_* / BUCKET_NAME)')
  }
  return new R2BlobStore({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    prefix: DB_PREFIX,
    region: process.env.AWS_REGION ?? 'auto',
  })
}

const DURABILITY: Durability = (
  ['strict', 'interval', 'sleep'].includes(process.env.ZEROPG_DURABILITY ?? '')
    ? process.env.ZEROPG_DURABILITY
    : 'sleep'
) as Durability

function loadSeed(): Uint8Array | undefined {
  const p = join(__dirname, 'seed.tar.gz')
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

const store = selectStore()

stamp('zeropg-open-enter', { prefix: DB_PREFIX, durability: DURABILITY })

const server = await ZeroPGServer.start({
  store,
  holder: `${process.env.FLY_MACHINE_ID ?? 'local'}-${process.pid}`,
  durability: DURABILITY,
  seedSnapshot: loadSeed(),
  postgrest: false,
  schemaSql: `CREATE TABLE IF NOT EXISTS notes (
    id serial primary key,
    body text not null,
    created_at timestamptz default now()
  );`,
  label: process.env.APP_LABEL ?? 'zeropg E15 Fly cold-start decomposition',
})
server.installSignalHandlers()

// ZeroPGServer.start() RETURNS BEFORE THE DATABASE EXISTS. It binds the HTTP
// face and kicks off boot() in the background (so /ready can answer during a
// cold start), so this stamp marks "start() returned", not "usable". Stamping
// it as readiness would have understated the cold path by the entire restore -
// the first version of this file did exactly that and reported 1568ms for a
// path that had not opened the bucket yet.
stamp('zeropg-start-returned')

type DbHandle = {
  bootTimings: Record<string, unknown>
  validateLease(): Promise<boolean>
  raw: { query(sql: string): Promise<{ rows: unknown[] }> }
}
// Read through a getter every time rather than capturing once: the field is
// null until boot() finishes, and a captured null would make every later
// /read and /lease-state answer about a database that did not exist yet.
const dbNow = () => (server as unknown as { db: DbHandle | null }).db

// Watch for the real completion, on the same timeline as everything else.
const tReady = Date.now()
const readyPoll = setInterval(() => {
  const d = dbNow()
  if (!d) return
  clearInterval(readyPoll)
  stamp('db-usable', {
    waitedAfterStartMs: Date.now() - tReady,
    // ZeroPG's own split (manifestGet / lease / restore / pgliteCreate),
    // re-emitted onto the shared timeline so the phase table does not have to
    // join two log streams by hand.
    restore: d.bootTimings,
  })
}, 10)
readyPoll.unref?.()

// ---- observation face on a second port ----
//
// A SEPARATE port from ZeroPGServer's own HTTP face, and bound here at the end
// rather than inside the server, for one reason: it must answer even when the
// main server is wedged, and it must not be confused with the control face
// whose readiness is itself part of the measurement.
const OBS_PORT = Number(process.env.ZEROPG_OBS_PORT || 8081)

// Wall-clock jump detector. A suspended VM's timers do not advance while frozen,
// so a monotonic interval that "should" have fired every 500ms and instead sees
// the wall clock leap is the only in-process evidence that a resume happened at
// all. Fly documents no resume signal or webhook, so this is the available
// signal, and experiment 2 needs to know which of its measurements are resumes
// versus cold boots.
const resumes: Array<Record<string, unknown>> = []
let lastTick = Date.now()
const TICK_MS = 500
setInterval(() => {
  const now = Date.now()
  const drift = now - lastTick - TICK_MS
  // 3s of drift is far outside scheduler jitter on an idle VM and comfortably
  // below the shortest idle gap this experiment tests.
  if (drift > 3000) {
    const rec = {
      event: 'resume-detected',
      at: new Date(now).toISOString(),
      frozenMs: drift,
      frozenS: Math.round(drift / 1000),
    }
    resumes.push(rec)
    console.log(JSON.stringify({ trace: 'server', ...rec }))
  }
  lastTick = now
}, TICK_MS).unref?.()

createServer((req, res) => {
  const url = req.url ?? '/'
  const send = (code: number, body: unknown) => {
    const s = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(s)
  }

  if (url.startsWith('/trace')) {
    // Merge the parent's stamps in. They bracket the whole path (kernel->exec,
    // Node startup, public-port-bound, inner-wire-ready) and the parent has no
    // HTTP face of its own, so without this the table is missing both ends and
    // has to be reassembled from `flyctl logs` - which Fly documents as dropping
    // lines around a resume, i.e. exactly when experiment 2 needs them.
    let parent: Array<Record<string, unknown>> = []
    try {
      parent = readFileSync(TRACE_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      /* parent trace file absent: report what we have rather than failing */
    }
    const all = [...parent, ...stamps].sort(
      (a, b) => Number(a.sinceKernelMs ?? 0) - Number(b.sinceKernelMs ?? 0),
    )
    return send(200, {
      machine: process.env.FLY_MACHINE_ID,
      region: process.env.FLY_REGION,
      t0: T0,
      kernelOffsetMs: KERNEL_OFFSET,
      // Read live at request time, not at boot: on a resume this is the number
      // that reveals how long the VM was frozen (kernel uptime keeps counting
      // suspended wall-clock only if the host advances it, and whether it does
      // is itself a finding).
      kernelUptimeNowMs: readKernelUptimeMs(),
      stamps: all,
      resumes,
      restore: dbNow()?.bootTimings ?? null,
    })
  }

  // Does this process still hold the lease it booted with? Two answers, and the
  // difference between them IS experiment 2's correctness finding:
  //   held      - what the process BELIEVES, from local state, with no I/O. A
  //               frozen-then-resumed process believes whatever was true when it
  //               was frozen.
  //   validated - what the BUCKET says, fetched now. Throws FencedError if the
  //               lease was taken over while we were suspended.
  // A server that serves queries without ever consulting the second is serving
  // on a belief, and the whole question is whether it does.
  if (url.startsWith('/lease-state')) {
    const t = Date.now()
    const d = dbNow()
    if (!d) return send(503, { error: 'db not open yet' })
    return void d
      .validateLease()
      .then((ok) => send(200, { validated: true, ok, ms: Date.now() - t, resumes }))
      .catch((e: Error) =>
        send(200, {
          validated: false,
          error: `${e.name}: ${e.message}`,
          ms: Date.now() - t,
          resumes,
        }),
      )
  }

  // Read without touching the lease at all - the path a wire client's SELECT
  // takes. If this answers while /lease-state reports fenced, the server is
  // serving stale reads.
  if (url.startsWith('/read')) {
    const d = dbNow()
    if (!d) return send(503, { error: 'db not open yet' })
    return void d.raw
      .query('SELECT id, body FROM notes ORDER BY id')
      .then((r) => send(200, { rows: r.rows, resumes }))
      .catch((e: Error) => send(500, { error: String(e.message) }))
  }

  send(404, { error: 'not found' })
}).listen(OBS_PORT, '0.0.0.0', () => stamp('obs-face-up', { port: OBS_PORT }))
