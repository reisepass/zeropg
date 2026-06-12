# Research notes: prior art and performance ideas for zeropg v2/v3

*Compiled 2026-06-12. Web research across Litestream/LiteFS, wal-g/pgBackRest, Neon,
Cloudflare Durable Objects/D1, turbopuffer, SlateDB, Delta/Iceberg/WarpStream, the 2024–25
object-storage primitive changes (S3 conditional writes, Express One Zone append, GCS Rapid
Storage), the PGlite ecosystem, and known pitfalls of bucket-backed databases.*

**Headline finding:** the design space shifted decisively in zeropg's favor in 2024–25 —
every major store now has CAS (S3 closed the gap Nov 2024), two stores now have
low-latency append (S3 Express One Zone, GCS Rapid Storage), and SlateDB has already
validated (and formally verified) the CAS-manifest + single-writer-fencing pattern on object
storage. **No competing PGlite-on-object-storage project exists as of June 2026** — zeropg is
greenfield; the closest neighbors are all SQLite (Litestream, LiteFS, Verneuil, Cloudflare SRS)
or full Postgres (Neon).

---

## Top 10 actionable ideas for zeropg v2/v3 (ranked by value/effort)

| # | Idea | Stolen from | Value | Effort | Target |
|---|------|-------------|-------|--------|--------|
| 1 | **Writer epoch fencing**: monotonic `writer_epoch` u64 in the manifest, bumped via CAS at writer startup; tag every WAL object with its epoch; manifest swap rejects ranges from older epochs; a fenced writer halts on first precondition failure | SlateDB RFC 0001 (formally verified) | Closes the zombie-writer hole that leases alone can't (paused-then-resumed instances) | Low | v2 |
| 2 | **Numbered immutable manifests** instead of CAS-swapping one `manifest.json`: write `manifest/00000000000000000042.json` with create-if-absent (`ifGenerationMatch:0` / `If-None-Match:*`); highest ID wins | SlateDB, Delta Lake `_delta_log/` | Dodges GCS's hard **1 mutation/sec per object** cap on the hot manifest key; free commit history/audit/PITR; cleaner total order | Low | v2 |
| 3 | **Group commit (~100 ms flush window) with `await_durable` opt-out**: batch all WAL bytes accumulated while a flush is in flight into the next single object — one PUT + one manifest per window, O(1) round trips for N transactions | SlateDB `flush_interval` (100 ms default), turbopuffer (≤1 commit/s), Cloudflare SRS (10 s / 16 MB) | Caps PUT cost ($5/M on S3/GCS) and CAS contention; turns rate limits into a latency dial | Low | v2 |
| 4 | **Output-gate async commit ack**: let the transaction commit locally and keep executing, but hold the HTTP response (and webhooks/queue publishes) until the WAL PUT + manifest CAS confirm; on failure discard held output and crash-restart | Cloudflare Durable Objects | Hides 50–200 ms commit latency behind response construction with zero durability loss | Medium | v2 |
| 5 | **Pre/post-apply checksum chain + monotonic TXID** in every WAL object (header: pre-apply checksum of DB state; trailer: post-apply): on restore, `post[i] == pre[i+1]` proves no missing/reordered/torn segment; LiteFS-style `TXID/rolling-XOR-of-page-checksums` position makes split-brain a hard detectable error | LTX format (Litestream v0.5 / LiteFS) | Strictly stronger integrity than trusting manifest ordering; catches CAS races and partial uploads | Low–Med | v2 |
| 6 | **Time-window hierarchical compaction + snapshot heuristic**: L0 = per-commit objects, L1 = 30 s merges, L2 = 5 min, L3 = hourly; full snapshot when `WAL-since-snapshot > db_size` (bounds cold-start reads to ≤2× DB size); restore = "a dozen or so files" regardless of write history | Litestream v0.5 levels, LiteFS Cloud (5 min/hourly/daily), Cloudflare SRS heuristic | Bounded cold starts; compactor runs lease-free on immutable inputs | Medium | v2 |
| 7 | **Parallel + prefetched restore**: fetch the next N WAL objects concurrently during replay (wal-g prefetch; pgBackRest archive-get, 128 MiB queue); stream the snapshot with ~10–16 concurrent 8–16 MiB ranged GETs so restore time = size/bandwidth, not object-count × TTFB; bundle small compaction outputs into ≥20 MiB objects | wal-g, pgBackRest | Big cold-start win, trivial to implement | Low | v2 |
| 8 | **Deferred deletion → PITR + zero-copy branches**: keep superseded manifests/WAL/snapshots 30 days (GCS lifecycle rules do it for free) → "restore to any point in the last 30 days"; a checkpoint = a pinned manifest ID; a **database fork** = a new manifest referencing the parent's objects (needs GC ref-counting) | D1 Time Travel ("an accidental feature"), SlateDB RFC 0004, Neon timelines | Killer feature (branch-per-preview-deploy) at near-zero storage code | Medium | v2/v3 |
| 9 | **Lazy page-faulting restore (GetPage-style VFS)**: start PGlite against a VFS that faults 8 KB pages/ranges on demand from snapshot objects (per-page compression + page-index trailer in each object), WAL overlay applied per page, LRU cache (litestream-vfs uses 10 MB), background hydration to full local copy | Neon on-demand layer download, litestream-vfs | First query becomes O(working set), not O(DB size) — the single biggest cold-start lever | High | v3 |
| 10 | **Appendable WAL-tail tier**: one appendable object per writer epoch — GCS Rapid Storage zonal buckets (sub-ms, unlimited appends, gRPC flush + tail-read, generation-based takeover) or S3 Express One Zone append (single-digit-ms, PUTs now $1.13/M = 4.4× cheaper than Standard, but hard 10,000-appends/object cap → rotate well before, e.g. every 4,096 commits); manifest in regional storage stays the commit point | GCS Rapid Storage (Next 2025), S3 Express append (Nov 2024), Neon's "NVMe for commit, S3 for truth" split | Sub-10 ms commit latency without giving up bucket-as-truth | Med–High | v3 |

**Honorable mentions:** lease *handoff* + 1 s lock-delay + "candidate must be ≥ manifest
high-water-mark" rule (LiteFS — fixes the empty-node-wins-election data-loss footgun);
WAL-derived changed-block tracking → block-incremental snapshots (wal-g/pgBackRest, >50×
smaller incrementals); GCS `compose` for download-free compaction (32 objects/request,
composable recursively); enforce-conditional-writes bucket policy (`s3:if-match`) as a guard
rail; bookmark tokens for session-consistent read replicas (D1 Sessions API); zstd for
snapshots / lz4 for the latency-critical WAL path.

---

## 1. Litestream internals

**What it does.** Classic Litestream (≤v0.4) is a sidecar that holds a long-running read
transaction on SQLite (preventing checkpoints it doesn't control), copies WAL frames into a
contiguous "shadow WAL" sequence, and organizes the bucket into **generations**: a random
16-hex-char ID bundling one snapshot + contiguous WAL segments; any continuity break
forces a fresh snapshot/generation. It parses real SQLite WAL frames and **verifies salt +
rolling checksum** as it reads, truncating at the last valid commit frame — that's how torn
writes become clean recovery instead of corruption. Defaults: `sync-interval` 1 s,
`checkpoint-interval` 1 m, snapshot interval 1 h.

**The v0.5 rewrite (Oct 2025).** Storage was rebuilt around **LTX (Lite Transaction File)**,
the format invented for LiteFS: a 100-byte header (`LTX1` magic, page size, **min/max TXID**,
timestamp, **pre-apply CRC-ISO-64 checksum** of the prior DB state), sorted
`(page#, page data)` frames, and a trailer with **post-apply checksum**. Generations were
removed entirely in favor of monotonic TXIDs. Why: the old design replayed every WAL frame
ever written (pathological for hot pages); LTX files are **mergeable** — compaction
deduplicates pages across contiguous TXID ranges. Compaction is time-window hierarchical:
L0 ≈ 1 s raw uploads, L1 = 30 s, L2 = 5 min, L3 = 1 h, so PITR restores touch "only a dozen or
so files on average." v0.5 adds per-page compression with a page index per file (fetch
individual pages without whole-file downloads), and replaces the old v0.4 live-read-replica
beta with **litestream-vfs**: a SQLite VFS that builds a page→LTX-offset index, faults pages
on demand from object storage (5–50 ms/page), keeps a 10 MB LRU, polls for new LTX every
1 s, and optionally hydrates the full DB in the background.

**zeropg should adopt:** LTX-style *page-changeset* objects (mergeable, unlike raw WAL
byte-ranges, which can only be replayed) — or at minimum LTX's TXID-range + pre/post
checksum framing on WAL objects (Top-10 #5); the L0–L3 compaction ladder (#6); checksum
verification while streaming the WAL tail at restore; and litestream-vfs as the proven design
sketch for a v3 lazy-restore PGlite VFS (#9).

Citations: <https://litestream.io/how-it-works/>, <https://fly.io/blog/litestream-v050-is-here/>,
<https://github.com/benbjohnson/litestream/releases/tag/v0.5.0>,
<https://github.com/superfly/ltx>, <https://litestream.io/reference/config/>,
<https://litestream.io/how-it-works/vfs/>, <https://fly.io/blog/litestream-vfs/>,
<https://github.com/benbjohnson/litestream/issues/8>.

## 2. LiteFS and LiteFS Cloud

**What it does.** LiteFS is a FUSE passthrough filesystem (chosen over a SQLite VFS so every
process gets replication with zero app changes) that detects transaction boundaries from
SQLite's own file protocol (journal create/invalidate; WAL write-lock byte range) and
serializes each transaction into an LTX file. Every node tracks a position
`TXID/rolling-checksum` — the rolling checksum is an incrementally maintained XOR of all
per-page checksums, so out-of-order application or post-failover divergence is *detected* and
the stale node auto-resnapshots from the new primary. Primary election uses a **Consul
time-based lease**: TTL 10 s (Consul's minimum), **lock-delay 1 s** "to prevent overlap in
leadership due to clock skew or in-flight calls," per-node `candidate` flag, and a static-lease
mode. Graceful shutdown releases the lease instantly; `lease.promote` does an explicit
**handoff** — with a documented footgun where an empty new node winning the election
clobbers the dataset. Replicas discover the primary via a `.primary` file and forward writes at
the app layer; the **HALT lock** lets a replica briefly pause the primary over plain HTTP, write
locally, ship the result back, with a hard 30 s auto-release (used for `rails db:migrate`).
**LiteFS Cloud** (deprecated 2024; its tech moved into Litestream v0.5) batched each
second's transactions into one LTX upload, tracked a **high-water-mark TXID** of what's
durable in S3 (a node may not be removed until its writes ≤ HWM), compacted into
5-minute/hourly/daily levels, and restored by streaming-merge: any 5-minute point in 30 days.

**zeropg should adopt:** the `TXID/rolling-checksum` position in the manifest with a
"prove your checksum matches before your next CAS" rule (#5); an explicit **HWM**
separating "uploaded" from "committed" — only acknowledge commits / allow scale-to-zero
once writes ≤ HWM; lease **handoff + lock-delay + candidate-position ≥ HWM** (honorable
mention — directly fixes LiteFS's data-loss footgun); a HALT-style 30 s admin write lock for
migrations from CI/laptops (v3); and `.primary`-style writer discovery in the manifest for
future read replicas.

Citations: <https://fly.io/blog/introducing-litefs/>, <https://fly.io/docs/litefs/how-it-works/>,
<https://fly.io/docs/litefs/config/>, <https://fly.io/docs/litefs/primary/>,
<https://fly.io/docs/litefs/run/>, <https://fly.io/blog/litefs-cloud/>,
<https://community.fly.io/t/litefs-promote-true-can-cause-data-loss-when-scaling-horizontally-seeking-guidance/26767>,
<https://community.fly.io/t/litefs-promote-and-with-halt-lock-on-without-consul/15549/2>.

## 3. Postgres WAL archiving to object storage: wal-g, pgBackRest, Neon

### wal-g / pgBackRest performance tricks

**wal-g** ships base backups + 16 MB WAL segments with lz4 (default) / zstd / brotli / lzma;
its **delta backups** store only 8 KB pages whose LSN changed, with the changed-page set
discovered *for free by scanning WAL during archiving* (`.delta` tracking files,
`WALG_DELTA_MAX_STEPS` chain cap). Its author frames a delta as "a compressed bunch of
WAL files" appliable **in parallel, orders of magnitude faster than serial WAL replay**.
Restore: `WALG_DOWNLOAD_CONCURRENCY` (default ~10), **WAL prefetch** into a local
cache dir ahead of replay, and even page-prefaulting on standbys. **pgBackRest** adds:
`process-max` parallel restore; **delta restore** (`--delta`: checksum local files, fetch only
diffs); **file bundling** (~20 MiB objects, files <2 MiB bundled — a demo backup went from
991 objects to 7); and **block incremental** (2023): files split into blocks (size scales with file
size/age), per-file **block maps** record which block version lives where — Crunchy measured
a >50× smaller incremental (52.8 MB → 943 KB) and a delta restore that moved 3.5 MB
instead of 30.4 MB. For WAL traffic, **archive-async** + a local spool acks Postgres
near-instantly while a background process pushes/prefetches segments in parallel
(archive-get queue default 128 MiB).

**zeropg should adopt:** WAL-derived changed-block tracking — zeropg already has every
WAL range in hand at commit time, so maintaining a dirty-page set is free, making
incremental snapshots a pure read-of-dirty-pages operation (block maps in the manifest,
pgBackRest-style); parallel prefetched restore (#7); bundling (never write tiny objects;
~20 MiB targets); `--delta`-style warm-start restore for reused Cloud Run instances
(checksum local blocks against the block map, fetch only diffs); zstd for snapshots, lz4 for the
WAL hot path; and a first-class `max_wal_objects_since_snapshot` compaction trigger
(both tools warn long delta chains degrade restore).

Citations: <https://github.com/wal-g/wal-g>, <https://wal-g.readthedocs.io/PostgreSQL/>,
<https://www.postgresql.org/about/news/wal-g-20-released-2456/>,
<https://groups.google.com/a/greenplum.org/g/gpdb-dev/c/ImJz6DlwT_A>,
<https://www.crunchydata.com/blog/pgbackrest-file-bundling-and-block-incremental-backup>,
<https://pgbackrest.org/configuration.html>, <https://pgbackrest.org/user-guide.html>.
(Note: pgBackRest's maintenance status was publicly questioned in 2026 —
<https://thebuild.com/blog/2026/04/30/after-pgbackrest/> — its techniques remain the prior art.)

### Neon (pageserver/safekeeper split)

**What it does.** "The database is the log": the only thing shipped per commit is the WAL
stream, sent Multi-Paxos-style from the primary (proposer) to three **safekeepers** on local
NVMe; commit = 2-of-3 quorum ack, and proposer election doubles as single-writer
enforcement. **S3 is never on the commit path.** Safekeepers feed **pageservers**, which
buffer WAL in memory, checkpoint ~1 GB at a time into immutable **delta layers**
(key-range × LSN-range) and background-materialize **image layers** (key-range @ LSN) to
bound read amplification; 128–256 MB layer files go to S3 as the durable source of truth.
Reads use **GetPage@LSN** (newest image layer ≤ LSN + deltas above it), which also gives
branching and PITR (a branch is a timeline at an LSN). Pageservers **download layers
on demand** from S3 on cache miss. Compute cold start went from 3–6 s to ~500 ms mostly
via *non-storage* work: pools of pre-created VMs, lazy config application, DNS caching.

**zeropg should adopt:** the core lesson — **separate the commit-durability path from the
page-materialization path** (v1 conflates them; an async compactor consuming WAL objects
into layer/snapshot objects means restore speed stops depending on accumulated WAL);
delta + image *partial* layers instead of monolithic snapshots (compaction cost ∝ churn, not
DB size); GetPage-style lazy faulting (#9); LSN-indexed retained manifests = free PITR and
copy-on-write branches (#8); and the cold-start analog of compute pooling — pre-instantiate
the PGlite WASM module at build time and keep all setup off the wake path. v3 could add a
Neon-style low-latency durability tier (Rapid/Express append, #10) while GCS stays truth.

Citations: <https://jack-vanlightly.com/analyses/2023/11/15/neon-serverless-postgresql-asds-chapter-3>,
<https://neon.com/blog/get-page-at-lsn>,
<https://github.com/neondatabase/neon/blob/main/docs/pageserver-storage.md>,
<https://neon.com/docs/introduction/architecture-overview>, <https://neon.com/blog/pitr-deep-dive>,
<https://neon.com/docs/changelog/2023-01-10>, <https://neon.com/blog/cold-starts-just-got-hot>.

## 4. Cloudflare Durable Objects SQLite + D1

**What it does.** Each DO runs SQLite in-process (reads/writes "in microseconds"); durability
comes from the **Storage Relay Service** streaming the SQLite WAL: writes are confirmed
once **3 of 5 followers** in different datacenters ack, then batched **up to 10 s or 16 MB**
into single objects on object storage. The app never waits: **output gates** hold back all
outgoing network messages until in-flight writes are durable — the response is built in
parallel with replication, and on write failure the held messages are discarded and the DO
restarts, so no premature confirmation ever escapes. **Input gates** block new event delivery
during storage ops (kills await-interleaving races). Un-awaited `put()`s are **coalesced**
into one atomic batch (O(1) round trips). SRS snapshots whenever **logs-since-snapshot >
db size** (restore reads ≤ 2× DB size) and merely *marks* old logs for deletion 30 days later —
which is exactly D1 **Time Travel** (30-day, minute-granularity PITR, "an accidental feature").
**D1 read replication** uses lexicographically sortable **bookmarks** (Lamport-style
positions in the WAL): a session's queries carry a bookmark and a replica blocks until it has
replayed past it — sequential consistency per session; measured replication lag 30–75 ms.

**zeropg should adopt:** output gates (#4) — the single best latency trick available to a
single-writer serverless DB; write coalescing across transactions while a flush is in flight (#3);
the snapshot heuristic and 30-day deferred deletion (#6, #8); bookmark tokens
(manifest ID + LSN, lexicographically sortable) in responses for future session-consistent
read replicas; and input-gate discipline around PGlite's async API.

Citations: <https://blog.cloudflare.com/sqlite-in-durable-objects/>,
<https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/>,
<https://blog.cloudflare.com/d1-read-replication-beta/>,
<https://developers.cloudflare.com/d1/reference/time-travel/>.

## 5. Object-store-native databases: turbopuffer, SlateDB, Delta/Iceberg/WarpStream

**turbopuffer** makes S3 the source of truth for a search engine: every write appends a WAL
object per namespace; concurrent writes are merged by **group commit, ≤1 commit/s per
namespace** (write p50 165 ms for 500 KB); the WAL has a **CAS commit point** giving
strong consistency by default. Reads: cold p50 **874 ms** for 1 M docs straight from object
storage, then NVMe/memory caching brings warm p50 to **14 ms**; the router *prefers* the
warm node but any node can serve any namespace. Indexing/compaction is async — recent
WAL data is served by exhaustive scan until indexed. → zeropg: never block commits on
compaction; document the cold/warm split with turbopuffer-style published numbers
(874 ms/14 ms is the bar); cache-affinity (not cache-pinned) routing matches Cloud Run.
<https://turbopuffer.com/architecture>

**SlateDB** is the closest design match: an embedded LSM whose *only* durable medium is
object storage ("zero disk"), single writer / many readers, targeting 50–100 ms write latency.
WAL buffer flushes every **`flush_interval` = 100 ms** (or when full); `put()` returns a future
resolving at durability, with `await_durable:false` as the escape hatch. **The manifest is the
commit point**: zero-padded numbered manifest files, highest ID wins, updated by
read-modify-write + CAS-on-next-slot with full-cycle retry. **Writer fencing via epochs**
(formally verified): bump `writer_epoch` in the manifest at startup, CAS an epoch-tagged
empty SST into the next WAL slot; any writer that finds a newer epoch "has been fenced …
should halt." **Checkpoints are zero-copy** (a manifest entry pinning a manifest version);
**clones** fork a DB that references the parent's SSTs while writing new ones to its own
prefix (GC needs cross-manifest ref-counting, RFC 0004). → zeropg: ideas #1, #2, #3, #8
come from here nearly verbatim.
<https://slatedb.io/rfcs/0001-manifest/>, <https://slatedb.io/docs/get-started/introduction/>,
<https://slatedb.io/rfcs/0004-checkpoints/>, <https://slatedb.io/rfcs/0008-synchronous-commit/>,
<https://docs.rs/slatedb/latest/slatedb/config/index.html>

**Delta/Iceberg/WarpStream.** Delta's commit is create-once of `_delta_log/<version>.json`
(now via S3 conditional PUT; previously a DynamoDB LogStore); Iceberg CASes a catalog
pointer with optimistic retry. WarpStream supplies the economics: stateless agents writing
straight to S3 cut a 560 MiB/s Kafka workload from ~$641/day in interzone fees to <$15/day,
at p99 produce ≈ 400 ms because acks wait for S3. → zeropg: adopt the optimistic retry loop
semantics (on CAS failure: re-read manifest, check epoch/fencing, rebase, retry — never blind
retry); prefer create-if-absent versioned manifests; copy WarpStream's honest
"cost win, ~100 ms-class latency" framing for the pitch.
<https://delta.io/blog/2022-05-18-multi-cluster-writes-to-delta-lake-storage-in-s3/>,
<https://github.com/delta-io/delta/issues/3596>,
<https://jack-vanlightly.com/analyses/2024/7/30/understanding-apache-icebergs-consistency-model-part1>,
<https://www.warpstream.com/blog/kafka-is-dead-long-live-kafka>

## 6. Object storage primitives (2024–2026)

**S3 conditional writes.** `If-None-Match:*` (Aug 2024) and `If-Match` ETag CAS on
PutObject/CopyObject/CompleteMultipartUpload (Nov 2024) on general purpose buckets;
bucket policies can *enforce* conditional headers (`s3:if-match`/`s3:if-none-match`). 412 =
lost the race; 409 = concurrent-delete race (retryable; MPU must restart); `If-Match` on a
deleted key = 404. Caveats: ETag-based (not a generation number → theoretical ABA, unlike
GCS), and conditional PUTs ignore in-progress MPUs. **Failed conditional requests bill at
full request price.**
<https://aws.amazon.com/about-aws/whats-new/2024/08/amazon-s3-conditional-writes/>,
<https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes/>,
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>,
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/ErrorCodeBilling.html>

**S3 Express One Zone.** Single-digit-ms directory buckets; **append** since Nov 2024
(`x-amz-write-offset-bytes`, ≤5 GiB/append, hard cap **10,000 appends per object**);
April 2025 price cuts: PUT ≈ **$1.13/M** (vs $5/M Standard), GET ≈ $0.03/M — the cheapest
*and* fastest commit path on AWS, at single-AZ durability.
<https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-express-one-zone-append-data-object/>,
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-buckets-objects-append.html>,
<https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone/>,
<https://blog.astradot.com/s3-express-append-has-issues/>

**GCS.** `ifGenerationMatch` is true generation-number CAS (stronger than ETag; no ABA)
and has existed for years; `ifGenerationMatch:0` = create-if-absent. **Rapid Storage** zonal
buckets (Cloud Next 2025, built on Colossus's stateful protocol): sub-ms random reads/writes,
gRPC bidi-streaming **appendable objects with no append-count limit**, flush-then-tail-read,
finalize-to-immutable, and **writer takeover via generation number** — i.e., fencing is built
in. **Compose** concatenates up to 32 objects server-side (composites composable again →
trees cover thousands of segments), with destination preconditions.
<https://cloud.google.com/storage/docs/request-preconditions>,
<https://cloud.google.com/blog/products/storage-data-transfer/cloud-storage-rapid-turbocharges-object-storage-for-ai-analytics>,
<https://docs.cloud.google.com/storage/docs/rapid/use-objects-in-zonal-buckets>,
<https://docs.cloud.google.com/storage/docs/composing-objects>

**R2** supports `If-Match`/`If-None-Match`/`If-(Un)Modified-Since` on PUT via both S3 API
and Workers bindings (`onlyIf`) — but had real conditional-logic bugs in the bindings
(workers-sdk #6411, workerd #2572): keep a CAS conformance test in CI per backend.
**S3 multipart trick** for append-ish behavior: `UploadPartCopy` (server-side copy of existing
objects as parts) + conditional CompleteMultipartUpload — but parts must be **≥5 MiB**, so
tiny WAL segments need batching first. Azure append blobs (4 MiB blocks, 50k blocks) are
the old prior art for the append pattern.
<https://developers.cloudflare.com/r2/api/s3/extensions/>,
<https://github.com/cloudflare/workers-sdk/issues/6411>, <https://github.com/cloudflare/workerd/issues/2572>,
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>

**zeropg should adopt:** a portable CAS layer with documented per-backend strength tiers
(GCS generation > S3/R2 ETag); the appendable WAL tail (#10); GCS compose for
download-free L1 compaction; enforce-conditional-writes bucket policy on
manifest/WAL prefixes; budget and jittered backoff for 412s (they bill at full PUT price).

## 7. PGlite ecosystem

**What exists.** PGlite (~3 MB gzipped WASM Postgres, by ElectricSQL, building on Stas
Kelvich's single-user fork) is **single-connection** with a VFS layer: in-memory (default),
NodeFS, IndexedDB FS (loads everything into memory at start, **flushes dirty files after each
query**, `relaxedDurability` option), and OPFS access-handle-pool (broken on Safari's
252-sync-handle cap). Custom user filesystems are *planned* but not shipped. **No
S3/GCS persistence project for PGlite surfaced anywhere** — zeropg is first.
**pglite-fusion is a red herring**: it's a pgrx extension embedding *SQLite* files as a column
type in server Postgres, unrelated to PGlite persistence. ElectricSQL direction:
`@electric-sql/pglite-sync` syncs Electric "shapes" *into* PGlite (read path); PGlite v0.4
(Mar 2026) brought a cleaner architecture, **connection multiplexing over the single
connection**, PostGIS, 13 M+ weekly downloads; roadmap: custom-FS API, libpglite,
multi-connection via workers, **logical replication** (which could replace byte-range WAL
shipping entirely in a far-future v4).

**zeropg should adopt:** claim the gap loudly ("Litestream/SlateDB for PGlite"); mirror the
IndexedDB-FS pattern (in-memory overlay + dirty-range capture post-transaction) rather than
waiting for the official custom-VFS API; treat the single-connection limit as a feature aligned
with the single-writer lease (v0.4 multiplexing still gives concurrent app requests); track the
custom-FS API and logical replication; consider Electric shapes as the complementary
read-replica fan-out story.

Citations: <https://pglite.dev/docs/filesystems>, <https://github.com/electric-sql/pglite>,
<https://electric-sql.com/product/pglite>, <https://electric.ax/blog/2026/03/25/announcing-pglite-v04>,
<https://pglite.dev/docs/sync>, <https://github.com/frectonz/pglite-fusion>,
<https://engineering.backtrace.io/2021-12-02-verneuil-s3-backed-asynchronous-replication-for-sqlite/>.

## 8. Known pitfalls of object-storage-backed DBs

**Rate limits.** S3: ≥3,500 PUT / ≥5,500 GET per second *per partitioned prefix* (503 "Slow
Down" while it scales). GCS: per-bucket ramp of ~1,000 writes/s and 5,000 reads/s (double
load no faster than every 20 min; hierarchical-namespace buckets get 8× initial QPS;
randomized key prefixes recommended). **The killer constraint: GCS allows ~1 mutation/sec
per object name** (429s beyond) — documented pain in delta-rs, lance, Pulumi, and tusd for
exactly the "hot manifest key" pattern. A single CAS-swapped `manifest.json` therefore caps
GCS commit throughput at ~1 commit/sec → numbered manifests (#2) and/or group
commit (#3) are not optional at any real write rate.
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html>,
<https://docs.cloud.google.com/storage/docs/request-rate>,
<https://github.com/delta-io/delta-rs/issues/2451>, <https://github.com/lancedb/lance/issues/2272>,
<https://github.com/pulumi/pulumi/issues/4258>, <https://github.com/tus/tusd/issues/343>

**TTFB vs throughput.** S3 Standard small-object/first-byte latency ≈ 100–200 ms;
throughput is won with parallel 8–16 MiB ranged GETs — restore should be
bandwidth-bound, never object-count × TTFB bound. Express One Zone and GCS Rapid are
single-digit-ms / sub-ms.

**Request pricing.** S3/GCS Standard PUTs ≈ **$5/M**, GETs ≈ $0.40/M: a steady
10 commits/s × (1 WAL PUT + 1 manifest PUT) ≈ 52 M PUTs/month ≈ **$260/mo**; 1 commit/s
≈ $26/mo — group commit is the cost lever. R2: Class A $4.50/M, Class B $0.36/M, **zero
egress** (cheapest restore/read-replica path). Express PUTs $1.13/M. Failed CAS attempts
bill like successes. **Consistency is solved**: S3 strongly consistent since Dec 2020, GCS and
R2 likewise — manifest-pointer commit points are safe on all three.
<https://aws.amazon.com/s3/pricing/>, <https://cloud.google.com/storage/pricing>,
<https://developers.cloudflare.com/r2/pricing/>, <https://aws.amazon.com/s3/consistency/>

**zeropg should adopt:** numbered-manifest key rotation (#2); prefix-sharded WAL keys
(`wal/{hash2}/{epoch}-{seq}`, never purely sequential at rate; consider GCS HNS buckets);
group commit sized by a published cost dial ("commit cost per million transactions" belongs
in COST-MODEL.md / the marketing); parallel ranged-GET restore (#7); exponential backoff
with jitter on 503/429 plus a circuit that *widens the group-commit window under throttling*
(the delta-rs/lance failure mode is retry storms on the manifest); R2 for free-egress demos
and read paths.

---

## How this maps onto the current zeropg design

- **V1-WAL-SHIPPING.md's "generation per writer life"** is the Litestream ≤v0.4 design;
  Litestream v0.5 *removed* generations in favor of monotonic TXIDs + epoch fencing —
  worth converging the same way (ideas #1, #5) so restore lineage is one dimension, not two.
- **Manifest v2 as single CAS-swapped object** hits GCS's 1-update/sec per-object cap at
  exactly the commit rates E5 wants to soak-test; numbered manifests (#2) fix it and make
  the E2c crash harness's ordering assertions simpler (lexicographic listing = commit order).
- **"Snapshot = compaction, not commit"** is validated by every system surveyed; the next
  step is making compaction *hierarchical* (#6) and *zero-copy/branchable* (#8).
- **The honest trade-off to document** (WarpStream-style): zeropg commits cost one PUT
  round-trip (50–200 ms standard, single-digit-ms on Express/Rapid) where Neon pays for
  NVMe safekeepers to get sub-10 ms — that's the price of "the bucket is the database," and
  output gates (#4) hide most of it from end users.
