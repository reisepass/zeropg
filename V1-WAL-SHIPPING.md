# v1: incremental WAL shipping - implementation plan

Status: NOT BUILT. v0 ships a full datadir snapshot per commit (9.2s writes on the 50MB demo). This is the plan to make writes O(transaction size) instead of O(database size). This is now the top development priority.

## Why we don't need per-write VFS interception (v1 shortcut)

With `wal_recycle=off` (already set in zeropg.ts), files under `pg_wal/` are append-only from creation to unlink - Postgres never rewrites shipped bytes. So incremental capture is just commit-time diffing:

- Keep an in-memory map `highWater: { walFileName -> byteOffsetShipped }`.
- At commit, scan `pg_wal/` in MemoryFS: any file larger than its high-water mark (or not in the map) has new bytes to ship.
- Unlinked files drop out of the map; their shipped bytes live on in the bucket until GC.

No Emscripten hooks, no shadow WAL. (v2 can move to true write interception if commit-time scanning ever shows up in profiles.)

## Manifest v2

```json
{
  "version": 2,
  "generation": "9f3ac41e8d27b06a",
  "fencingToken": 17,
  "snapshot": "snapshot-0_2F000158.tar.gz",
  "walSegments": [
    { "key": "wal/17-00000000.seg.gz", "file": "000000010000000000000003", "start": 0, "end": 81920, "crc32": "..." },
    { "key": "wal/17-00000001.seg.gz", "file": "000000010000000000000003", "start": 81920, "end": 98304, "crc32": "..." }
  ],
  "lsn": "0/2F0001A8",
  "committedAt": "..."
}
```

A segment object = the new bytes of ONE pg_wal file over a byte range (one commit may produce several if a WAL file switch happened mid-batch). Object name embeds fencing token + monotonic seq, as designed.

## Commit path (replaces per-commit snapshot)

1. `afterWrite()` -> scan `pg_wal/` against `highWater`.
2. For each grown file: read new bytes, gzip, plain PUT as immutable segment object. (Parallel PUTs OK; order doesn't matter, the manifest list is the order.)
3. CAS manifest appending the new segment entries. This is the commit. On precondition failure: FencedError, as today.
4. Advance `highWater` only after the CAS succeeds (a failed commit must re-ship those bytes next time - idempotent because segment objects are immutable and uniquely named).
5. NO checkpoint, NO dumpTar, NO snapshot upload in this path anymore.

Expected strict-mode write latency: one small PUT (~40-60ms p50, E0 data) + manifest CAS (~60ms) ≈ 100-150ms, flat for any DB size. Verify against the 50MB demo (currently 9,265ms).

## Snapshot = compaction, not commit

- Trigger: accumulated unshipped-snapshot WAL > threshold (start: 16MB or 64 segments or 5 minutes, whichever first - tune in E2c) OR generation continuity doubt (as today).
- Action: exactly v0's path - double CHECKPOINT, trim pg_wal, dumpTar, upload, CAS manifest with `walSegments: []`.
- The double-CHECKPOINT before snapshot guarantees the snapshot's pg_control points at a checkpoint at-or-after every shipped segment's LSN, so restore never needs segments older than the snapshot.

## Restore path

1. GET manifest, download + untar snapshot into MemoryFS (as today).
2. For each `walSegments` entry in order: gunzip, verify crc32, write bytes into `pg_wal/<file>` at `[start, end)` - creating the file if the snapshot didn't contain it, extending as needed.
3. Boot PGlite. Postgres crash recovery reads pg_control's checkpoint (from the snapshot), replays WAL forward through the applied segments, stops at the last valid record (CRC-guarded against a torn tail - can't happen anyway since the manifest only references fully-PUT segments).
4. CRITICAL ordering (E4 probe 5): acquire the lease BEFORE adopting the manifest, or re-GET the manifest etag after acquisition and re-restore if it moved. Fixes the stale-restore race on instance handoff.

## No snapshot at startup (deliberate divergence from Litestream)

Litestream snapshots on every process start because, as an external observer with no lease and no manifest, it cannot prove bucket-vs-local continuity after downtime - so it starts a new generation defensively. We can always prove continuity: local state is derived FROM the manifest under the lease. Wake-up is downloads only; the first write appends to the existing generation. Fresh snapshots happen only on continuity doubt (fenced/unclean predecessor, missing segment, failed precondition) or threshold compaction.

**Trap - high-water initialization after restore:** Postgres writes WAL during recovery itself (end-of-recovery checkpoint record), so local pg_wal extends past what the manifest's segments cover. Initialize `highWater` from the manifest's recorded segment end-offsets, NOT from local file sizes at boot - otherwise the recovery bytes never ship, leaving a silent gap that truncates the NEXT restore at that LSN. Test: wake → commit → wake again → verify both commits present (E2c roundtrip already covers this if it reopens twice).

## Open items to verify while building

- `wal_segment_size` in the WASM build (likely 16MB default): only matters for the scan granularity, but confirm.
- That `pg_wal/archive_status/` and timeline files in the snapshot don't confuse recovery after segment overlay (expected fine; the crash harness will say).
- Relaxed mode: batch the scan/ship on timer + close/flush - same code path, deferred.
- GC: orphaned segments from failed commits and superseded generations - extend the existing cleanup.

## Tests (E2c - extend the crash harness)

1. Roundtrip: 500 single-row commits across 3 reopens at 1MB/50MB/500MB DB sizes; verify contents + that NO snapshot upload happened between compactions (assert on bucket listing).
2. Latency: assert p50 strict-commit < 300ms at 500MB (vs 9.2s today on 50MB).
3. Crash matrix: SIGKILL between segment PUT and manifest CAS (x20), mid-segment-PUT (x20), mid-compaction (x20) - every reopen is a clean pre- or post-commit state, replaying segments through Postgres recovery.
4. WAL-file-switch boundary: force commits that straddle a 16MB segment switch; verify multi-entry commit restores correctly.
5. Fencing: zombie ships a segment then loses CAS - segment is orphaned garbage, successor never references it (extend E1 zombie test to v2 manifests).
