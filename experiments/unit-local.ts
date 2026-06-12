// Store-less unit checks — the subset of correctness that needs no bucket.
// CI runs this on every push; the real suites (E0–E4) run against live GCS.
//
//   tsx experiments/unit-local.ts

import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { createTarStream, extractTarStream, largestFile } from '../packages/objectstore-fs/src/tar.js'
import { encodeManifest, decodeManifest, type Manifest } from '../packages/objectstore-fs/src/manifest.js'
import { section, assert, failureCount, resetFailures } from './_util.js'

async function tarRoundTrip() {
  section('tar: round-trip a nested tree byte-identically')
  const src = await mkdtemp(join(tmpdir(), 'zpg-tar-src-'))
  const dst = await mkdtemp(join(tmpdir(), 'zpg-tar-dst-'))
  try {
    await mkdir(join(src, 'base/5'), { recursive: true })
    await mkdir(join(src, 'pg_wal/archive_status'), { recursive: true })
    const files: Record<string, Buffer> = {
      'PG_VERSION': Buffer.from('17\n'),
      'base/5/16384': randomBytes(300_000),
      'base/5/empty': Buffer.alloc(0),
      'pg_wal/000000010000000000000001': randomBytes(64 * 1024),
      // exercise the 512-byte padding edge
      'base/5/exact-block': randomBytes(1024),
    }
    for (const [p, b] of Object.entries(files)) await writeFile(join(src, p), b)

    await extractTarStream(Readable.from(createTarStream(src)) as AsyncIterable<Uint8Array>, dst)
    for (const [p, b] of Object.entries(files)) {
      const got = await readFile(join(dst, p))
      assert(got.equals(b), `tar round-trip: ${p} identical (${b.length}B)`)
    }
    const dirs = await readdir(join(dst, 'pg_wal'))
    assert(dirs.includes('archive_status'), 'tar round-trip: empty dirs survive')

    const big = await largestFile(src)
    assert(big !== null && big.path.endsWith('base/5/16384'), 'largestFile skips pg_wal, finds heap')
  } finally {
    await rm(src, { recursive: true, force: true })
    await rm(dst, { recursive: true, force: true })
  }
}

async function tarRejectsTraversal() {
  section('tar: path traversal rejected')
  const dst = await mkdtemp(join(tmpdir(), 'zpg-tar-evil-'))
  try {
    // Hand-build a header for "../evil"
    const h = Buffer.alloc(512, 0)
    h.write('../evil', 0, 'ascii')
    h.write('0000644\0', 100, 'ascii')
    h.write('00000000000\0', 124, 'ascii') // size 0
    h.write('        ', 148, 'ascii')
    h.write('0', 156, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += h[i]
    Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(h, 148)
    let threw = false
    try {
      await extractTarStream(Readable.from([h, Buffer.alloc(1024, 0)]) as AsyncIterable<Uint8Array>, dst)
    } catch {
      threw = true
    }
    assert(threw, 'tar: "../" entry throws')
  } finally {
    await rm(dst, { recursive: true, force: true })
  }
}

function manifestCodec() {
  section('manifest: encode/decode stable, v1 compatible')
  const m: Manifest = {
    version: 2,
    generation: 'abc123',
    fencingToken: 7,
    snapshot: 'generations/abc123/snapshot-3-t7.tar',
    walSegments: [
      { key: 'generations/abc123/wal/00000004-t7.seg', startLsn: '0/1A2B3C4', endLsn: '0/1A2C000', crc32: 12345 },
    ],
    walFlushLsn: '0/1A2B3C4',
    walSegmentBytes: 16 * 1024 * 1024,
    walTimeline: 1,
    previousSnapshot: 'generations/abc123/snapshot-0-t1.tar.gz',
    commitSeq: 4,
    committedAt: '2026-06-12T00:00:00.000Z',
  }
  const back = decodeManifest(encodeManifest(m))
  assert(JSON.stringify(back) === JSON.stringify(m), 'manifest round-trips')
  const v1 = decodeManifest(
    new TextEncoder().encode(
      '{"version":1,"generation":"g","fencingToken":1,"snapshot":"generations/g/snapshot-0.tar.gz","walSegments":[],"commitSeq":0,"committedAt":"x"}',
    ),
  )
  assert(v1.version === 1 && v1.walSegments.length === 0, 'v1 manifests decode')
}

function lsnMath() {
  section('LSN math: parse/format/file mapping (mirrors xlog_internal.h)')
  // Mirror the (non-exported) helpers in zeropg.ts.
  const parseLsn = (s: string) => {
    const [hi, lo] = s.split('/')
    return (BigInt(parseInt(hi, 16)) << 32n) | BigInt(parseInt(lo, 16))
  }
  const formatLsn = (l: bigint) =>
    `${(l >> 32n).toString(16).toUpperCase()}/${(l & 0xffffffffn).toString(16).toUpperCase()}`
  const walFileName = (tli: number, lsn: bigint, segBytes: number) => {
    const segno = lsn / BigInt(segBytes)
    const perId = 0x1_0000_0000n / BigInt(segBytes)
    const hex = (n: bigint) => n.toString(16).toUpperCase().padStart(8, '0')
    return hex(BigInt(tli)) + hex(segno / perId) + hex(segno % perId)
  }
  const SEG = 16 * 1024 * 1024
  assert(formatLsn(parseLsn('0/43A40C0')) === '0/43A40C0', 'parse/format round-trip')
  assert(formatLsn(parseLsn('AB/CDEF0123')) === 'AB/CDEF0123', 'parse/format >4GB')
  // Known mapping: LSN 0/4000000 = segno 4 -> ...000000004 (16MB segments)
  assert(walFileName(1, parseLsn('0/4000028'), SEG) === '000000010000000000000004', 'file name for 0/4000028')
  // Cross the per-XLogId boundary: segno 256 -> hi increments
  assert(walFileName(1, 256n * BigInt(SEG), SEG) === '000000010000000100000000', 'file name at 4GB boundary')
  assert(parseLsn('0/43A40D8') - parseLsn('0/43A40C0') === 24n, 'the famous 24 bytes')
}

async function main() {
  resetFailures()
  await tarRoundTrip()
  await tarRejectsTraversal()
  manifestCodec()
  lsnMath()
  section(failureCount() === 0 ? '✅ unit-local PASSED' : `❌ ${failureCount()} FAILURES`)
  process.exit(failureCount() === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
