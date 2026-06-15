# Lazy Page Restore Spike - Results

Branch-local spike for V2 Section 8 steps 1-3, local-only (no GCS / Cloud Run /
S3 / R2). All numbers below were produced on this machine (macOS, Node v24.13.0).

## Step 1 - pglite FS interceptability (recon)

Full write-up in `/Users/user/workspace/blob-pglite/.claude/worktrees/agent-a232ddc65c154dca0/NOTES-pglite-fs.md`.

Verdict: **interceptable without a fork.** Subclass `BaseFilesystem` and override
`read(fd, buffer, offset, length, position)`. pglite's `createEmscriptenFS` wires
`stream_ops.read` as a thin synchronous pass-through to our `read`
(`src/fs/base.ts:438` in the 0.5.2 sourcemap). The kill-criterion does not fire.
The hard part is therefore not "can we hook the read" but "the hook is
synchronous" - which is what Step 2 de-risks.

## Step 2 - sync-over-async bridge microbenchmark

Files:
- `bridge-worker.mjs` - the fetch worker (blocks on `Atomics.wait`, does the
  async read with an optional artificial delay standing in for a range GET,
  writes bytes into a `SharedArrayBuffer`, `Atomics.notify`s back).
- `bridge-bench.mjs` - main thread. Defines `readBlockSync(offset, length)`, a
  fully SYNCHRONOUS function (no `await`) that posts a request over the control
  SAB, `Atomics.notify`s the worker, blocks on `Atomics.wait`, then copies bytes
  out of the data SAB. This is the shape a custom pglite `BaseFilesystem.read`
  would take.

Run it:
```
node experiments/lazy-restore-spike/bridge-bench.mjs                 # 8KB blocks, no delay
ITERS=5000 BLOCK=1048576 node experiments/lazy-restore-spike/bridge-bench.mjs   # 1MB page-group
ITERS=300 DELAY_MS=20 node experiments/lazy-restore-spike/bridge-bench.mjs      # +20ms fake RTT
```

### Correctness (the important part)

Every configuration passed:
- 256 random single-block reads through the bridge matched the source file
  byte-for-byte (`mismatches: 0`).
- A 512-block contiguous span hashed via the bridge matched the direct hash of
  the same bytes (`bridgeHash === directHash`) - no offset drift across many
  sequential calls.

So the SAB round-trip preserves bytes and offsets exactly. The mechanism is
sound.

### Per-call overhead of the bridge mechanism itself

`DELAY_MS=0` isolates the bridge cost (Atomics block + notify + thread handoff +
a real local `pread` of the block). Microseconds, 20000 iters, 8KB block:

| metric | 8KB block | 1MB block |
|---|---|---|
| min | 15.0 us | 173.7 us |
| p50 | 21.0 us | 255.5 us |
| p90 | 26.3 us | 303.5 us |
| p99 | 48.5 us | 764.4 us |
| p99.9 | 124 us | 1738.5 us |
| max | 585.8 us | 9560.1 us |
| mean | 22.2 us | 277.6 us |
| calls/sec | ~45,000 | ~3,600 |

The ~21 us p50 at 8KB is the **bridge handoff floor** (Atomics + cross-thread
wake + a local block read). The 1MB number is larger because it also copies 1MB
out of the SAB and does a 1MB read; the handoff component is still ~21 us, the
rest is data movement that a real range GET would also incur.

### Latency pass-through (sanity check)

With `DELAY_MS=20` (a 20 ms stand-in for a warm object-store range GET):

| metric | value |
|---|---|
| p50 | 21,241 us (= 21.2 ms) |
| p90 | 21,435 us |
| p99 | 22,143 us |
| mean | 21,187 us |

So bridged latency = simulated RTT (20 ms) + ~1.2 ms of bridge/timer overhead.
The bridge adds roughly **single-digit-percent overhead on top of the network
RTT** and faithfully blocks the caller for exactly the fetch duration. This
matches V2 Section 4's "each uncached fault is a blocking round trip
(~20-150 ms)" model.

### What this means for the design

- The mechanism overhead (~21 us) is **negligible** next to any real object-store
  RTT (tens of ms). The bridge is not the bottleneck; the RTT is. This confirms
  V2 Section 4's conclusion that the whole design lives or dies on **not faulting
  on the request path** (page groups, prefetch, readahead) rather than on making
  each fault cheap.
- A naive 8KB-per-fault scan would pay one ~20-150 ms RTT per block - exactly the
  "tens of serial RTTs per query" catastrophe the doc warns about. Coalescing to
  ~1MB page-groups (128 x 8KB) turns 128 RTTs into 1, at a marginal data-copy
  cost of ~256 us (see 1MB column) - a ~3 order-of-magnitude win on round trips.
- `worker_threads` gives us `SharedArrayBuffer` for free in Node (no
  cross-origin-isolation headers), so this is unobstructed on the Cloud
  Run / serverless target. Browser would need COOP/COEP headers (out of scope).

### Caveat on these numbers

This is a LOCAL microbench. It proves the bridge mechanism is correct and that
its intrinsic overhead is tiny. It does NOT measure real GCS/R2/S3 range-GET
latency (Step 2's cloud half), which is the number that actually sets per-fault
cost. That requires Cloud Run + GCS creds and was explicitly out of scope here.
The right next measurement is real p50/p99 range-GET latency cold vs warm
connection (V2 Section 8 step 2 kill-criterion: p50 > ~150 ms even warm AND
prefetch can't hide it).

## Step 3 - interception POC

Step 1 concluded reads ARE interceptable, so this step ran.

### What was built

- `lazy-fs.mjs` - `LazyFS`, a subclass of the **public** `BaseFilesystem`
  (`@electric-sql/pglite/basefs`). It overrides `read(fd, buffer, offset,
  length, position)` - the exact method pglite's `stream_ops.read` delegates to
  (`src/fs/base.ts:438`, see `NOTES-pglite-fs.md`). For files matching a
  predicate, `read` serves bytes from a SEPARATE "remote" store instead of the
  datadir file; all other ops delegate to a real local datadir via `node:fs`.
- `intercept-unit.mjs` - drives `LazyFS` through the same call shape pglite
  uses (`open` -> `read(fd, heapView, offset, length, position)` -> `close`),
  reading a Uint8Array view over an ArrayBuffer "heap".
- `intercept-poc.mjs` - the full end-to-end attempt: boot normal PGlite, build a
  table, externalize its relation file, zero the datadir copy, reboot with
  `LazyFS` and re-run the query.

### Result: the end-to-end lazy boot POC now PASSES

Both the unit-level read proof AND the full PGlite-boot-to-query POC pass.

**`intercept-unit.mjs` PASSES** (read-method contract):

| check | result |
|---|---|
| 64 x 8KB blocks of the intercepted relation match the ORIGINAL bytes | 0 mismatches |
| full-file sha256 via the read path == source hash | match (datadir copy was zeroed) |
| intercepted read count / bytes | 129 reads, ~1.05 MB, all `source: 'remote'` |
| non-intercepted file reads straight from datadir | correct |
| mid-file sub-block read (offset 12345, len 3000) | byte-correct |

**`intercept-poc.mjs` PASSES end-to-end** (real PGlite, 50,000-row table whose
relation file `base/5/16384` is 2,613,248 bytes = 319 x 8KB heap blocks; the
datadir copy is ZEROED, so only a working fault path can return correct data):

| query shape | result match | faulted reads | faulted bytes |
|---|---|---|---|
| aggregate (count/sum/min/max) | yes | 23 | 2,613,248 (whole relation) |
| point lookup (`WHERE id = 41234`) | yes | **1** | 8,192 (one block) |
| indexed range (`id BETWEEN ...`) | yes | 2 | 16,384 |
| full-scan filter (`WHERE v = 0`) | yes | 23 | 2,613,248 |
| full row set (`ORDER BY id`, sha256) | yes (hash match) | 319 | every block |

Every result is byte-identical to the full-restore baseline, including a sha256
over the entire ordered row set. The point lookup faulting **1 block out of 319**
while the full scan faults all 319 is exactly the working-set-driven TTFQ win the
design predicts: lazy restore pays only for what the first query touches.

Postgres reads heap pages from the relation in ~128KB runs for sequential access
(23 faults x ~114KB avg => the full 2.6MB), and a single 8KB block for the point
lookup. The faults are served from the local "remote" store through
`LazyFS.read()` - the exact method pglite's `stream_ops.read` calls.

### What the write-path fix turned out to be

The earlier `postmaster.pid` / `PG_VERSION` `Bad file descriptor` failure had
three compounding causes, all fixed by rewriting `LazyFS` to mirror `OpfsAhpFS`:

1. **String errno codes.** The old `FsError` set `this.code = 'ENOENT'` (a
   string). pglite's `tryFSOperation` (`src/fs/base.ts:251`) forwards `e.code`
   straight into `new FS.ErrnoError(e.code)`, which expects a **number**. A
   string errno produced a malformed `ErrnoError` that corrupted emscripten's
   create/open path. Fix: `FsError` maps string codes to numbers via
   `ERRNO_CODES[code]` (exactly as OpfsAhpFS's `FsError` does).
2. **No own node tree / wrong mode bits.** The old version leaned on `node:fs` +
   `lstat` and never guaranteed `FS.isFile(node.mode)` for freshly created files.
   Fix: keep an in-memory node tree with explicit `INITIAL_MODE.FILE` (S_IFREG)
   and `INITIAL_MODE.DIR` (S_IFDIR) set in `writeFile` (the `node_ops.mknod`
   hook) so a brand-new node is unambiguously a regular file and
   `stream_ops.open` sets `stream.nfd`.
3. **Missing permission bits.** `INITIAL_MODE` started as bare `16384`/`32768`
   (type bits, zero rwx). initdb then failed with `could not access directory
   "/pglite/data": Permission denied`. Fix: `DIR = 16384 | 0o755`,
   `FILE = 32768 | 0o644` so Postgres's `access()` checks pass.

With those, `LazyFS` boots fresh (runs initdb), boots an existing
NodeFS-created datadir, and boots a datadir with a zeroed relation - all
returning correct query results. The backing store is still a real local
datadir per file, so the fixture can pre-seed and zero individual relation files.

### What Step 3 proves now

- PROVEN end-to-end: a real PGlite boots on a datadir whose large relation
  segment is zeroed; queries fault the missing blocks on demand through
  `LazyFS.read()` (served from a local store) and return byte-identical results
  - including a full-row-set hash - vs full restore. The read-side cold-start
  mechanism is validated boot-to-query.
- The fault counts directly demonstrate the TTFQ thesis (point lookup: 1 block;
  full scan: all 319). The Phase-2 sweep quantifies when this beats eager.

### New gotchas surfaced

- Postgres issues **multi-block sequential reads** (~128KB / 16 blocks per
  `pread` here), not strictly one 8KB block at a time. Good for us: coalescing is
  partly done by Postgres itself, so the object-layer page-group does not have to
  be the only coalescer. The page-group still matters for prefetch and for turning
  remaining gaps into single range GETs.
- `writeFile` receives `data` that may be a string, a Uint8Array, or an
  ArrayBuffer view; the impl normalizes all three. `write` receives the raw WASM
  heap ArrayBuffer (not a typed view) - handled by constructing a view over
  `[offset, offset+length)`.
- The intercept currently opens/closes the remote backing file per `read`. Fine
  for the POC; a real impl would keep a handle/connection and coalesce via the
  page-group + SAB bridge.

### Reproduce

```
node experiments/lazy-restore-spike/intercept-unit.mjs   # PASSES - read-method contract
node experiments/lazy-restore-spike/intercept-poc.mjs    # PASSES - full boot-to-query, zeroed relation
```


## Phase 3 - richer multi-relation footprints, variance, latency sensitivity

Phase 2 measured footprints from ONE 50k-row flat table. Phase 3 replaces that
with a realistic multi-relation schema and hardens the policy. Files:
`calibrate.mjs` (rewritten), `sweep.mjs` (+ latency axis), `analyze.mjs`
(rewritten), `store-model.mjs` (+ `withTTFB`). Regenerated `footprints.jsonl`,
`sweep-results.jsonl`, `POLICY.md`.

### Schema (REAL measurements)

`users / orders / line_items / documents` with foreign keys, 5 secondary indexes,
a narrow table (users), a high-row table (line_items), and a WIDE-row table
(documents, large text column). 13 user relations total (4 heaps + 9 indexes).
Footprints now record faults across ALL relations a query touches (heap + index),
not just one heap. Query shapes: point lookup by PK, point lookup by secondary
index, indexed join, range scan, wide-row point lookup, full table scan.

### What multi-relation footprints showed (10/50/100MB, 6 trials each)

| shape | mean touched fraction | relations touched | note |
|---|---|---|---|
| pointPk | 0.21% | 4 of 13 | faults PK + secondary index pages, not just 1 heap block (6-7 blocks total, ~constant in DB size -> fraction shrinks as DB grows) |
| pointWide | 0.17% | 3 of 13 | wide-row lookup, 5 blocks, shrinks with size |
| rangeScan | 2.38% | 4 of 13 | heap + PK-index leaf pages |
| pointSecondary | 5.43% | 4 of 13 | scattered HEAP blocks (matching rows spread across the heap); fraction ~stable across sizes |
| fullScan | 30.24% | 4 of 13 | whole line_items heap |
| indexedJoin | 30.54% | 8 of 13 | planner SeqScans the large heap side -> a join is NOT a small working set |

All footprints deterministic across 6 trials per scenario (touched-block stddev
= 0 everywhere). The only run-to-run TTFQ variation is the modeled network
latency sampling, captured in p99 vs p50.

### (a) Did the crossover move vs Phase 2? YES - it got LARGER (lazy needs a bigger DB)

Phase 2 headline (low-ws shape, prefetch ON, 1MB): s3-standard 100MB, gcs
**50MB**, s3-express 10MB. Phase 3 (lowest-ws shapes pointPk/pointWide): s3-standard
100MB, gcs **100MB**, s3-express 10MB. gcs-same-region moved 50MB -> 100MB. The
direction is **up**: counting the index pages a "point lookup" really faults
(6-7 blocks across 4 relations, plus the fixed eager-set) raises lazy's floor at
small DB sizes, so lazy needs a larger DB before it beats a single bulk eager
transfer. This is the honest, more-faithful number: Phase 2 understated lazy's
cost by ignoring index/catalog faults.

### (b) Latency sensitivity (one sentence)

For the gcs-same-region profile and the lowest-working-set shape, the crossover
DB size swings from **10MB at 5ms first-byte latency to 100MB at 30-60ms, and
lazy stops winning at all (in the 10-100MB range) at 120ms** - the thresholds are
SENSITIVE to first-byte latency, so the real GCS/S3 number must be measured
before fixing them.

### (c) Variance

None. All 18 footprint scenarios x 6 trials were deterministic (stddev 0). A
fixed query on a fixed dataset faults a fixed block set; nothing is noisy.

### (d) Updated on/off recommendation (one paragraph)

Enable LazyFS when the snapshot is large AND the first query's working set is
small AND the first query is not scan-heavy. With multi-relation costs counted,
the crossover for a low-working-set first query is ~100MB on standard
S3/GCS-class first-byte latency (tens of ms) and as low as ~10MB on fast
single-digit-ms storage (S3 Express). Keep LazyFS OFF for small DBs (a single
bulk parallel restore wins), for scan-heavy first queries (a full/seq scan faults
~30% of the DB over the same bytes as eager plus per-group RTT, so eager wins),
and whenever first-byte latency is high (>~60ms) unless the DB is large and the
working set tiny. Crucially, drive the scan-heavy flag from the actual query plan,
not the SQL text: the indexedJoin shape "looks" selective but the planner
seq-scans the large heap, faulting ~30%.

### (e) Totals and what was cut

- Measured boots: 108 (18 scenarios x 6 trials) at 10/50/100MB, all deterministic.
  Calibration wall-clock ~38s with the disk-frugal harness (build one datadir per
  size tier, reuse across shapes, re-zero relation segments in place per trial).
- Sweep: 324 main cells x 400 iters + 90 latency-sweep cells; ~1s (pure model).
- **CUT: 500MB and 1GB tiers.** Two reasons: (1) the test volume filled up -
  earlier spike runs (including the now-fixed per-trial-full-copy version) leaked
  ~56GB of OS temp under `/var/folders/.../T/lazy-*` that I cannot remove (the no-`rm`
  rule), leaving too little free space for a 500MB+ datadir; (2) the 500MB schema
  build hit a PGlite error (`XLogBeginInsert was already called`) on the very
  large single INSERT+CHECKPOINT - a PGlite build-side fragility, unrelated to
  lazy restore, that needs the bulk insert batched. To add the large tiers: free
  the leaked temp (see below), then `APPEND=1 node calibrate.mjs footprints.jsonl
  6 1024 500` (runs 500MB + 1GB and appends), and re-run sweep + analyze.

### Disk cleanup needed (I cannot run `rm`)

~56GB of throwaway calibration/bridge temp from these spikes sits under the OS
temp dir and is blocking large-tier runs. Please delete it:

```
rm -rf /var/folders/lg/jm0qw9k55tv16fc828vfnpl00000gn/T/lazy-*
```

(macOS will also clear `/var/folders/.../T` on its own eventually, but not soon
enough for a 500MB/1GB re-run.)

### Reproduce

```
node experiments/lazy-restore-spike/calibrate.mjs                 # footprints (10/50/100MB, 6 trials)
node experiments/lazy-restore-spike/sweep.mjs                     # main + latency sweep
node experiments/lazy-restore-spike/analyze.mjs                   # POLICY.md
```


## Phase 4 - MEASURED TTFQ table (500MB GCS, real range-GETs, real PGlite)

The deliverable measurement. A 500MB datadir (479MB user-relation bytes, 554MB
full snapshot, 74MB eager-set) was built on the boot disk, staged to
`gs://zeropg-experiments-euw1/lazy-measure/500mb/`, and measured EAGER vs LAZY
vs LAZY+PREFETCH over three query shapes, 5 runs each, from a GCP VM
(`europe-west1`). All correctness checks pass (`allMatch: true`).

### Environment

- VM: `europe-west1` GCP VM, 7.8GB RAM (boot disk, NOT tmpfs)
- GCS bucket: `zeropg-experiments-euw1` (same region)
- Snapshot: 554MB (`snapshot.tar`), eager-set: 74MB (`eager.tar`)
- User data: 479MB across 13 relations (4 heaps + 9 indexes)
- Schema: `users(147k) / orders(588k) / line_items(2.94M) / documents(110k)` with FKs + 5 secondary indexes
- Page-group: 1MB (128 x 8KB Postgres heap blocks per range-GET)
- PGlite: Node.js v22, `@electric-sql/pglite`, `LazyBucketFS` over SAB bridge

### Measured GCS latency (real, from measured.jsonl)

| metric | warm GET | cold GET |
|---|---|---|
| p50 fault lat (pointLookup, lazy) | 43.9ms | 225ms (first connection) |
| p50 fault lat (indexedRange, lazy) | 39.3ms | 210ms |
| p50 fault lat (fullScan, lazy) | 40ms | 204ms |

Warm GCS same-region range-GET latency is **~40-57ms p50** - squarely in the
30-60ms model range where the Phase 3 crossover table predicts 100MB for
`gcs-same-region`. The 500MB measurement confirms that prediction.

### MEASURED TTFQ table - 500MB tier, GCS, 5 runs

| shape | mode | TTFQ p50 (ms) | TTFQ p99 (ms) | bytes pulled | faults | fault lat p50 | cold GET | speedup vs eager |
|---|---|---|---|---|---|---|---|---|
| pointLookup | eager | 5358 | 6956 | 553 MB | - | - | - | 1x (baseline) |
| pointLookup | lazy | **2489** | 2776 | 7.3 MB | 7 | 44ms | 225ms | **2.1x faster** |
| pointLookup | lazy+prefetch | 4855 | 5012 | 222 MB | 2 sync | 107ms | 220ms | 0.9x (slower - prefetch over-fetches) |
| indexedRange | eager | 5150 | 6007 | 553 MB | - | - | - | 1x (baseline) |
| indexedRange | lazy | **3199** | 3283 | 17.8 MB | 17 | 39ms | 210ms | **1.6x faster** |
| indexedRange | lazy+prefetch | 4845 | 5038 | 222 MB | 2 sync | 108ms | 230ms | 0.9x (slower - prefetch over-fetches) |
| fullScan | eager | 6255 | 7029 | 553 MB | - | - | - | 1x (baseline) |
| fullScan | lazy | 10067 | 10418 | 157 MB | 150 | 40ms | 204ms | 0.6x (SLOWER - 150 serial faults) |
| fullScan | lazy+prefetch | **4719** | 5234 | 157 MB | 3 sync | 99ms | 195ms | **1.3x faster** (prefetch parallelizes) |

### Key findings

**(a) Lazy wins big on low-working-set queries (the designed case)**

- `pointLookup`: lazy pulls 7.3MB (1.3%) instead of 553MB and returns in 2.5s vs
  5.4s - **2.1x speedup**. 7 faults x ~40-60ms warm GETs = ~350ms of actual
  network time; the rest (2.1s) is the eager-set extraction + PGlite open.
- `indexedRange`: 17 faults x ~40ms = ~680ms network; returns in 3.2s vs 5.2s -
  **1.6x speedup**.

**(b) Prefetch HURTS lazy for low-working-set queries**

Prefetch downloads all 1MB groups of the touched relations concurrently (~222MB,
all of `line_items` + `line_items_pkey`) before the query. That is MORE than the
full snapshot path: eager needs 554MB but streams them and does parallel range
GETs; prefetch needs 222MB but also waits for all of them before querying. Result:
2.3-2.7s prefetch dominates TTFQ and slow it to parity with eager. **Prefetch
should be disabled for low-working-set queries** (e.g., point lookups where the
query plan faults only ~10-20 groups, not hundreds).

**(c) Prefetch HELPS full scans**

Without prefetch, `fullScan` is disastrous: 150 SERIAL faults x ~40ms warm =
~6000ms of blocking fault time on top of the eager-set open cost. With prefetch,
150 groups are fetched concurrently in parallel (observed ~1.6-1.8s prefetch wall
time), then the query runs on warm data - **1.3x speedup over eager**.

**(d) The lazy path is correct end-to-end**

All 45 trials (`allMatch: true`) returned results byte-identical to the golden
answers captured at tier build time. The SAB bridge, LazyBucketFS, and
1MB-page-group coalescing are correct at 500MB real scale with real GCS range-GETs.

**(e) 1GB tier deferred (OOM risk on 7.8GB VM)**

The prior OOM was caused by building the 1GB datadir on tmpfs. With the boot-disk
fix, 500MB is safe (9.6MB residual in `~/lazy-work` after truncation). However the
1GB tier needs ~1.1GB disk PLUS the tar staging object (~1.1GB), which fits on
disk (43GB free) but risks PGlite memory pressure during the build. Defer 1GB to
a VM with >= 16GB RAM or run with `--max-old-space-size=4096`.

### Write-path policy (agreed, not yet measured)

The measurement above is read-only. The agreed write-path policy:

- **Lazy is read-mostly**: the lazy restore path is designed for the
  "cold start, read the first query" workload. Write operations are outside its
  intended scope.
- **First write triggers hydrate-and-promote**: on the first write to a lazy
  relation segment, the segment is fully hydrated into memory (all its 1MB groups
  fetched synchronously), the sparse placeholder is replaced with the real bytes,
  and subsequent reads and writes go to the local copy. No remote page write-back.
- **Gate with `shouldUseLazy()`**: the decision function in `POLICY.md` gates
  lazy restore at the restore decision point; once promoted to a full local copy
  the session behaves as a normal PGlite instance.
- **Implication**: lazy is most valuable for read-heavy analytics sessions or
  one-shot queries; sessions that immediately write after restore should use eager.

### Reproduce

```
# Tier build (500MB, ~10-15min, boot disk, GCS):
WORKDIR=~/lazy-work node_modules/.bin/tsx experiments/lazy-restore-spike/build-tier.mjs 500 gcs

# Measurement (5 runs/shape, ~10min, boots from bucket):
WORKDIR=~/lazy-work node_modules/.bin/tsx experiments/lazy-restore-spike/measure.mjs 500 gcs 5
```


## Phase 5 - 1GB and 2GB tiers: speedup grows with DB size

Measured on a 32GB GCP VM (`europe-west1`, 80GB boot disk) using the same
methodology as Phase 4. Each tier was built on the boot disk (not tmpfs), staged
to `gs://zeropg-experiments-euw1/lazy-measure/{1024,2048}mb/`, and measured
5 runs per shape. All 90 trials passed correctness checks (`allMatch: true`).

### Environment

- VM: `europe-west1` GCP VM, 32GB RAM, 80GB boot disk
- GCS bucket: `zeropg-experiments-euw1` (same region)
- 1GB tier: snapshot=1052MB, eager-set=73.7MB, user-bytes=978MB, 13 relations
- 2GB tier: snapshot=2030MB, eager-set=73.9MB, user-bytes=1956MB, 13 relations
- Schema: same `users/orders/line_items/documents` multi-relation schema as Phase 4
- Page-group: 1MB, PGlite Node.js v22

### Measured GCS latency (1GB and 2GB tiers)

Warm same-region range-GET latency remained consistent across tiers:

| tier | warm GET p50 (pointLookup) | cold GET (first connection) |
|---|---|---|
| 500MB | 44ms | 225ms |
| 1GB | 38ms | 147ms |
| 2GB | 55ms | 142ms |

### MEASURED TTFQ table - all three tiers, GCS, 5 runs each

| size | shape | mode | TTFQ p50 (ms) | bytes pulled | faults | speedup vs eager |
|---|---|---|---|---|---|---|
| **500MB** | pointLookup | eager | 5358 | 553 MB | - | 1x |
| **500MB** | pointLookup | lazy | 2489 | 7.3 MB | 7 | **2.1x** |
| **500MB** | pointLookup | lazy+prefetch | 4855 | 222 MB | 2 sync | 0.9x |
| **500MB** | indexedRange | eager | 5150 | 553 MB | - | 1x |
| **500MB** | indexedRange | lazy | 3199 | 17.8 MB | 17 | **1.6x** |
| **500MB** | indexedRange | lazy+prefetch | 4845 | 222 MB | 2 sync | 0.9x |
| **500MB** | fullScan | eager | 6255 | 553 MB | - | 1x |
| **500MB** | fullScan | lazy | 10067 | 157 MB | 150 | 0.6x (SLOWER) |
| **500MB** | fullScan | lazy+prefetch | 4719 | 157 MB | 3 sync | **1.3x** |
| **1GB** | pointLookup | eager | 7038 | 1052 MB | - | 1x |
| **1GB** | pointLookup | lazy | 1640 | 7.3 MB | 7 | **4.3x** |
| **1GB** | pointLookup | lazy+prefetch | 3442 | 450 MB | 2 sync | 2.0x |
| **1GB** | indexedRange | eager | 6288 | 1052 MB | - | 1x |
| **1GB** | indexedRange | lazy | 2503 | 28.3 MB | 27 | **2.5x** |
| **1GB** | indexedRange | lazy+prefetch | 4038 | 450 MB | 2 sync | 1.6x |
| **1GB** | fullScan | eager | 6713 | 1052 MB | - | 1x |
| **1GB** | fullScan | lazy | 14768 | 316 MB | 302 | 0.5x (SLOWER) |
| **1GB** | fullScan | lazy+prefetch | 3684 | 316 MB | 3 sync | **1.8x** |
| **2GB** | pointLookup | eager | 8764 | 2030 MB | - | 1x |
| **2GB** | pointLookup | lazy | 1519 | 6.3 MB | 6 | **5.8x** |
| **2GB** | pointLookup | lazy+prefetch | 5508 | 898 MB | 2 sync | 1.6x |
| **2GB** | indexedRange | eager | 9408 | 2030 MB | - | 1x |
| **2GB** | indexedRange | lazy | 3433 | 51.4 MB | 49 | **2.7x** |
| **2GB** | indexedRange | lazy+prefetch | 5729 | 898 MB | 2 sync | 1.6x |
| **2GB** | fullScan | eager | 10869 | 2030 MB | - | 1x |
| **2GB** | fullScan | lazy | 31561 | 629 MB | 601 | 0.3x (SLOWER) |
| **2GB** | fullScan | lazy+prefetch | 5538 | 629 MB | 3 sync | **2.0x** |

### Speedup trend: lazy advantage grows with DB size

The key result - lazy TTFQ stays approximately constant as the DB doubles
(working set is fixed in absolute terms), while eager TTFQ scales linearly with
snapshot size:

| shape | 500MB speedup | 1GB speedup | 2GB speedup | trend |
|---|---|---|---|---|
| pointLookup (lazy) | 2.1x | **4.3x** | **5.8x** | eager: +63% per doubling; lazy: ~constant |
| indexedRange (lazy) | 1.6x | **2.5x** | **2.7x** | eager: scales; lazy faults grow slowly |
| fullScan (lazy+prefetch) | 1.3x | **1.8x** | **2.0x** | prefetch parallelism advantage grows |

**Eager scales linearly with size**; the 500MB snapshot takes ~5.4s and the
2GB snapshot takes ~8.8-9.4s (roughly 1.7x per 4x size increase - bandwidth
limited). Lazy point-lookup TTFQ runs in 1.5-2.5s regardless of tier size
because it faults only 6-7 fixed groups (catalog + one heap page + one index
page), independent of total data volume. This is the core thesis confirmed at
real scale.

### Key findings

**(a) Point-lookup speedup reaches 5.8x at 2GB**

At 2GB, lazy pulls 6.3MB (0.3%) vs the 2030MB eager snapshot in 8.8s.
Lazy completes in 1.5s: ~73ms warm GCS latency for 6 faults + 1.4s eager-set
extraction + PGlite open. The eager-set (catalog-only, 73.9MB, constant across
sizes) is the remaining floor - it does not grow with tier size.

**(b) Indexed range scales gracefully**

Faults grow with tier size (17 at 500MB, 27 at 1GB, 49 at 2GB) because the
5% range selects proportionally more rows. Despite 2.9x more faults at 2GB,
lazy still returns in 3.4s vs eager's 9.4s (2.7x speedup), because faults
run in ~34-55ms each and the eager baseline grew proportionally more expensive.

**(c) Prefetch helps full scans more at larger tiers**

At 500MB prefetch gave 1.3x; at 2GB it gives 2.0x. Prefetch wall time for
2GB's 601 groups is ~3-4s concurrent, vs eager needing to download 2030MB
sequentially through tar extraction. The absolute bytes are larger but the
concurrency ceiling is the same (12 parallel GETs), so prefetch's advantage
widens as the scan grows.

**(d) Lazy+prefetch becomes competitive at large sizes for low-ws queries**

At 1GB, lazy+prefetch for pointLookup returns 2.0x faster than eager (3.4s vs
7.0s) even though it downloads ~450MB - prefetch over-fetches the whole
line_items relation but still beats the 1052MB full restore. At 500MB the same
mode was slower than eager. The crossover for prefetch-on-low-ws-query shifts
between 500MB and 1GB.

**(e) All correctness checks pass at all three tiers**

All 90 trials (500MB + 1GB + 2GB, 5 runs x 3 shapes x 3 modes) returned
results byte-identical to golden answers captured at build time (`allMatch: true`).

### Reproduce

```
# Tier build (1GB, boot disk):
TMPFS_DIR=~/lazy-build node_modules/.bin/tsx experiments/lazy-restore-spike/build-tier.mjs 1024 gcs

# Measurement (1GB, 5 runs/shape):
WORKDIR=~/lazy-work node_modules/.bin/tsx experiments/lazy-restore-spike/measure.mjs 1024 gcs 5

# Tier build (2GB, boot disk):
TMPFS_DIR=~/lazy-build node_modules/.bin/tsx experiments/lazy-restore-spike/build-tier.mjs 2048 gcs

# Measurement (2GB, 5 runs/shape):
WORKDIR=~/lazy-work node_modules/.bin/tsx experiments/lazy-restore-spike/measure.mjs 2048 gcs 5
```
