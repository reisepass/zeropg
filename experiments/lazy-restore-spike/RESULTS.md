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

