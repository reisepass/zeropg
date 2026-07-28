# Lazy page-fault restore from object storage (cold-start handoff)

**The lazy-loading algorithms this worker is testing:** instead of eagerly
downloading the whole snapshot before opening Postgres, boot PGlite on a sparse
datadir and **fault heap/index blocks on demand from the bucket**, via:
(1) a custom PGlite `BaseFilesystem` that intercepts block reads
(`stream_ops.read`); (2) an **Atomics + SharedArrayBuffer sync bridge** so the
synchronous WASM read can block on an async object-store range-GET; (3)
**page-group coalescing** (fault ~1MB aligned groups, not 8KB blocks); and (4)
**query-plan frontrunning / prefetch** (pull the relations+indexes the plan will
touch before executing) plus a learned hot-page set. The thesis: TTFQ is driven
by the first query's working set, not the DB size, so a large DB with a small
hot set cold-starts far faster than eager full restore.

This is a handoff brief for a fresh session **running on the GCP VM**. It states
the mission, the hard rules, where the existing code is, what is already proven
vs only modeled, and the concrete next steps. Read `V2-LAZY-PAGE-RESTORE.md`
(design) and the spike's `RESULTS.md` + `POLICY.md` before starting.

## Mission

1. **Get the 500MB cold start down.** Current eager baseline is ~11.2s p50
   (README), of which ~9.1s is the snapshot restore (bandwidth-bound). Lazy page
   restore should cut time-to-first-useful-query (TTFQ) dramatically when the
   first query's working set is small.
2. **Add a 1GB cold start** (new tier, never measured). RAM is explicitly fine
   (user's call). 1GB datadir on tmpfs + ~1GB RSS ≈ 2-3GB; the VM has 7.8GB.

**The deliverable is a MEASURED table**, not a model: eager full-restore time vs
lazy boot-to-first-query, at 500MB and 1GB, per query shape (point lookup /
indexed range / full scan), with the real per-fault range-GET latency captured.
A "Nx faster" claim with no measured cold start behind it does not count.

## Hard rules (learned the hard way this session)

- **ALL work runs on the VM. NEVER on the laptop.** The previous session's
  subagents ran locally and leaked ~57GB of Postgres datadir copies into macOS
  temp, filling the laptop disk. Do not repeat. SSH in:
  ```
  gcloud compute ssh blob-pglite-dev --project=blob-pglite --zone=europe-west1-b
  ```
- **If the VM runs out of disk, attach another disk** - but prefer **blob
  storage**: snapshots belong in the bucket, not on local disk. The datadir
  should live on **tmpfs** (mirrors serverless), not the boot disk.
- **Disk hygiene is part of the harness, not an afterthought.** The leak came
  from a calibration harness that COPIED the full datadir per trial. The fixed
  pattern (already in `calibrate.mjs`): build ONE datadir per size tier, then
  re-zero relation segments in place per trial. Any temp under a unique dir must
  be cleaned at end of run. Never copy a multi-hundred-MB datadir per iteration.
- **No `git push` from the agent.** The user pushes. (See "code location" - the
  branch is currently laptop-only and must be transferred to the VM.)
- No em dashes, no the word "honest", in any output.

## Environment

- **VM**: `blob-pglite-dev`, project `blob-pglite`, zone `europe-west1-b`,
  europe-west1 (same region as GCS, matters for latency). 2 vCPU, 7.8GB RAM
  (~5.3GB free), 24GB free disk, Node v22.22, npm 10.9.
- **Storage**: an R2 bucket named `zeropg` is verified live (creds in repo
  `.env` as lowercase `r2_s3_access_key_id` / `r2_s3_secret` / `r2_s3_endpoint`
  / `r2_account_id`; note the code in `packages/blobstore/src/r2.ts` reads
  UPPERCASE `R2_*` names, so map them or construct `R2Options` explicitly, and
  set region `auto`). Tigris creds also present (`TIGRIS_STORAGE_*`). `gcloud`
  is authed for GCS. **Pick GCS in europe-west1 for the most representative VM
  cold-start measurement** (same-region, what the README numbers used); R2 is
  the cross-provider check.
- The existing `R2BlobStore` / `GcsBlobStore` (`packages/blobstore/src/`)
  already implement ranged `get(key, {range:{start,end}})`, `put`, streaming
  restore. REUSE these for the fault path - do not hand-roll SigV4.

## Code location (IMPORTANT: branch is laptop-only right now)

All spike work is on branch **`feat/lazy-page-restore`**, which currently exists
**only in a local git worktree on the laptop** (`.claude/worktrees/...`). It was
never pushed. **First step of the handoff: get this branch onto the VM** - either
the user pushes it and the VM fetches, or bundle it (`git bundle create
lazy.bundle main..feat/lazy-page-restore`) and copy via `gcloud compute scp`.
`main` only contains the design doc `V2-LAZY-PAGE-RESTORE.md` and this file.

### What exists on `feat/lazy-page-restore`

- `NOTES-pglite-fs.md` - recon proving pglite block reads are interceptable
  WITHOUT a fork: subclass `BaseFilesystem` (`@electric-sql/pglite/basefs`),
  override `read(fd, buffer, offset, length, position)`. pglite wires
  `stream_ops.read` as a synchronous pass-through to it. Pin pglite 0.5.2 (the
  hook is an undocumented internal contract; re-verify on version bump).
- `experiments/lazy-restore-spike/`:
  - `lazy-fs.mjs` - **`LazyFS`**, the working `BaseFilesystem` subclass. Boots
    real PGlite on a datadir with a zeroed relation; faults missing blocks
    through `read()`. **Currently faults from a LOCAL file via `node:fs`, NOT
    through the bucket or the SAB bridge.** The write/create path is complete
    (mirrors `OpfsAhpFS`: numeric errno via `ERRNO_CODES`, in-memory node tree,
    `INITIAL_MODE.FILE = 32768|0o644`, `DIR = 16384|0o755`).
  - `bridge-worker.mjs` + `bridge-bench.mjs` - the **Atomics + SharedArrayBuffer
    + worker_threads** synchronous-read bridge. Proven byte-correct; mechanism
    overhead ~21us p50 for 8KB (~46k/s); latency passes through faithfully.
    **Standalone only - NOT yet wired into `LazyFS.read`.**
  - `intercept-unit.mjs` - read-contract test. PASSES.
  - `intercept-poc.mjs` - full boot-to-query on a zeroed 50k-row relation.
    PASSES, results byte-identical to full restore; fault counts: point lookup
    faults 1 block of 319, full scan faults all 319.
  - `calibrate.mjs` - builds a multi-relation schema (users/orders/line_items
    with FKs + secondary indexes) and extracts real block-access footprints.
    Has the disk-frugal in-place re-zero fix. **Known bug: hits PGlite
    `XLogBeginInsert was already called` on the very large single INSERT for the
    500MB/1GB tiers - the bulk insert must be BATCHED (chunk the INSERT) before
    those tiers will build.**
  - `store-model.mjs` - MODELED object-store latency/bandwidth/parallelism with
    provider presets. This is the part to REPLACE with real measured latency.
  - `sweep.mjs` - runs eager-vs-lazy TTFQ over footprints x profiles -> JSONL.
  - `analyze.mjs` - emits `POLICY.md` + a `shouldUseLazy(stats)` function.
  - `footprints.jsonl`, `sweep-results.jsonl`, `POLICY.md`, `RESULTS.md`.

## Proven vs modeled (do not conflate - the user called this out)

**Proven (real PGlite):** read interception boot-to-query; correctness;
per-query fault counts; the SAB bridge mechanism in isolation; real working-set
footprints at 10/50/100MB.

**Only modeled (NOT measured):** every cold-start TIME number, including the
"5-6x faster at 500MB". Those are TTFQ from `store-model.mjs` with ESTIMATED
network latency, fed by real footprints. **500MB/1GB footprints were never even
generated** (the 500MB sweep rows used the older single-table footprints). No
end-to-end cold-start wall-clock (container/boot + restore/fault + first query)
was ever measured for lazy at any size. **Closing this is the whole point of
this handoff.**

The modeled crossover (for reference, to be confirmed/replaced by measurement):
lazy wins when DB is large AND first-query working set is small AND not
scan-heavy; modeled crossover ~100MB (s3-standard latency), ~50MB (gcs),
~10MB (s3-express); full-table-scan first queries always favor eager (lazy
faults the same bytes plus per-group RTT). Latency sensitivity is severe:
modeled crossover swings from 10MB at 5ms first-byte to "never" at 120ms - which
is exactly why a REAL latency number is needed.

## What to do (ordered)

0. Get the branch onto the VM (see "code location"). `npm install` (lockfile is
   `package-lock.json` -> npm). Confirm `intercept-unit.mjs` and
   `intercept-poc.mjs` still PASS on the VM (regression check before building on
   top).

1. **Wire the SAB bridge into the real fault path.** Make `LazyFS.read` fault
   from the BUCKET via the `R2BlobStore`/`GcsBlobStore` ranged `get`, going
   through the `bridge-worker` so the synchronous `read` blocks on `Atomics.wait`
   while the worker does the async range-GET. Add **page-group coalescing**
   (fault ~1MB aligned block-groups, not single 8KB blocks) and
   **query-plan frontrunning** (prefetch the relations/indexes the plan will
   touch before executing). This is the first time the bridge runs in anger.

2. **Fix `calibrate.mjs`'s bulk insert** (batch it) so 500MB and 1GB datadirs
   build without the `XLogBeginInsert` error. Build both, snapshot each to the
   bucket (datadir on tmpfs; use the existing snapshot/commit path from
   `packages/objectstore-fs`).

3. **Measure eager baseline on the VM**: full restore from the bucket -> open
   PGlite -> first query. Wall-clock p50/p99 over >=5 runs, at 500MB and 1GB.
   (README has ~11.2s for 500MB eager; reconfirm on this VM, get a fresh 1GB.)

4. **Measure lazy on the VM**: boot on eager-set + sparse -> first query faults
   through the bridge from the bucket. Same runs, at 500MB and 1GB, for point
   lookup / indexed range / full scan. Record TTFQ p50/p99, bytes pulled, fault
   count, AND the real per-fault range-GET latency (cold vs warm connection) -
   this real latency replaces `store-model.mjs`'s estimate.

5. **Emit the measured table** and re-run `analyze.mjs` with the real latency to
   produce a calibrated `POLICY.md` + `shouldUseLazy()`. Update `RESULTS.md`.

6. Re-run the crash matrix (E2b equivalent) against lazy restore before any
   merge: SIGKILL mid-fault, mid-prefetch, stale generation in cache.

## Definition of done

A committed, MEASURED table on the VM:

| size | shape | eager full-restore (p50/p99) | lazy TTFQ (p50/p99) | bytes pulled | faults | real per-fault latency |
|---|---|---|---|---|---|---|
| 500MB | point lookup | ? | ? | ? | ? | ? |
| 500MB | indexed range | ... | | | | |
| 500MB | full scan | ... | | | | |
| 1GB | point lookup | ... | | | | |
| 1GB | indexed range | ... | | | | |
| 1GB | full scan | ... | | | | |

plus a calibrated `POLICY.md` whose latency input is measured, not estimated.

## Open risks

- The SAB bridge needs `SharedArrayBuffer` - free in Node `worker_threads` on
  the VM, so unobstructed here (browser would need COOP/COEP; out of scope).
- Postgres already coalesces sequential reads (~128KB/pread observed), so the
  reactive path is less RTT-bound than a naive 8KB model suggests - good, but
  verify on the real bucket.
- Full-table-scan first queries are expected to lose to eager; the policy should
  detect SeqScan-over-large-relation from the PLAN (not SQL text) and fall back
  to eager/streamed restore.
- pglite version pin: the FS hook is an undocumented internal; pin 0.5.2.
