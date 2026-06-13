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
