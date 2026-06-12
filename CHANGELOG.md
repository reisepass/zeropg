# Changelog

All notable changes to zeropg. Dates are UTC.

## v1 (2026-06-12) — incremental WAL shipping

The headline: **writes are O(transaction size), not O(database size).**
Strict-durability commit wall p50 measured at 134ms (was 7,800ms in v0 on the
same 50MB database). Everything below is backed by live experiments on
Cloud Run + GCS — see [STATUS.md](STATUS.md) for the scoreboard and
`results/*.jsonl` for raw data.

### Added
- **Incremental commits**: each commit ships the WAL byte-range it appended
  (`[lastShippedLsn, pg_current_wal_flush_lsn())`) as one immutable object +
  one manifest CAS. Manifest v2 records `walFlushLsn`/segment list; restore
  overlays ranges at LSN-derived offsets (CRC + continuity verified) and lets
  Postgres recovery replay.
- **Snapshots as compaction + rolling backup**: thresholds roll a fresh
  snapshot; the previous one is kept as `manifest.previousSnapshot` (GC
  preserves it) as a corruption fallback.
- **Durability modes**: `strict` | `interval` | `sleep` (serverless-native:
  memory-speed writes, one flush on SIGTERM/idle).
- **Group-commit pacing** from the transport's `CostModel` (GCS caps writes
  per object name at ~1/s — measured 52% 429s beyond it): concurrent writes
  coalesce into one CAS; 429/5xx clean rejections retry with backoff.
- **Streaming snapshot pipeline**: parallel ranged GETs → (gunzip) → untar →
  scratch dir on restore; tar → (gzip) → chunked PUT on commit. O(1) JS heap
  (23MB while restoring a 500MB database). Adaptive codec ships raw tar when
  a sample of the data doesn't compress.
- **Database branching** (`scripts/branch.ts`): server-side copy, 500MB in
  0.34s. **GC** (`scripts/gc.ts`): deletes anything no manifest references.
- Demo service with per-step write timings, durability switches, and fault
  injection; deploy/branch/gc CLI scripts.

### Hardened (each found by a live experiment, each now a regression test)
- WAL GUCs pinned inside snapshots (Postgres ships up to 1GB of recycled WAL
  in a naive datadir tar — a 500MB DB once produced a 969MB snapshot).
- Object keys embed the fencing token (a fenced zombie's in-flight upload
  could overwrite the winner's same-seq object).
- Fence-stamp the manifest on lease takeover (zombie's last-CAS window).
- Boot re-reads the manifest after the lease wait (a predecessor's flush
  during the wait was invisible).
- Idle-flush backstop sized inside the lease TTL (Cloud Run grants ~10s after
  SIGTERM; the successor's fence-stamp races a slow flush).
- **WAL ranges never span writer lives** (Litestream's generation-per-process
  rule): `pg_current_wal_flush_lsn()` at end-of-life overshoots the last
  replayable record by one 24-byte record header, so cross-life resume is
  unsound. First commit per life compacts; continuity guards remain as
  defense in depth.

## v0 (2026-06-11) — whole-snapshot commits

PGlite + GCS conditional-write lease + manifest-swap commits. Full datadir
snapshot per commit. E0–E2b passed (conditional-write correctness, lease/
fencing, byte-identical round-trips, SIGKILL crash matrix).
