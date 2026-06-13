# V2: Lazy Page Restore (cold-start, read side)

Status: **design / pre-spike.** No code on `main`. Implementation happens on an
isolated branch (`feat/lazy-page-restore`) so it cannot touch the working v0/v1
commit path. This doc is the brief for that work.

## 0. One-line thesis

Keep the v1 **incremental-WAL commit path exactly as-is** (it is already write-
optimized), and add a **read-side** lazy page-fault restore so an instance can
answer its first useful query before the whole datadir is local. The metric we
optimize is **time-to-first-useful-query (TTFQ)**, not time-to-full-restore.

This is turbolite's read path, ported to Postgres-in-WASM, fused onto zeropg's
write path. We take turbolite's lazy fetch + B-tree-aware grouping + prefetch.
We explicitly **reject** turbolite's page-group *commit* model (see §2).

## 1. Two cold-start regimes (why one technique is not enough)

Measured today (Cloud Run, same-region GCS, end-to-end from client):

| DB size | cold p50 | container floor | restore | pglite open |
|---|---|---|---|---|
| 10 MB | 3.8s | ~2.0s | ~1.3s | ~0.7s |
| 50 MB | 3.5s | ~2.0s | ~1.3s | ~0.7s |
| 500 MB | 11.2s | ~2.0s | ~9.1s | ~0.7s |

Two different bottlenecks hide in one table:

- **Large DB (500MB+): transfer-bound.** Restore dominates (9.1s). This is what
  lazy fetch is *for*: boot on catalogs + a small working set, fault the rest.
- **Small DB (≤50MB): open-bound.** Restore is already ~1.3s; the floor is
  container start (~2s, platform) + WASM instantiate + Postgres boot/recovery
  (~0.7s). **Lazy fetch barely helps here and can hurt** - for a 10MB DB you
  will fault most of it anyway, and N round trips lose to one bulk parallel
  transfer below some crossover size.

### The reframe that serves both goals

The right metric is **TTFQ = time until the first user-facing query returns**,
not time until the datadir is fully local. Lazy fetch minimizes TTFQ at *any*
size, because TTFQ depends on the *working set of the first query*, not the DB
size. A 500MB DB whose landing page touches 2MB reaches interactive in
catalog + 2MB time.

So the two goals split into two workstreams:

- **WS-A (big DB, transfer-bound):** lazy page fault + prefetch. The bulk of
  this doc.
- **WS-B (small DB, open-bound):** attack the floor lazy fetch can't:
  - cache the compiled WASM module across cold starts (instantiate from a
    cached `WebAssembly.Module`, skip recompile);
  - snapshot at a clean checkpoint so boot has ~zero WAL to replay (v1 already
    double-CHECKPOINTs before snapshot - verify recovery touches nothing);
  - measure Postgres boot itself (initdb-free seed already done; what's left in
    the 0.7s?);
  - keep `min-instances` math and image size out of scope here (platform).
  - WS-B does **not** need the VFS surgery. It can ship independently and
    sooner.

**Crossover size is an empirical question the spike must answer:** below size
`X`, eager full restore wins on TTFQ; above `X`, lazy wins. Find `X` per
provider (GCS / R2 / S3 / S3-Express) and make eager-vs-lazy an automatic
policy keyed on snapshot size, not a user flag.

## 2. What we take from turbolite, and what we reject

Source: russellromney/turbolite (Rust SQLite VFS, "sub-100ms cold JOIN from
S3"). Re-read before building. Key facts pulled from its README/ROADMAP/HN:

**Take (read side):**
- **Page groups, not pages.** 256 pages/group, ~16MB at 64KB pages. Amortize
  the S3 round trip; never one-object-per-page (the sqlite-s3vfs anti-pattern).
- **B-tree-aware grouping beats proximity.** "Page numbers are not laid out the
  way you want to fetch remotely." Segregate interior / index-leaf / data-leaf;
  load interior (routing) pages eagerly, lazy-load the rest. Postgres mapping in
  §3.
- **Two prefetch strategies:**
  - *Query-plan frontrunning*: intercept the plan, prefetch the exact
    tables/indexes before execution. Measured **4.4x faster cold joins** vs
    reactive on certain joins.
  - *Reactive*: on cache miss, inline range GET for the needed sub-chunk +
    background prefetch of sibling groups on a schedule (`search [0.3,0.3,0.4]`,
    `lookup [0.0,0.0,0.0]` - free misses before committing to prefetch).
- **Seekable multi-frame zstd** (~4 pages / ~256KB per frame), manifest stores
  per-frame byte offsets → range GET fetches only the needed sub-chunk.
- **Layered cache:** in-mem (zero-lock reads) → local disk → object store.
  Budget ~64MB. We map this onto a `/tmp` sparse-file cache + JS-side hot cache.

**Reject (write side):**
- **Page-group commit.** Turbolite re-uploads a whole 16MB group when one page
  dirties. The author confirmed on HN this "steers opposite to the temporal
  locality LTX/Litestream use" and favors cold-read-heavy over write/warm-read.
  **zeropg already has the better write path: incremental WAL shipping**
  (hundreds of bytes per commit). We do not touch it. Lazy restore is a
  read-only concern layered under the existing manifest.
- **Their single-writer caveat** ("two writers corrupt the manifest"). We
  already solved this with the lease + fencing tokens. Unchanged.

**Honest caveat turbolite's author conceded:** scans still bite. "Remote object
storage most clearly reminds you it is not a local SSD" on scans. Sequential
readahead within a relation (§4) is our main mitigation; a full table scan of a
cold large relation will still pay bandwidth. That's acceptable - the target is
interactive first paint, not OLAP scans (that's the separate DuckDB-sidecar
track).

## 3. Postgres mapping (this is not SQLite)

Differences that matter:

- **Page size is fixed at compile time** (`BLCKSZ`, 8KB in the pglite build).
  We cannot adopt turbolite's 64KB pages. Our "group" is a coalesced range of
  contiguous 8KB blocks chosen at the *object* layer (e.g. 1-2MB groups =
  128-256 blocks), independent of `BLCKSZ`.
- **Relation files are predictable.** Postgres stores each relation as
  `base/<dboid>/<relfilenode>[.segN]`, 1GB segments, heap blocks sequential by
  block number. This is *more* prefetch-friendly than SQLite - sequential
  readahead within a relfilenode is a clean win for scans.
- **Page classes for eager-vs-lazy:**
  - **Eager (always local, tiny):** `pg_control`, `global/`, `pg_xact`,
    config, and the entire `pg_catalog` set (system tables + their indexes).
    This is the "all tables render immediately" property - schema introspection
    works at t=0.
  - **Eager (small, routing):** internal/interior pages of user-table btree
    indexes (turbolite's "interior" class). Identifying these without reading
    them is the hard part - may require a one-time index walk at snapshot time
    to record internal-page block numbers into the manifest.
  - **Lazy (the bulk):** heap blocks of large user relations, index leaf pages.
- **Classification rule for v1 of this feature (simpler):** eager = every file
  below a size threshold (catalogs, small relations, all the plumbing); lazy =
  large relation segment files only. Refine to page-class granularity later if
  measurements justify it. Start coarse.

## 4. The sync-over-async wall (the load-bearing problem)

Confirmed from primary sources: **PGlite is a fully synchronous WASM build of
Postgres and cannot call async APIs while handling a query.** Postgres issues
blocking `pread()` on relation segment files via its storage manager; in the
Emscripten FS those become synchronous `stream_ops.read(stream, buf, offset,
length)` calls. We must satisfy a read that requires a network fetch *without*
returning control to the JS event loop.

Three ways across, and why we pick the third:

1. **Synchronous XHR** - dead. Not available in workers; deprecated on main
   thread; no auth/streaming story for object storage.
2. **Asyncify** - build pglite with stack-unwinding so the read can await.
   Primary sources confirm it "adds significant overhead in both file size and
   performance" - and it taxes *every* call into WASM, not just faulting reads.
   We will not pay a global hot-path tax to enable a cold-path feature.
3. **Atomics + SharedArrayBuffer + fetch worker (CHOSEN).** Keep `stream_ops.
   read` synchronous; inside it, post a request to a fetch worker over a SAB and
   block on `Atomics.wait`. The worker does the async range GET + decompress +
   decrypt, writes bytes into the SAB, and `Atomics.notify`s. No WASM rebuild,
   no Asyncify tax. Cost: needs SharedArrayBuffer (cross-origin isolation
   headers in browser; free in Node `worker_threads`), and **each uncached
   fault is a blocking round trip (~20-150ms).**

Note the OPFS-AHP trick **does not transfer.** AHP avoids Asyncify by using OPFS
*synchronous access handles* - there is no synchronous-access-handle equivalent
for S3/R2/GCS. (Also: AHP hits a Safari 252-handle limit vs Postgres's 300+
files - another reason it's browser-fragile and irrelevant to our serverless
target.)

**Because each fault is a blocking RTT, the whole design lives or dies on not
faulting on the request path:** page groups (amortize), query-plan frontrunning
(prefetch before execution), sequential readahead (scans), and the learned
hot-set (§6). A naive 8KB-per-fault implementation would be catastrophic - tens
of serial RTTs per query.

## 5. Where it plugs into pglite (no engine fork)

The interception point is the **Emscripten filesystem backend** - the same layer
as `NODEFS` / `IDBFS` / `opfs-ahp.ts`, registered from JS. `Filesystem.init(pg,
emscriptenOptions)` hands us the Emscripten `Module`; from there we register a
custom FS and wire our own `stream_ops.read`. This is a **sibling to
`opfs-ahp.ts`**, living in our package. No Postgres/pglite source fork.

> The pglite public docs do *not* document the custom-FS surface ("consult the
> source"). The agent must read, in `node_modules/@electric-sql/pglite/`:
> `dist/fs/base.*`, `dist/fs/nodefs.*`, `dist/fs/opfs-ahp.*` (and the
> Emscripten module glue) to find exactly how `stream_ops`/`node_ops` are
> registered and how `init` exposes `FS`. Confirm whether `read` is reachable
> per-stream or whether we must shim at `FS.createNode`/`mount`. This is the
> first spike deliverable.

zeropg's current `ObjectStoreFS` only implements the *high-level* interface
(`initialSyncFs`/`syncToFs`/`dumpTar`) and restores the whole datadir up front.
Lazy fetch lives one layer lower (`stream_ops.read`) and is **additive**: it
changes `initialSyncFs` from "download everything" to "download eager set +
lay down sparse placeholders for lazy files + register the faulting read op."

## 6. Restore / read path (the actual algorithm)

1. GET `manifest.json` (unchanged commit point). It now *also* carries a
   `pageGroups` map: `(relfilenode, blockRange) → { object, frameOffsets }`,
   and an `eagerSet` list, and a pointer to the optional `prefetch.json`.
2. Download the **eager set** (catalogs, control, small files, index-internal
   pages) into `/tmp` - a few MB regardless of DB size.
3. Lay down **sparse placeholder files** for lazy relation segments (correct
   size, no bytes) and a per-file presence bitmap of which block-groups are
   local.
4. Kick off the **prefetch worker** against `prefetch.json` (learned hot-set,
   §below) in the background.
5. Open pglite. Postgres boot/recovery runs; because v1 snapshots at a clean
   checkpoint there should be ~no WAL to replay, so recovery touches little.
   (Verify: anything recovery *does* touch faults synchronously via §4 - slow
   but correct. If recovery touches a lot, expand the eager set.)
6. **Faulting read:** `stream_ops.read` for an absent block-group → check
   presence bitmap → miss → block on the SAB bridge → worker range-GETs the
   group's frames, decrypts/decompresses, writes into `/tmp` + SAB, flips the
   bitmap → return bytes.
7. **Query-plan frontrunning:** before executing a user query, run it through
   the planner (parse / `EXPLAIN`), extract the relations + indexes, and
   prefetch their groups so execution hits warm cache. 4.4x lever on joins.
8. **Reactive readahead:** on a heap fault for block N of a relation, if a scan
   pattern is detected, prefetch subsequent groups of that relfilenode.

### Learned hot-set (the "snapshot the ultra-light version" instinct, done right)

The user's original instinct - "snapshot a 1-10MB version with the most-read
records so the app shows stuff fast" - maps to this, correctly: you cannot ship
"hot rows" (Postgres is paged, not rowed), but you *can* ship a **hot-page-set**.
A warm instance records which block-groups actually got faulted (a cheap access
trace), and writes a `prefetch.json` sidecar - a learned working set per
database. Next cold start prefetches exactly that set in parallel with boot.
This is the difference between "guess what's hot" and "replay what was hot."

## 7. Coexistence with the v1 commit path (correctness)

- **Commit is unchanged.** WAL shipping continues. A commit does not produce
  page groups; page groups are produced only at **snapshot/compaction time**
  (when v1 rolls a fresh snapshot, the snapshotter additionally slices the
  datadir into groups and records them in the manifest). So lazy restore reads
  from the *last compacted snapshot*; any WAL after it is replayed normally
  (and is tiny by design).
- **Consistency:** all faulted groups must come from the *same snapshot
  generation* the manifest names. Pin the object generation on every range GET
  (we already pin generations for streaming restore). A fault must never mix
  bytes across generations.
- **Replicas:** `ZeroPGReplica` gets lazy restore "for free" and benefits most
  (leaseless readers that converge by polling the manifest). On a new manifest,
  invalidate cached groups whose `(relfilenode, blockRange)` changed -
  turbolite does exactly this on `set_manifest()`.
- **Torn pages:** not a new risk - groups are immutable, content-addressed by
  generation; a half-written cache file is detected by the presence bitmap and
  re-faulted.

## 8. Spike plan & kill criteria

Ordered, each gates the next. All on `feat/lazy-page-restore`, never on `main`.

1. **Source recon (read-only):** document the exact pglite Emscripten FS
   extension surface (§5). Deliverable: a short `NOTES-pglite-fs.md` on the
   branch. **Kill if** `stream_ops.read` is not interceptable without forking
   pglite - then re-scope to "fork-with-upstream-PR" and stop.
2. **Sync bridge microbenchmark:** standalone Atomics+SAB+worker that satisfies
   one synchronous read by range-GETting one object from GCS on Cloud Run.
   Measure real per-fault latency (cold conn, warm conn, p50/p99). **Kill if**
   per-fault p50 > ~150ms even warm *and* group prefetch can't hide it.
3. **Sparse-restore boot:** open pglite on eager-set-only + sparse placeholders;
   confirm Postgres boots and a `SELECT` that touches a lazy relation faults
   correctly and returns right data. Verify against full-restore byte-identical
   results.
4. **TTFQ measurement + crossover:** measure TTFQ vs full-restore at
   10/50/500MB, find crossover `X` per provider. **This is the go/no-go for the
   whole feature** - if lazy doesn't beat eager on TTFQ for 500MB by a wide
   margin, stop.
5. **Prefetch:** query-plan frontrunning + learned hot-set; re-measure.
6. **WS-B (small DB, independent):** WASM module caching + boot profiling. Can
   land regardless of WS-A's fate.

Re-run the **crash matrix** (E2b) against lazy restore before any merge: SIGKILL
mid-fault, mid-prefetch, stale generation in cache.

## 9. Later: Rust core

Turbolite is Rust; its roadmap (Valkyrie io_uring VFS, Rosetta value-
partitioned index) is all about squeezing the cache/IO path. For us the
JS/TS sync-bridge + codec + cache is the natural first cut, but the
**cache + zstd codec + SAB bridge is a clean candidate for a Rust core** later
(native via napi-rs on Cloud Run/Lambda, wasm-bindgen in the browser/Workers),
exactly the "rewrite the hot path in Rust" move turbolite made. Out of scope
for the spike; noted so the JS interfaces are drawn to not preclude it (keep the
codec + cache behind a narrow, FFI-friendly boundary).

## 10. References

- turbolite: https://github.com/russellromney/turbolite (+ `ROADMAP.md`,
  HN thread https://news.ycombinator.com/item?id=47534283)
- sqlite-s3vfs (the one-object-per-page anti-pattern): https://github.com/simonw/sqlite-s3vfs
- sql.js-httpvfs (range-GET read-only SQLite over HTTP): https://github.com/phiresky/sql.js-httpvfs
- PGlite filesystems: https://pglite.dev/docs/filesystems (custom-FS surface is
  source-only; read `node_modules/@electric-sql/pglite/dist/fs/*`)
- Emscripten Asyncify overhead + OPFS sync-handle limits: see PGlite FS docs and
  emscripten-core discussions #19408, #21666
- zeropg internals this builds on: [DESIGN.md](DESIGN.md) §4.3 (read path),
  [V1-WAL-SHIPPING.md](V1-WAL-SHIPPING.md) (commit path we keep), [COST-MODEL.md](COST-MODEL.md)
