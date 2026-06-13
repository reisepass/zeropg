// Step 3 (focused): unit-level proof that LazyFS.read - the EXACT method
// pglite's stream_ops.read delegates to (NOTES-pglite-fs.md, src/fs/base.ts:438)
// - intercepts block reads on a chosen file and serves byte-correct data from a
// separate backing store, while leaving non-intercepted files untouched.
//
// We drive LazyFS through the same call shape pglite uses:
//   fd = open(path);  n = read(fd, heapView, offset, length, position);  close(fd)
// where `heapView` is a Uint8Array over an ArrayBuffer, mimicking the emscripten
// HEAP. We compare bytes read through the intercept against the known source.
//
// This isolates the load-bearing claim ("we own the synchronous read and can
// supply correct bytes") from the separate, larger task of hand-rolling a fully
// writable VFS that satisfies Postgres's boot/create path (see RESULTS.md
// "Step 3" for why the full end-to-end boot POC is gated on that FS work).
//
// Run: node experiments/lazy-restore-spike/intercept-unit.mjs

import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, openSync, writeSync, closeSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'

const BLOCK = 8192 // Postgres BLCKSZ
const N_BLOCKS = 64 // 512KB "relation"

const work = mkdtempSync(join(tmpdir(), 'lazy-unit-'))
const dataDir = join(work, 'pgdata')
const remoteDir = join(work, 'remote')
mkdirSync(join(dataDir, 'base', '5'), { recursive: true })
mkdirSync(join(remoteDir, 'base', '5'), { recursive: true })

// "Lazy" relation file (intercepted) and a "normal" file (not intercepted).
const relRel = join('base', '5', '16384')
const otherRel = join('base', '5', 'PG_VERSION_LIKE')
const relPath = join(dataDir, relRel)
const otherPath = join(dataDir, otherRel)

const relBytes = randomBytes(BLOCK * N_BLOCKS)
const otherBytes = randomBytes(BLOCK * 3)
writeFileSync(relPath, relBytes)
writeFileSync(otherPath, otherBytes)

// Externalize the relation to the remote store, then ZERO the datadir copy so
// only a working intercept can produce the real bytes.
cpSync(relPath, join(remoteDir, relRel))
{
  const fd = openSync(relPath, 'r+')
  writeSync(fd, Buffer.alloc(relBytes.length), 0, relBytes.length, 0)
  closeSync(fd)
}

const lazy = new LazyFS(dataDir, {
  remoteDir,
  interceptMatch: (rp) => rp.endsWith(join('base', '5', '16384')),
})

// Helper that mimics pglite stream_ops.read: a Uint8Array over an ArrayBuffer
// "heap", read at an offset within it.
function readBlock(fd, fileOffset) {
  const heap = new ArrayBuffer(BLOCK * 2)
  const view = new Uint8Array(heap)
  const writeOffset = BLOCK // write into the middle, like a real heap ptr
  const n = lazy.read(fd, view, writeOffset, BLOCK, fileOffset)
  return Buffer.from(view.buffer, writeOffset, n)
}

// --- 1. Intercepted file: every block must match the ORIGINAL (remote) bytes,
//        not the zeroed datadir copy. ---
let mismatches = 0
const fdRel = lazy.open('/' + relRel)
for (let b = 0; b < N_BLOCKS; b++) {
  const got = readBlock(fdRel, b * BLOCK)
  const want = relBytes.subarray(b * BLOCK, (b + 1) * BLOCK)
  if (Buffer.compare(got, want) !== 0) mismatches++
}
lazy.close(fdRel)

// Hash the whole intercepted file via the read path; compare to source hash.
const fdRel2 = lazy.open('/' + relRel)
const h = createHash('sha256')
for (let b = 0; b < N_BLOCKS; b++) h.update(readBlock(fdRel2, b * BLOCK))
lazy.close(fdRel2)
const interceptHash = h.digest('hex')
const sourceHash = createHash('sha256').update(relBytes).digest('hex')

// --- 2. Non-intercepted file: must read straight from the datadir copy. ---
const fdOther = lazy.open('/' + otherRel)
const otherGot = readBlock(fdOther, 0)
lazy.close(fdOther)
const otherOk = Buffer.compare(otherGot, otherBytes.subarray(0, BLOCK)) === 0

// --- 3. Partial / offset reads (mid-file, sub-block) round-trip correctly. ---
const fdRel3 = lazy.open('/' + relRel)
const heap = new ArrayBuffer(4096)
const v = new Uint8Array(heap)
const pos = 12345
const len = 3000
const n = lazy.read(fdRel3, v, 100, len, pos)
const partialOk =
  n === len &&
  Buffer.compare(Buffer.from(v.buffer, 100, len), relBytes.subarray(pos, pos + len)) === 0
lazy.close(fdRel3)

const report = {
  blocks: N_BLOCKS,
  blockSize: BLOCK,
  intercept: {
    mismatches,
    allBlocksMatch: mismatches === 0,
    interceptHash,
    sourceHash,
    fullFileMatch: interceptHash === sourceHash,
    interceptedReadCount: lazy.interceptedReadCount,
    interceptedBytes: lazy.interceptedBytes,
  },
  nonIntercepted: { matchesDatadir: otherOk },
  partialOffsetRead: { ok: partialOk, n, requested: len },
  sampleInterceptedReads: lazy.readLog.slice(0, 3),
}
console.log(JSON.stringify(report, null, 2))

const pass =
  mismatches === 0 &&
  interceptHash === sourceHash &&
  otherOk &&
  partialOk &&
  lazy.interceptedReadCount > 0

if (pass) {
  console.log(
    '\nPASS: LazyFS.read intercepts the chosen relation file and returns byte-identical data from the remote store (datadir copy was zeroed), serves non-intercepted files from the datadir, and handles mid-file sub-block reads. This is the exact method pglite stream_ops.read calls.',
  )
  process.exit(0)
} else {
  console.error('\nFAIL', report)
  process.exit(1)
}
