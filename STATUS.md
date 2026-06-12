# Status: experiment results and next steps

Last updated: 2026-06-12 (overnight session 2). Raw data in `results/*.jsonl`.

## Scoreboard

### Passed

- **E0 - GCS conditional writes**: 100 race rounds x 20-way concurrency, zero double-winners. Conditional PUT p50 ~44ms (1KB) in-region. Strict commit floor ~50-70ms.
- **E1 - lease/fencing**: 100/100 stale renewals rejected, 100/100 stale manifest commits rejected, zero two-holder violations.
- **E2 - round-trip**: byte-identical reopen at 1/10/100MB on the streaming pipeline.
- **E2b - crash safety**: SIGKILL at every commit fault point (before data upload / after data / mid-manifest-CAS) x20 each — every reopen a clean pre- or post-commit state. Re-passed after v1 incremental landed.
- **E2c - incremental WAL shipping**: 60/60 strict commits ship LSN ranges (wall p50 **134ms**, commit work p50 133ms vs 7,800ms v0); byte-identical across reopens; compaction at 16MB rolls a snapshot and keeps the old one as `previousSnapshot` backup; WAL-file-boundary straddling intact; **group commit: 10 concurrent writes → 1 manifest CAS**.
- **E3 - cold start distributions** (20 forced cold starts/size, Cloud Run 1 vCPU + boost): 10MB DB p50 3.8s / p99 4.7s; 50MB 3.5/4.3; 500MB 11.2/12.3. Split: ~2s container start (floor), restore scales with size (1.3s → 9.1s), PGlite open ~0.7s flat.
- **E3b - memory tiers**: 500MB DB cold-starts 5/5 even in **1GiB** (tight: ~535MB tmpfs + ~430MB RSS); 2GiB comfortable; 4GiB identical (restore is bandwidth/CPU-bound, not memory).
- **E4 - lifecycle hazards** (all live on Cloud Run): P1 idle-past-TTL lease self-heal on the request path ✓ (design bet b holds: NO background work needed); P2 sleep-mode pending write survives SIGTERM revision replacement ✓ (after idle-flush fix, below); P2b crash loss bounded to unflushed writes, clean restore ✓; P3 5/5 revision switches with a durable write after each ✓; P4 live zombie vs rival service: zombie rejected 423, rival commits ✓.
- **E5b - GCS manifest CAS rate**: sequential CAS on one object name achieves 2.43/s with **52% of requests 429'd** — the documented ~1/s soft cap is real. Group-commit pacing + driver 429 retry handle it (E2c probe 5).

### Bugs E4/E2c caught (all fixed, all are now regression probes)

1. **969MB snapshot for a 500MB DB**: recycled pg_wal up to `max_wal_size` (1GB default) shipped in the tar. Fixed: WAL GUCs persisted via ALTER SYSTEM inside snapshots + double CHECKPOINT.
2. **OOM restoring large DBs**: old path held ~3 copies in memory. Fixed: streaming restore (parallel ranged GETs → gunzip → untar → tmpfs, 23MB JS heap for 500MB) + streaming commit; adaptive codec ships raw tar when data doesn't compress (serverless vCPU gzips ~12MB/s, NIC 100MB/s+).
3. **Revision-switch boot failure**: new instance got LockedError while old held the lease. Fixed: `acquireTimeoutMs` waits it out.
4. **Zombie's last-CAS window**: takeover didn't touch the manifest, old writer could win one final commit. Fixed: fence-stamp manifest at takeover.
5. **Sleep-mode write lost across revision switch** (E4 P2): successor's fence-stamp landed before old instance's SIGTERM flush. Fixed: idle-flush backstop (25s) < lease TTL (60s).
6. **Crash-looping cold-start probe**: Cloud Run 429s repeated abnormal exits. Probes use clean `/_restart` (exit 0).
7. **WAL capture by file-size diffing is impossible**: Postgres preallocates segments at full 16MB and overwrites. v1 ships LSN ranges (`pg_current_wal_flush_lsn`), the Litestream way.
8. **Same-key data collision under fencing race** (E4 P4 live): zombie's paced upload overwrote the winner's same-seq segment object before its CAS failed → boot failure on CRC/size mismatch. Fixed: object keys embed the fencing token (write-once keys).
9. **Stale manifest adopted across the lease wait**: boot read the manifest, then waited ≤90s for the lease — a predecessor's idle/SIGTERM flush during the wait was invisible, so the successor served (and would overwrite) pre-flush state. Fixed: re-read the manifest AFTER acquiring the lease. Regression: `experiments/e4b-handover.ts` (both handover shapes, local vs real GCS).
10. **Phantom compactions**: a dirty flag with zero WAL growth (idempotent boot DDL) fell through to a FULL snapshot commit — read-mostly instances rewrote the whole manifest as a no-op. Fixed: zero delta clears dirty, commits nothing.
11. **WAL continuity poison — the silent-data-loss one** (E4 runs 4/5, live): the booted cluster's flush LSN sat BEHIND the manifest's resume point (recovery ended short of what the bucket claims was shipped). Every subsequent write computed a negative delta, was swallowed as a no-op, and the server still answered 302 — **acked-durable writes lost**. Fixed: boot + commit detect cluster < resumeLsn, log `zeropg-wal-continuity-violation`, and force a full snapshot of actual recovered state (DESIGN 4.6: continuity doubt → fresh snapshot). Worst case is now one extra compaction, never silent loss.
12. **Root cause of 11, found by repetition** (three violation events, identical signature): `pg_current_wal_flush_lsn()` at a writer's end of life overshoots the last replayable record by exactly 24 bytes (one XLogRecord header). Cross-life LSN chaining is therefore unsound — which is exactly why Litestream rolls a new generation per process restart. Fixed the same way: **WAL ranges never span writer lives**; the first commit of each life compacts (rides the idle flush in sleep mode), `lifeBaseLsn` keeps read-only cold starts at zero uploads, incremental shipping covers the rest of the life. E4 P3's remaining failures were read-routing staleness during the rollout double-instance window (bounded, converges) — the probe now polls to convergence.

### Live demos (scale-to-zero, v1 incremental writes)

- https://zeropg-demo-1mb-71428757273.europe-west1.run.app (10MB)
- https://zeropg-demo-50mb-71428757273.europe-west1.run.app (52MB)
- https://zeropg-demo-500mb-71428757273.europe-west1.run.app (501MB, 2Gi)

Durable strict write on the 50MB demo: ~200ms server-side (scan 1.3ms + segment PUT 79ms + manifest CAS 97ms); sleep-mode write ~150ms. Bucket storage for all three: ~570MB ≈ $0.012/month.

## Next steps, in order

1. **E5 - 72h soak + real billing** (traffic generator exists as a plan in EXPERIMENTS.md; GC tool ready in `scripts/gc.ts`). Validate COST-MODEL.md line-by-line against the bill.
2. **v2 GCS ops** (COST-MODEL.md status section): `compose`-based segment folding (32:1 server-side, zero instance CPU), restore-budget-driven compaction, appendable-objects watch.
3. R2/S3 drivers (the `BlobStore` + `CostModel` interfaces are ready; R2 is the cost-optimal target).
4. Read replicas / CDN hydration story (R2 first — free egress).

## Operational notes

- Git: push to `origin` (github.com/reisepass/zeropg) works via deploy key. Commit and push as you go.
- GCP: project `blob-pglite`, region `europe-west1`, bucket `zeropg-experiments-euw1` (soft delete OFF — verified; keep it off, it would bill 7 days of storage on every GC'd snapshot).
- Deploys: `scripts/deploy.sh <svc> <prefix> <label> [flags]`, `SKIP_BUILD=1` to reuse the image. Demo durability via `DURABILITY=sleep|interval|strict`.
- Branching: `tsx scripts/branch.ts <src> <dest>` (server-side copy; 500MB in 0.34s). GC: `tsx scripts/gc.ts <prefix> [--dry-run]`.
