// Sync-over-async bridge: correctness proof + per-call overhead microbenchmark.
//
// Proves the load-bearing mechanism of V2 Section 4: a SYNCHRONOUS function on
// the main thread that blocks (Atomics.wait) while a worker thread performs an
// async read and Atomics.notify()s back. Two things are measured:
//   1. Correctness: bytes round-trip intact vs the source file (per call).
//   2. The per-call overhead of the BRIDGE ITSELF (Atomics block/notify +
//      thread handoff), with the simulated network delay set to 0 so we isolate
//      the mechanism, not the fake latency.
//
// Run:  node experiments/lazy-restore-spike/bridge-bench.mjs
// Env:  ITERS, BLOCK (bytes), DELAY_MS (artificial async delay)

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ITERS = Number(process.env.ITERS ?? 20000)
const BLOCK = Number(process.env.BLOCK ?? 8192) // Postgres BLCKSZ default
const DELAY_MS = Number(process.env.DELAY_MS ?? 0) // 0 => isolate bridge overhead
const CORRECTNESS_SAMPLES = 256

// --- Build a backing file of known random content under the OS temp dir. ---
const dir = mkdtempSync(join(tmpdir(), 'lazy-restore-bridge-'))
const filePath = join(dir, 'backing.bin')
const FILE_BYTES = Math.max(BLOCK * 1024, 16 * 1024 * 1024) // >=16MB
const fileBuf = randomBytes(FILE_BYTES)
writeFileSync(filePath, fileBuf)
const numBlocks = Math.floor(FILE_BYTES / BLOCK)

// --- Shared buffers. ---
const CTRL_SLOTS = 6
const controlSab = new SharedArrayBuffer(CTRL_SLOTS * Int32Array.BYTES_PER_ELEMENT)
const dataSab = new SharedArrayBuffer(BLOCK)
const ctrl = new Int32Array(controlSab)
const dataView = new Uint8Array(dataSab)

const REQUEST = 0
const RESPONSE = 1
const OFFSET = 2
const LENGTH = 3
const RESULT = 4
const SHUTDOWN = 5

const worker = new Worker(join(__dirname, 'bridge-worker.mjs'), {
  workerData: { controlSab, dataSab, filePath, artificialDelayMs: DELAY_MS },
})

await new Promise((r) => worker.on('online', r))

// --- The SYNCHRONOUS bridged read. This is the function a custom pglite
//     BaseFilesystem.read() would call. No await, no event-loop yield. ---
function readBlockSync(offset, length) {
  // Publish the request parameters.
  Atomics.store(ctrl, OFFSET, offset)
  Atomics.store(ctrl, LENGTH, length)
  Atomics.store(ctrl, RESULT, 0)
  Atomics.store(ctrl, RESPONSE, 0)

  // Signal "request pending" and wake the worker.
  Atomics.store(ctrl, REQUEST, 1)
  Atomics.notify(ctrl, REQUEST, 1)

  // Block this (main) thread until the worker flips RESPONSE to 1.
  // This is the load-bearing trick: a sync stall while async work happens.
  Atomics.wait(ctrl, RESPONSE, 0)

  const n = Atomics.load(ctrl, RESULT)
  if (n < 0) throw new Error('bridge read failed, errno ' + n)
  // Copy the bytes out of the shared buffer into a private buffer, mimicking
  // writing into the emscripten HEAP at the read offset.
  return Uint8Array.prototype.slice.call(dataView, 0, n)
}

// --- 1. Correctness: random blocks must match the source file exactly. ---
let mismatches = 0
for (let i = 0; i < CORRECTNESS_SAMPLES; i++) {
  const blk = (Math.random() * numBlocks) | 0
  const offset = blk * BLOCK
  const got = readBlockSync(offset, BLOCK)
  const want = fileBuf.subarray(offset, offset + BLOCK)
  if (Buffer.compare(Buffer.from(got), Buffer.from(want)) !== 0) mismatches++
}
const correctnessOk = mismatches === 0

// Extra correctness: hash a contiguous span read block-by-block THROUGH the
// bridge, compare to hashing those same bytes directly. This proves no offset
// drift across many sequential calls. Capped span so delayed runs stay quick
// (offset correctness is independent of the artificial delay).
const ROUNDTRIP_BLOCKS = Math.min(numBlocks, 512)
const hAll = createHash('sha256')
for (let blk = 0; blk < ROUNDTRIP_BLOCKS; blk++) {
  const got = readBlockSync(blk * BLOCK, BLOCK)
  hAll.update(got)
}
const bridgeHash = hAll.digest('hex')
const directHash = createHash('sha256')
  .update(fileBuf.subarray(0, ROUNDTRIP_BLOCKS * BLOCK))
  .digest('hex')
const fullFileRoundtripOk = bridgeHash === directHash

// --- 2. Overhead microbenchmark. ---
// Warm up (fewer iterations when an artificial delay dominates).
const WARMUP = DELAY_MS > 0 ? 50 : 2000
for (let i = 0; i < WARMUP; i++) readBlockSync((((i % numBlocks) | 0) * BLOCK), BLOCK)

const samples = new Float64Array(ITERS)
for (let i = 0; i < ITERS; i++) {
  const offset = (((i % numBlocks) | 0) * BLOCK)
  const t0 = process.hrtime.bigint()
  readBlockSync(offset, BLOCK)
  const t1 = process.hrtime.bigint()
  samples[i] = Number(t1 - t0) / 1000 // microseconds
}

// Shutdown the worker cleanly (no rm; OS reclaims the temp dir).
Atomics.store(ctrl, SHUTDOWN, 1)
Atomics.store(ctrl, REQUEST, 1)
Atomics.notify(ctrl, REQUEST, 1)
await worker.terminate()

// --- Stats. ---
const sorted = Float64Array.from(samples).sort()
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
const mean = samples.reduce((a, b) => a + b, 0) / samples.length
const throughputPerSec = 1e6 / mean

const report = {
  config: { ITERS, BLOCK, DELAY_MS, FILE_BYTES, numBlocks, node: process.version },
  correctness: {
    randomSamples: CORRECTNESS_SAMPLES,
    mismatches,
    randomBlocksOk: correctnessOk,
    fullFileRoundtripOk,
    bridgeHash,
    directHash,
  },
  overheadUs: {
    note: 'per-call bridge overhead (block+notify+handoff), DELAY_MS excluded when 0',
    min: +sorted[0].toFixed(3),
    p50: +pct(50).toFixed(3),
    p90: +pct(90).toFixed(3),
    p99: +pct(99).toFixed(3),
    p999: +pct(99.9).toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
    mean: +mean.toFixed(3),
  },
  callsPerSecond: Math.round(throughputPerSec),
}

console.log(JSON.stringify(report, null, 2))

if (!correctnessOk || !fullFileRoundtripOk) {
  console.error('CORRECTNESS FAILED')
  process.exit(1)
}
