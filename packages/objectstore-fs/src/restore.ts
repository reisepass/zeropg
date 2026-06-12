// Restore: materialize a manifest's state into a local scratch directory.
// Shared by the writer (ZeroPG) and read replicas (ZeroPGReplica) — one
// battle-tested path (E2/E2b/E2c/e4b) for both.

import { type BlobStore } from '@zeropg/blobstore'
import { type Manifest, type WalSegment } from './manifest.js'
import { extractTarStream } from './tar.js'
import { createGunzip, crc32 } from 'node:zlib'
import { Readable } from 'node:stream'
import * as nodeStream from 'node:stream'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

// stream.compose() exists at runtime since Node 16.9 but @types/node omits it.
const compose = (nodeStream as unknown as {
  compose: (...streams: unknown[]) => Readable
}).compose

export function parseLsn(s: string): bigint {
  const [hi, lo] = s.split('/')
  return (BigInt(parseInt(hi, 16)) << 32n) | BigInt(parseInt(lo, 16))
}
export function formatLsn(l: bigint): string {
  return `${(l >> 32n).toString(16).toUpperCase()}/${(l & 0xffffffffn).toString(16).toUpperCase()}`
}
/** Mirrors XLogFileName()/XLByteToSeg() in xlog_internal.h. */
export function walFileName(tli: number, lsn: bigint, segBytes: number): string {
  const segno = lsn / BigInt(segBytes)
  const perId = 0x1_0000_0000n / BigInt(segBytes)
  const hex = (n: bigint) => n.toString(16).toUpperCase().padStart(8, '0')
  return hex(BigInt(tli)) + hex(segno / perId) + hex(segno % perId)
}

/** Stream a snapshot object into dir; returns its stored size. The key
 * suffix says whether it is gzipped (.tar.gz) or raw tar (.tar). */
export async function restoreSnapshotInto(
  store: BlobStore,
  dir: string,
  snapshotKey: string,
): Promise<number> {
  const src = await store.getStream(snapshotKey)
  if (!src) throw new Error(`manifest references missing snapshot ${snapshotKey}`)
  const tarStream = snapshotKey.endsWith('.gz')
    ? compose(Readable.from(src.stream), createGunzip())
    : Readable.from(src.stream)
  await extractTarStream(tarStream as AsyncIterable<Uint8Array>, dir)
  return src.size
}

/** Overlay shipped WAL ranges onto the restored datadir: fetch concurrently
 * (small objects), verify CRC + LSN continuity, write each range into the
 * pg_wal segment file(s) it spans at the LSN-derived offsets. */
export async function applyWalSegments(store: BlobStore, dir: string, m: Manifest): Promise<void> {
  const segments = m.walSegments
  if (segments.length === 0) return
  if (!m.walFlushLsn || !m.walSegmentBytes) {
    throw new Error('manifest has WAL segments but no walFlushLsn/walSegmentBytes')
  }
  const segBytes = m.walSegmentBytes
  const tli = m.walTimeline ?? 1
  // Continuity: first range starts at the snapshot's flush LSN, each next
  // range starts where the previous ended. A gap would mean a hole in the
  // replay stream — refuse loudly rather than boot a half-restored DB.
  let expect = parseLsn(m.walFlushLsn)
  for (const seg of segments) {
    if (parseLsn(seg.startLsn) !== expect) {
      throw new Error(`WAL range gap: expected ${formatLsn(expect)}, got ${seg.startLsn} (${seg.key})`)
    }
    expect = parseLsn(seg.endLsn)
  }
  const bodies = await Promise.all(
    segments.map(async (seg: WalSegment) => {
      const obj = await store.get(seg.key)
      if (!obj) throw new Error(`manifest references missing WAL segment ${seg.key}`)
      const want = Number(parseLsn(seg.endLsn) - parseLsn(seg.startLsn))
      if (obj.bytes.byteLength !== want) {
        throw new Error(`WAL segment ${seg.key}: size ${obj.bytes.byteLength} != ${want}`)
      }
      if ((crc32(obj.bytes) >>> 0) !== seg.crc32) {
        throw new Error(`WAL segment ${seg.key}: CRC mismatch`)
      }
      return obj.bytes
    }),
  )
  const touched = new Set<string>()
  for (let i = 0; i < segments.length; i++) {
    const body = bodies[i]
    let pos = parseLsn(segments[i].startLsn)
    let bodyOff = 0
    while (bodyOff < body.byteLength) {
      const offInFile = Number(pos % BigInt(segBytes))
      const take = Math.min(body.byteLength - bodyOff, segBytes - offInFile)
      const path = join(dir, 'pg_wal', walFileName(tli, pos, segBytes))
      touched.add(path)
      // Create-if-missing without truncating, then write at the offset.
      const fh = await open(path, 'a').then(async (h) => {
        await h.close()
        return open(path, 'r+')
      })
      try {
        await fh.write(body, bodyOff, take, offInFile)
      } finally {
        await fh.close()
      }
      pos += BigInt(take)
      bodyOff += take
    }
  }
  // Postgres reads WAL in full 8KB pages and treats a short read at EOF as
  // end-of-WAL: a segment file that ends mid-page silently truncates replay
  // at the previous page boundary (measured: a restore dropped the last 5KB
  // of a commit — including its commit record — exactly this way). Extend
  // every touched file to the full segment size; the zero tail is sparse on
  // disk and reads as an invalid record, ending replay precisely at the last
  // shipped byte, the same as the writer's own preallocated files.
  for (const path of touched) {
    const fh = await open(path, 'r+')
    try {
      const st = await fh.stat()
      if (st.size < segBytes) await fh.truncate(segBytes)
    } finally {
      await fh.close()
    }
  }
}
