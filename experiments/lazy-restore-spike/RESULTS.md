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

See the "Step 3" section appended below after the POC run.
