// Fetch worker for the sync-over-async bridge.
//
// It blocks on Atomics.wait against a shared control buffer, performs an ASYNC
// read (here: a local file read, optionally with an artificial delay standing
// in for an object-store range GET), writes the bytes into a shared data
// buffer, then flips a status slot and Atomics.notify()s the main thread that
// is blocked waiting for exactly that slot.
//
// Control SAB layout (Int32Array view), one slot = 4 bytes:
//   [0] REQUEST  : main sets to 1 to signal "request pending", worker waits on it
//   [1] RESPONSE : worker sets to 1 when bytes are ready, main waits on it
//   [2] OFFSET   : file offset to read from
//   [3] LENGTH   : number of bytes requested
//   [4] RESULT   : bytes actually read (>=0), or negative errno on error
//   [5] SHUTDOWN : main sets to 1 to ask the worker to exit
//
// Data SAB: raw bytes; worker writes [0, RESULT) of the requested read here.

import { workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'

const { controlSab, dataSab, filePath, artificialDelayMs } = workerData

const ctrl = new Int32Array(controlSab)
const data = new Uint8Array(dataSab)

const REQUEST = 0
const RESPONSE = 1
const OFFSET = 2
const LENGTH = 3
const RESULT = 4
const SHUTDOWN = 5

function sleep(ms) {
  if (!ms) return Promise.resolve()
  return new Promise((r) => setTimeout(r, ms))
}

const fh = await open(filePath, 'r')

// Main loop. We block (Atomics.wait) until the main thread posts a request.
// This worker thread blocking is free - it is not the JS event loop of the
// main thread, and Atomics.wait is permitted off the main thread.
while (true) {
  // Wait until REQUEST flips to 1 (or proceed immediately if already 1).
  Atomics.wait(ctrl, REQUEST, 0)

  if (Atomics.load(ctrl, SHUTDOWN) === 1) {
    break
  }

  const offset = Atomics.load(ctrl, OFFSET)
  const length = Atomics.load(ctrl, LENGTH)

  // Consume the request flag so the next round starts clean.
  Atomics.store(ctrl, REQUEST, 0)

  let result
  try {
    // The async part: stand-in for a range GET + decrypt + decompress.
    await sleep(artificialDelayMs)
    // Read straight into the shared data buffer (a Uint8Array view over the SAB)
    // so there is no extra copy on the worker side.
    const { bytesRead } = await fh.read(data, 0, length, offset)
    result = bytesRead
  } catch (e) {
    result = -1
  }

  Atomics.store(ctrl, RESULT, result)
  // Publish the response and wake the main thread.
  Atomics.store(ctrl, RESPONSE, 1)
  Atomics.notify(ctrl, RESPONSE, 1)
}

await fh.close()
