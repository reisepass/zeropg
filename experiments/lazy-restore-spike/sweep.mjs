// EAGER-vs-LAZY sweep: produce a defensible LazyFS ON/OFF policy.
//
// Method: real Postgres block-access FOOTPRINTS (from calibrate.mjs ->
// footprints.jsonl) feed a modeled object store (store-model.mjs). For each cell
// we compute, over many iterations (so per-request latency sampling gives stable
// p50/p99):
//   EAGER = time-to-full-restore: download the WHOLE datadir (parallelized,
//           bandwidth-bound) + first-query time (negligible; data is local).
//   LAZY  = TTFQ: download the eager set (catalogs etc., small fixed cost) +
//           fault the page-groups covering the first query's touched blocks.
//           Faults are serial unless prefetch is on (then they parallelize, as
//           query-plan frontrunning issues them all up front).
//
// Each cell records TTFQ(lazy) p50/p99, eager p50/p99, bytes transferred both,
// fault count, requests issued, winner + margin. Written incrementally to JSONL
// so an interrupted run still yields data.
//
// Run: node experiments/lazy-restore-spike/sweep.mjs [footprintsFile] [outFile] [iters]

import { dirname, join } from 'node:path'
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  PROVIDER_PROFILES, makeRng, modelRequests, coalesceToGroups, transferMs, sampleTTFB, withTTFB,
} from './store-model.mjs'

const HERE = dirname(new URL(import.meta.url).pathname)
const footprintsFile = process.argv[2] || join(HERE, 'footprints.jsonl')
const outFile = process.argv[3] || join(HERE, 'sweep-results.jsonl')
const ITERS = Number(process.argv[4] || 400) // iterations per cell for p50/p99

// Eager set: catalogs + control + small plumbing downloaded before first query
// in the LAZY path. Modeled as a fixed small payload fetched in parallel chunks.
const EAGER_SET_BYTES = 6 * 1024 * 1024 // ~6MB, size-independent (ESTIMATE)
const EAGER_SET_CHUNK = 1 * 1024 * 1024

// Group sizes (object-layer coalescing of 8KB blocks) to sweep.
const GROUP_SIZES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]

// Provider profiles to sweep.
const PROFILES = Object.keys(PROVIDER_PROFILES)

// Prefetch modes: off (serial reactive faults) vs query-plan frontrunning
// (all touched groups issued up front, bounded by parallelism).
const PREFETCH = [false, true]

// Latency-sensitivity axis: vary modeled first-byte latency (ms) for ONE
// representative profile to see how far the crossover moves. This isolates the
// single biggest unknown (real GCS/S3 first-byte latency).
const LATENCY_SWEEP_MS = [5, 15, 30, 60, 120]
const LATENCY_REF_PROFILE = 'gcs-same-region'

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// One LAZY trial: eager-set download (parallel) + faults for the touched groups.
// If prefetch: all group GETs issued together (parallel, capped). If not:
// faults happen serially on the query's request path (one TTFB each, no overlap).
function lazyTrialMs(groupSizes, profile, rng, prefetch) {
  // Eager set (always parallel - it is a bulk pre-fetch before open).
  const eagerChunks = []
  for (let b = 0; b < EAGER_SET_BYTES; b += EAGER_SET_CHUNK) {
    eagerChunks.push(Math.min(EAGER_SET_CHUNK, EAGER_SET_BYTES - b))
  }
  const eager = modelRequests(eagerChunks, profile, rng).wallMs

  let faultMs
  if (groupSizes.length === 0) {
    faultMs = 0
  } else if (prefetch) {
    // Query-plan frontrunning: issue all group GETs up front, parallel-capped.
    faultMs = modelRequests(groupSizes, profile, rng).wallMs
  } else {
    // Reactive serial faults: each is a full blocking RTT on the request path.
    faultMs = 0
    for (const bytes of groupSizes) {
      faultMs += sampleTTFB(profile, rng) + transferMs(bytes, profile)
    }
  }
  const bytes = EAGER_SET_BYTES + groupSizes.reduce((a, b) => a + b, 0)
  return { ms: eager + faultMs, bytes, requests: eagerChunks.length + groupSizes.length }
}

// One EAGER trial: download the whole datadir (parallel, bandwidth-bound), then
// the first query runs locally (negligible vs transfer). Datadir ~= relation +
// overhead; we model datadir bytes as relSize * 1.15 (indexes, catalogs, wal).
function eagerTrialMs(datadirBytes, profile, rng) {
  const chunk = 4 * 1024 * 1024
  const chunks = []
  for (let b = 0; b < datadirBytes; b += chunk) chunks.push(Math.min(chunk, datadirBytes - b))
  const r = modelRequests(chunks, profile, rng)
  return { ms: r.wallMs, bytes: datadirBytes, requests: chunks.length }
}

function loadFootprints(file) {
  if (!existsSync(file)) {
    console.error('footprints file not found:', file, '- run calibrate.mjs first')
    process.exit(1)
  }
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const footprints = loadFootprints(footprintsFile)
console.error(`loaded ${footprints.length} footprints from ${footprintsFile}`)

// Fresh output (header line as a comment-ish record).
writeFileSync(outFile, '')
const meta = {
  _meta: true,
  iters: ITERS,
  groupSizes: GROUP_SIZES,
  profiles: PROFILES,
  prefetch: PREFETCH,
  latencySweepMs: LATENCY_SWEEP_MS,
  latencyRefProfile: LATENCY_REF_PROFILE,
  eagerSetBytes: EAGER_SET_BYTES,
  datadirOverhead: 1.15,
  note: 'object-store latency/bandwidth are ESTIMATES (store-model.mjs); replace with measured GCS/S3 numbers',
  startedAt: new Date().toISOString(),
}
appendFileSync(outFile, JSON.stringify(meta) + '\n')

// Evaluate one cell: returns the full result record. `profile` is the (possibly
// latency-overridden) profile object; `profileName` is the label.
function evalCell(fp, profile, profileName, groupBytes, prefetch, extra = {}) {
  const datadirBytes = Math.round(fp.relSizeBytes * 1.15)
  const groupSizes = coalesceToGroups(fp.touchedBlocks, groupBytes)

  const lazySamples = new Float64Array(ITERS)
  const eagerSamples = new Float64Array(ITERS)
  let lazyBytes = 0, lazyReqs = 0, eagerBytes = 0, eagerReqs = 0
  const rng = makeRng(
    1 + (fp.sizeMB * 131) + profileName.length * 17 + groupBytes + (prefetch ? 7 : 0) +
    Math.round((profile.ttfbBaseMs || 0) * 1000) + (fp.shape ? fp.shape.length * 3 : 0),
  )
  for (let i = 0; i < ITERS; i++) {
    const l = lazyTrialMs(groupSizes, profile, rng, prefetch)
    const e = eagerTrialMs(datadirBytes, profile, rng)
    lazySamples[i] = l.ms
    eagerSamples[i] = e.ms
    lazyBytes = l.bytes; lazyReqs = l.requests
    eagerBytes = e.bytes; eagerReqs = e.requests
  }
  const lazySorted = Float64Array.from(lazySamples).sort()
  const eagerSorted = Float64Array.from(eagerSamples).sort()
  const lazyP50 = percentile(lazySorted, 50)
  const lazyP99 = percentile(lazySorted, 99)
  const eagerP50 = percentile(eagerSorted, 50)
  const eagerP99 = percentile(eagerSorted, 99)
  const winner = lazyP50 < eagerP50 ? 'lazy' : 'eager'
  const margin = eagerP50 / lazyP50

  return {
    sizeMB: fp.sizeMB,
    shape: fp.shape,
    profile: profileName,
    groupKB: groupBytes / 1024,
    prefetch,
    relSizeBytes: fp.relSizeBytes,
    datadirBytes,
    totalBlocks: fp.totalBlocks,
    touchedBlocks: fp.touchedCount,
    touchedFrac: +(fp.touchedCount / fp.totalBlocks).toFixed(5),
    relationsTouched: fp.relationsTouched,
    relationsTotal: fp.relationsTotal,
    touchStddev: fp.touchStddev,
    groupsFaulted: groupSizes.length,
    lazyBytes,
    lazyRequests: lazyReqs,
    eagerBytes,
    eagerRequests: eagerReqs,
    lazyTTFQ_p50_ms: +lazyP50.toFixed(1),
    lazyTTFQ_p99_ms: +lazyP99.toFixed(1),
    eagerFull_p50_ms: +eagerP50.toFixed(1),
    eagerFull_p99_ms: +eagerP99.toFixed(1),
    winner,
    speedup_lazy_vs_eager: +margin.toFixed(2),
    iters: ITERS,
    ...extra,
  }
}

const cells = []
for (const fp of footprints) {
  for (const profileName of PROFILES) {
    for (const groupBytes of GROUP_SIZES) {
      for (const prefetch of PREFETCH) {
        cells.push({ fp, profileName, groupBytes, prefetch })
      }
    }
  }
}
console.error(`main sweep: ${cells.length} cells x ${ITERS} iters`)

const tStart = Date.now()
let done = 0
for (const cell of cells) {
  const { fp, profileName, groupBytes, prefetch } = cell
  const profile = PROVIDER_PROFILES[profileName]
  const rec = evalCell(fp, profile, profileName, groupBytes, prefetch, { pass: 'main' })
  appendFileSync(outFile, JSON.stringify(rec) + '\n')
  done++
  if (done % 25 === 0 || done === cells.length) {
    console.error(`[${done}/${cells.length}] ${fp.sizeMB}MB ${fp.shape} ` +
      `${profileName} grp=${groupBytes / 1024}KB pf=${prefetch} -> ` +
      `lazy ${rec.lazyTTFQ_p50_ms}ms vs eager ${rec.eagerFull_p50_ms}ms = ${rec.winner} (${rec.speedup_lazy_vs_eager}x) ` +
      `[${((Date.now() - tStart) / 1000).toFixed(0)}s]`)
  }
}
console.error(`main sweep done (${((Date.now() - tStart) / 1000).toFixed(0)}s)`)

// ---------------------------------------------------------------------------
// Latency-sensitivity pass: vary modeled first-byte latency for one profile,
// fixed at prefetch ON + 1MB groups (the recommended operating point), across
// all footprints. Records carry pass:'latency' and a latencyMs field so analyze
// can build the "crossover vs latency" table.
// ---------------------------------------------------------------------------
console.error(`latency sweep: ${LATENCY_SWEEP_MS.length} latencies x ${footprints.length} footprints`)
const baseProfile = PROVIDER_PROFILES[LATENCY_REF_PROFILE]
for (const latencyMs of LATENCY_SWEEP_MS) {
  const profile = withTTFB(baseProfile, latencyMs)
  for (const fp of footprints) {
    const rec = evalCell(fp, profile, LATENCY_REF_PROFILE, 1024 * 1024, true, {
      pass: 'latency', latencyMs,
    })
    appendFileSync(outFile, JSON.stringify(rec) + '\n')
  }
}
console.error('sweep done ->', outFile, `(${((Date.now() - tStart) / 1000).toFixed(0)}s total)`)
