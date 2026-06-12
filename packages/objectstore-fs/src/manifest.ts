// The manifest is THE commit point (DESIGN.md 4.2). It is a single small JSON
// object, written only via conditional PUT. Swapping it atomically is what
// makes a commit a commit; everything else in the bucket is immutable data the
// manifest points at.
//
// v2 adds incremental WAL shipping: a commit appends `walSegments` entries
// (the new bytes of pg_wal files) instead of replacing the whole snapshot.
// The snapshot becomes a compaction artifact, refreshed when accumulated WAL
// passes a threshold. v1 manifests (version: 1, walSegments always []) decode
// and restore unchanged.

/** One shipped WAL range: the bytes of LSN range [startLsn, endLsn), exactly
 * as they lie in pg_wal segment files (which range may span). LSN addressing
 * (not file sizes) because Postgres preallocates segment files at their full
 * 16MB and fills them by overwrite — only the flush LSN says where WAL ends. */
export interface WalSegment {
  /** Object key (prefix-relative), immutable once PUT. */
  key: string
  /** WAL location where this range begins, as "X/Y" (pg_lsn text form). */
  startLsn: string
  /** WAL location one past the last byte (endLsn - startLsn = object size). */
  endLsn: string
  /** CRC32 of the range, verified on restore. */
  crc32: number
}

export interface Manifest {
  version: 1 | 2
  /** Random id bundling one snapshot + the WAL segments after it (Litestream). */
  generation: string
  /** The lease fencing token of the writer that produced this commit. */
  fencingToken: number
  /** Object key of the base snapshot for this generation. */
  snapshot: string
  /** Immutable WAL ranges to overlay on the snapshot, contiguous in LSN
   * order: walSegments[0].startLsn === walFlushLsn, and each entry starts
   * where the previous one ends. */
  walSegments: WalSegment[]
  /** The WAL flush location at the moment the snapshot was taken: the LSN
   * through which the snapshot's own pg_wal content is valid, and the point
   * incremental shipping resumes from. Present in version 2 manifests. */
  walFlushLsn?: string
  /** WAL segment file size of this cluster (bytes). Needed to map LSNs onto
   * pg_wal file names during restore, before Postgres is running. */
  walSegmentBytes?: number
  /** Timeline ID for pg_wal file naming. PGlite databases stay on 1. */
  walTimeline?: number
  /** The previous compaction's snapshot, kept as a backup (GC preserves it).
   * Restore never needs it; it exists so a corrupted current state has a
   * one-compaction-old fallback. */
  previousSnapshot?: string
  /** Monotonic commit counter (stands in for the LSN in v0). */
  commitSeq: number
  committedAt: string
  /** Set by `migrate-out`: any instance booting from the bucket should refuse
   * and point users at the new home instead of resurrecting stale data. */
  movedTo?: string
}

export const MANIFEST_KEY = 'manifest.json'

export function encodeManifest(m: Manifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m, null, 2))
}

export function decodeManifest(bytes: Uint8Array): Manifest {
  return JSON.parse(new TextDecoder().decode(bytes)) as Manifest
}
