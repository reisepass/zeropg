// Bucket fetch worker for the sync-over-async bridge (REAL object store).
//
// Production sibling of bridge-worker.mjs. That one read a local file to isolate
// the bridge mechanism; this one does a real ranged GET against GCS or R2 via
// the existing @zeropg/blobstore stores - no hand-rolled SigV4, no SDK.
//
// Division of labour (deliberate): the WORKER is stateless and does exactly one
// thing - given (keyId, groupIdx), range-GET that one 1MB page-group and write
// the WHOLE group into the shared data buffer. The CACHE lives on the MAIN
// thread (LazyFS), which copies the caller's sub-range out of the cached group
// and serves every later read in that group with zero round-trips. Keeping the
// cache on the main thread is what lets query-plan frontrunning prefetch groups
// CONCURRENTLY with its own async blobstore client (no sync constraint between
// queries) and fill the same cache the synchronous fault path reads.
//
// Control SAB (Int32Array), one slot = 4 bytes:
//   [0] REQUEST   : main sets 1 to signal "request pending"; worker waits on it
//   [1] RESPONSE  : worker sets 1 when the group is ready; main waits on it
//   [2] KEY_ID    : index into relKeys (which relation file to fault)
//   [3] GROUP_IDX : which 1MB group of that object to fetch
//   [4] RESULT    : bytes written into dataSab (the group length, <=groupBytes),
//                   or negative errno on error
//   [5] LAT_US    : measured range-GET latency in microseconds
//   [6] COLD_PROC : 1 if this was the FIRST GET in the process (cold connection:
//                   DNS + TLS + auth), 0 once the connection is warm
//   [7] SHUTDOWN  : main sets 1 to ask the worker to exit
//
// Data SAB: the fetched group's raw bytes [0, RESULT).

import { workerData, parentPort } from 'node:worker_threads'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'

const {
  controlSab,
  dataSab,
  provider, // 'gcs' | 'r2'
  gcs, // { bucket, prefix }
  r2, // R2Options (resolved from env on the main thread)
  relKeys, // string[] indexed by KEY_ID
  relVersions, // string[] pinned generation/etag per key, or null
  groupBytes = 1 << 20, // 1MB page-group
} = workerData

const REQUEST = 0
const RESPONSE = 1
const KEY_ID = 2
const GROUP_IDX = 3
const RESULT = 4
const LAT_US = 5
const COLD_PROC = 6
const SHUTDOWN = 7

const ctrl = new Int32Array(controlSab)
const data = new Uint8Array(dataSab)

let store
if (provider === 'gcs') store = new GcsBlobStore({ bucket: gcs.bucket, prefix: gcs.prefix })
else if (provider === 'r2') store = new R2BlobStore(r2)
else throw new Error(`bucket-bridge-worker: unknown provider ${provider}`)

let firstGetDone = false
let getCount = 0
const latLog = [] // { keyId, groupIdx, bytes, latUs, coldProc }

async function fetchGroup(keyId, groupIdx) {
  const key = relKeys[keyId]
  const version = relVersions ? relVersions[keyId] : undefined
  const start = groupIdx * groupBytes
  const end = start + groupBytes - 1 // inclusive; the store clamps at EOF
  const opts = { range: { start, end } }
  if (version) opts.ifVersion = version
  const res = await store.get(key, opts)
  if (!res) throw new Error(`bridge: ${key} group ${groupIdx} null (missing or version moved)`)
  return res.bytes
}

async function handleOne() {
  const keyId = Atomics.load(ctrl, KEY_ID)
  const groupIdx = Atomics.load(ctrl, GROUP_IDX)
  const coldProc = firstGetDone ? 0 : 1

  const t0 = process.hrtime.bigint()
  const bytes = await fetchGroup(keyId, groupIdx)
  const latUs = Number(process.hrtime.bigint() - t0) / 1000

  firstGetDone = true
  getCount++
  data.set(bytes.subarray(0, Math.min(bytes.length, data.length)), 0)

  latLog.push({ keyId, groupIdx, bytes: bytes.length, latUs, coldProc })

  Atomics.store(ctrl, RESULT, bytes.length)
  Atomics.store(ctrl, LAT_US, Math.round(latUs))
  Atomics.store(ctrl, COLD_PROC, coldProc)
}

// Out-of-band channel for telemetry drain (latency log goes back to the main
// thread after a run for the measured table).
parentPort?.on('message', (msg) => {
  if (msg?.type === 'drainLatLog') {
    parentPort.postMessage({ type: 'latLog', latLog: latLog.slice(), getCount })
  }
})

async function loop() {
  for (;;) {
    Atomics.wait(ctrl, REQUEST, 0)
    if (Atomics.load(ctrl, SHUTDOWN) === 1) break
    Atomics.store(ctrl, REQUEST, 0)
    try {
      await handleOne()
    } catch (e) {
      Atomics.store(ctrl, RESULT, -1)
      Atomics.store(ctrl, LAT_US, 0)
      parentPort?.postMessage({ type: 'error', message: String(e?.message ?? e) })
    }
    Atomics.store(ctrl, RESPONSE, 1)
    Atomics.notify(ctrl, RESPONSE, 1)
  }
}

loop()
