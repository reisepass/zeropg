# v1: incremental WAL shipping - implementation plan

Status: **BUILT** (2026-06-12), with one major correction to the capture design (below). Writes are O(transaction size): strict-commit wall p50 measured at **139ms** vs 7,800ms for v0 full snapshots on the same 50MB-class database (E2c). Manifest v2, compaction-as-backup, group-commit pacing and GCS 429 retry all landed with it.

## Capture design: LSN ranges, NOT file-size diffing (plan corrected)

The original plan here ("any pg_wal file larger than its high-water mark has new bytes") was **wrong**, twice over, and failed immediately when built:

1. Postgres preallocates every WAL segment file at its full `wal_segment_size` (16MB) the moment it is created — with `wal_init_zero=on` by zero-filling, with it off by writing the final byte. Either way `stat.size` is 16MB from birth and records fill the file by OVERWRITE. File size never moves; size-diffing sees nothing.
2. Even if sizes moved, the end-of-recovery checkpoint record each boot writes would leave holes between shipped ranges.

The correct capture, as actually implemented (and what Litestream does for SQLite):

- Track `lastShippedLsn`. At commit, ask Postgres `pg_current_wal_flush_lsn()` (record-aligned for commit flushes, `synchronous_commit=on` enforced) and ship the byte range `[lastShippedLsn, flushLsn)` as ONE immutable object, reading it out of the segment files via LSN→(file, offset) arithmetic (`XLogFileName` math, validated against `pg_walfile_name()` at boot).
- The manifest records `walFlushLsn` at snapshot time — where the snapshot's own pg_wal content ends and shipping resumes. Restore overlays each range at its LSN-derived offsets and lets Postgres recovery replay; LSN continuity (each range starts where the previous ended, the first at `walFlushLsn`) is verified before boot.
- Stale bytes past the last shipped range are rejected by Postgres's own page-address validation, exactly as with recycled segments. Advancing `lastShippedLsn` only after the manifest CAS makes fenced commits leave only orphaned garbage.

No Emscripten hooks, no shadow WAL — one SQL function call per commit.

## Restored WAL files must be full segment size (third correction)

Postgres reads WAL in full 8KB pages and treats a short read at EOF as end of
WAL. Overlay-created segment files that end at the last shipped byte
therefore silently truncate replay at the previous page boundary — measured:
a restore dropped the final 5KB of a 5MB commit (its commit record included),
while the writer's own preallocated 16MB files masked the bug on the writer
side. Restore now extends every touched WAL file (sparse) to the full
segment size, exactly the invariant Postgres maintains for itself. The zero
tail reads as an invalid record, ending replay at precisely the last shipped
byte. This was also the mechanism behind the production continuity
violations (recovery-stop at a page boundary + ~192-byte end-of-recovery
checkpoint = the recurring `...0C0` flush LSNs). With this fix, cross-life
chaining may be sound again — re-promoting it over the per-life rule is a v2
change gated on E4-grade lifecycle testing.

## Generation per writer life (second correction, from E4)

WAL ranges must NEVER span writer lives. Live lifecycle testing (E4 P3, 5x
revision switches) lost an acked durable write and the forensics were
unambiguous: across every `zeropg-wal-continuity-violation` event, the
restored cluster recovers to an LSN exactly **24 bytes — one XLogRecord
header — short of the dead writer's final flush LSN**. `pg_current_wal_flush_lsn()`
at end of life overshoots the last replayable record by a header-sized tail;
a successor that resumes shipping from the dead writer's number emits ranges
from a misaligned stream, and the next restorer silently drops the tail.

This is precisely why Litestream begins a new generation on every process
restart. zeropg now does the equivalent: the FIRST commit of each writer
life is a compaction (one snapshot — in sleep mode it rides the idle flush,
invisible to requests), and every incremental range thereafter starts from
an LSN the same process measured itself. `lifeBaseLsn` keeps idempotent boot
DDL from uploading anything, so a cold start that only serves reads still
does zero writes. The boot/commit continuity guards stay as defense in depth.
Cross-life chaining (record-boundary parsing of the WAL tail) is a v2
investigation, not a v1 need.

## Constraint: `wal_level` MUST stay `replica` (never `minimal`)

This is a named, non-negotiable invariant of the WAL-shipping design, enforced
by a guardrail comment at the `WAL_GUCS` list in `zeropg.ts` (TODO A1.2).

We ship WAL. Our restore path reconstructs state by replaying the shipped LSN
ranges over a base snapshot — so **anything Postgres does not route through the
WAL is invisible to a restore until the next full snapshot.** Under the default
`wal_level=replica`, every data change is WAL-logged, so every change is in some
shipped segment. Under `wal_level=minimal`, Postgres applies an optimization
that is normally harmless but is a silent-data-loss landmine for us: bulk
operations against a relation created or truncated *in the same transaction* —
`COPY` into a freshly-created table, `CREATE TABLE AS`, `CREATE INDEX`,
`CLUSTER`, table-rewriting `ALTER TABLE` — **skip the WAL entirely** and only
`fsync()` the underlying heap/index files at commit (the engine can do this
safely on a single node because, if it crashes, the whole transaction is rolled
back and the files are discarded). For zeropg this means the incremental commit
after such an operation ships an LSN range that *does not contain the bulk
load*; a successor that restores the snapshot and replays our segments recovers
a database missing that table's contents, with no error — exactly the class of
acked-then-vanished write the crash matrix exists to forbid. The loss heals
only when a later compaction happens to tar up the heap files.

We therefore keep `wal_level` at the engine default (`replica`) and deliberately
do **not** list it in `WAL_GUCS`: a future change to it must be a conscious edit
at the guardrail comment, where this reasoning is restated. (`minimal` would
also break read replicas and disable point-in-time/standby use — but the
data-loss path above is the reason it is forbidden *here*.)

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

## A1: full_page_writes=off — findings (measured)

`full_page_writes` (FPW) is now a configurable per-instance GUC (`ZeroPGOptions.fullPageWrites`, default **on**; env `ZEROPG_FULL_PAGE_WRITES=off` for the harnesses). It is reconciled live in `ensureWalConfig`: PGlite applies SIGHUP-context GUCs only at process start (`pg_reload_conf()` is a no-op in-process — verified), so when the running value differs from what we want we ALTER SYSTEM it (writing `postgresql.auto.conf`) and reopen the datadir once. This self-heals: once a life's snapshot bakes the value into auto.conf, every later restore starts with it already live and skips the reopen, so steady state pays zero extra boot cost.

**Why FPW is plausibly redundant here.** Postgres writes a full 8KB page image (FPI) into WAL on the first modification of each page after a checkpoint, solely to repair *torn pages* during LOCAL crash recovery. zeropg never recovers from a torn local datadir: the datadir lives on tmpfs (it vanishes with the instance, it is never fsck'd back to life), and recovery is always "restore the consistent post-CHECKPOINT snapshot, overlay complete CRC- and page-address-verified WAL, let Postgres replay." The base pages a restore replays over come from a clean snapshot, not from a possibly-torn local disk, so the FPIs repair a failure mode the architecture cannot enter.

**Measured win (`experiments/efpw.ts`, results/fpw.jsonl).** Workload: 200 strict update-commits, each touching 250 random rows of a work table, after a clean compaction, at three DB sizes. FPW off vs on:

| DB size | WAL/commit on | WAL/commit off | total WAL on→off | compactions on→off | snapshot/compaction |
|---|---|---|---|---|---|
| ~1 MB | ~1058 KB | ~46 KB | 200 → 9.1 MB | 11 → 3 | 4.6 MB |
| ~50 MB | ~1066 KB | ~46 KB | 201 → 9.1 MB | 11 → 3 | 102 MB |
| ~500 MB | ~1052 KB | ~46 KB | 199 → 9.1 MB | 11 → 3 | 555 MB |

FPW off ships **~22x less WAL (~95% smaller)** per commit, and the per-commit WAL becomes flat and tiny (~46 KB) — it is pure row delta, no page images. Because the 16 MB compaction threshold is then reached ~3.7x slower, compactions drop 11→3 over the same workload; at 500 MB each *avoided* compaction saves a **555 MB snapshot upload**, so the second-order win (compaction-interval stretch) dwarfs the per-commit win at scale. The per-commit FPI cost is independent of DB size (it tracks pages touched, not bytes stored), which is why WAL/commit is identical across the three sizes.

**A1.3 — wal_compression.** Only `pglz` is compiled into the PGlite WASM build (`lz4`/`zstd` are rejected; the option ignores unsupported codecs non-fatally). With FPW **on**, `wal_compression=pglz` shrinks WAL ~91% (201 MB → 17 MB at 50 MB DB) by compressing the FPIs in-WAL — nearly matching FPW-off. But FPW-off (9 MB) still beats pglz-on (17 MB), and once FPW is off there are essentially no FPIs left to compress, so pglz adds little on top of FPW-off. Recommendation: prefer FPW-off; `wal_compression=pglz` is a useful fallback for workloads that must keep FPW on (e.g. a future non-tmpfs deployment).

**Crash gate (the decision gate, NOT a free win).** FPW-off only changes the bytes Postgres *writes*; it cannot affect replay of WAL already shipped. The risk it removes is local torn-page repair, which the model says it never needs — the E2b crash matrix and e4b handover races are exactly what would expose a base page that FPW would have repaired (kill mid-commit → reopen from snapshot+WAL → byte-identical verify). Run with FPW off:

- **E2b crash matrix, `ZEROPG_FULL_PAGE_WRITES=off`, 20×3 = 60 SIGKILL rounds (2026-06-13):** ✅ PASSED — kill-before-snapshot 20/20, kill-after-snapshot 20/20, kill-during-manifest 20/20; every reopen a clean pre- or post-commit state, zero torn states. (The default-FPW=on matrix re-passed identically, 60/60.)
- **e4b handover races, FPW off (2026-06-13):** ✅ PASSED — clean-release handover (B sees 3/3 notes), takeover handover (2/2), zombie fenced.

**Decision: default stays `on`; FPW-off is a validated opt-in.** Per the project rule ("when unsure, keep the safe behavior and make FPW-off opt-in"), and because this touches the most dangerous code in the repo on a single session, the conservative default is FPW on. The evidence above shows FPW-off is *safe to enable* and worth a large amount (22x WAL, 3.7x fewer compactions, 555 MB snapshots avoided at scale) for any deployment that holds the tmpfs/restore-from-bucket invariant. Recommend promoting it to the default after it rides the 72h E5 soak with the crash matrix periodically re-run.
