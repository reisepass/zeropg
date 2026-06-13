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

### Result: the read intercept is PROVEN; full-boot VFS is incomplete

**`intercept-unit.mjs` PASSES** (`node experiments/lazy-restore-spike/intercept-unit.mjs`):

| check | result |
|---|---|
| 64 x 8KB blocks of the intercepted relation match the ORIGINAL bytes | 0 mismatches |
| full-file sha256 via the read path == source hash | match (datadir copy was zeroed) |
| intercepted read count / bytes | 129 reads, ~1.05 MB, all `source: 'remote'` |
| non-intercepted file reads straight from datadir | correct |
| mid-file sub-block read (offset 12345, len 3000) | byte-correct |

Because the datadir copy of the relation was **overwritten with zeros**, the
only way to get correct bytes is the intercept actually firing and supplying
them. It does. This proves the load-bearing claim of Step 3: we own the
synchronous read and can supply byte-identical data from an alternate source,
exactly through the method pglite calls.

**The full end-to-end PGlite boot (`intercept-poc.mjs`) does NOT yet pass.** The
blocker is unrelated to read interception: a from-scratch writable `BaseFilesystem`
must satisfy Postgres's boot/create path, and `LazyFS`'s file-creation path is
incomplete. Concretely, Postgres's create of `postmaster.pid` (and during initdb,
`PG_VERSION`) fails with `Bad file descriptor`. Tracing shows
`BaseFilesystem.writeFile` (the `node_ops.mknod` hook) is **never invoked** for
these new files during boot, so `stream_ops.open` leaves `stream.nfd` undefined
and the subsequent write hits an undefined fd -> EBADF. The conf-file and
PG_VERSION READS during boot DO route correctly through `LazyFS` (observed in the
debug trace), confirming the read hook itself is wired right; the gap is purely
the file-CREATE/mode handling on the write side.

This is an FS-completeness engineering task, **orthogonal to the spike's
kill-criterion** (which is about read interceptability, already proven in Step 1
from source and in `intercept-unit.mjs` at runtime). The fix is to mirror
`OpfsAhpFS`'s node creation precisely (it maintains its own node tree with
explicit `INITIAL_MODE.FILE = 32768` mode bits so `FS.isFile(node.mode)` is true
on a freshly created file) rather than leaning on `node:fs` + `lstat` for newly
mknod'd files. That, or seed the datadir via `loadDataDir` so no files are
created through the custom FS during boot. Either is a follow-up, not a
re-architecture.

### What Step 3 proves vs leaves open

- PROVEN: the intercept fires through pglite's actual read method and returns
  byte-identical data from an alternate store; non-target files are unaffected;
  partial/offset reads are correct. Combined with the Step 1 source proof that
  pglite invokes exactly this method, the read-side cold-start mechanism is
  validated end-to-end at the read layer.
- OPEN: a complete, boot-capable custom VFS (the write/create path). Needed
  before a real PGlite boots on sparse placeholders + intercept. Tractable;
  mirror `OpfsAhpFS`'s node-mode handling or seed via `loadDataDir`.

### Reproduce

```
node experiments/lazy-restore-spike/intercept-unit.mjs   # PASSES - the read-intercept proof
node experiments/lazy-restore-spike/intercept-poc.mjs    # full boot - fails at postmaster.pid create (write-path VFS gap)
```

