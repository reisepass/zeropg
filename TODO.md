# TODO — next steps

Two tracks run in parallel. **Track A** (writer/engine) and **Track B** (R2) share
nothing operationally (different cloud, different bucket, different transport),
so they can be worked by two sessions at once without colliding on the GCS
bucket or the live Cloud Run demos. Background and ranking: [docs/ROADMAP.md](docs/ROADMAP.md),
[docs/RESEARCH-NOTES.md](docs/RESEARCH-NOTES.md). Status: [STATUS.md](STATUS.md).

---

## Track B — Cloudflare R2 (do this in parallel, high priority)

Bring zeropg up on R2 + a scale-to-zero compute, mirroring what we proved on
GCS + Cloud Run. R2 is the cost-optimal home (free egress, cheap storage,
generous free tier — see [COST-MODEL.md](COST-MODEL.md)), so it is the next
platform to make first-class, not a someday-port.

1. **`R2BlobStore` transport** in `packages/blobstore` (sibling to `gcs.ts`).
   R2 speaks the S3 API and Workers bindings both support conditional writes
   (`If-Match` / `If-None-Match` / `onlyIf`). Implement get/put/list/delete +
   conditional PUT, parallel-range streaming GET, chunked streaming PUT, plus
   the `CostModel` (Class A $4.50/M, Class B $0.36/M, **$0 egress**, 10GB +
   1M writes/mo free tier).
2. **CAS conformance suite, run against real R2 before trusting it.** R2 has
   shipped genuine conditional-write bugs in the bindings (workers-sdk #6411,
   workerd #2572). Port E0 (the 20-way race / create-if-absent / CAS-on-stale
   probes) to R2 and make it a CI gate per backend — test the primitive, not
   the docs. This is the kill-criterion step: if R2's CAS isn't sound, the
   lease/manifest design doesn't hold there.
3. **CAS strength tier**: R2/S3 are ETag-based (theoretical ABA) vs GCS's true
   generation numbers. Document the per-backend strength tier in the transport;
   decide whether the numbered-manifest plan (Track A #2) makes ABA moot.
4. **Compute target — pick and run one:**
   - **Durable Object tier** (DESIGN.md 4.7): a DO per database owns the PGlite
     instance and persists to R2. The platform guarantees single-threaded,
     globally-unique execution, so the lease is belt-and-suspenders. Ships
     soonest, strictly safest, and is the Cloudflare-native answer.
   - **Generic Worker tier**: plain Worker → R2 with the lease doing the real
     work. Needed anyway for the portable story; more exposed to the lifecycle
     hazards E4 probed on Cloud Run.
5. **Port the experiment harness to R2/CF**: E2c (incremental round-trip +
   crash matrix), E3 (cold-start distribution — Workers/DO cold start differs
   from Cloud Run's ~2s floor), E4 (lifecycle: DO eviction, Worker CPU limits,
   `waitUntil` flush on eviction). Reuse the same JSONL result format.
6. **Free-egress unlocks the read-replica / CDN-seeded client story** that's
   expensive on GCS/S3. Once the writer works, R2 is where `ZeroPGReplica`
   hydration from the bucket (and browser-side PGlite booting from a
   CDN-cached snapshot) becomes free — prototype it here first.

**Watch:** Workers CPU-time limits vs initdb/restore (seed from a prebuilt
empty snapshot, as on GCS); DO storage vs R2 as the durable tier (DO is the
single-writer container, R2 is the generation store underneath); the bindings'
conditional-write semantics (step 2 is non-negotiable).

---

## Track A — writer / Postgres-engine (continue on GCS + Cloud Run)

### A1. Postgres WAL-reduction GUCs (the under-explored lever)

The research was storage-systems-centric and skipped the engine knobs that
decide how many WAL bytes Postgres writes per transaction. We pin
`max_wal_size`/`min_wal_size`/`wal_recycle=off`/`wal_init_zero=off`/
`synchronous_commit=on` but nothing that shrinks per-commit volume.

1. **`full_page_writes=off` — investigate, gated on the crash harness. Highest-value
   unexplored idea.** Postgres writes a full 8KB page image into WAL on the
   first change to each page after a checkpoint, to repair torn pages on crash
   recovery — often the *majority* of WAL bytes. zeropg never recovers from a
   torn local datadir: it restores from a consistent post-CHECKPOINT snapshot
   on tmpfs and replays complete, LSN-verified WAL over it, so that protection
   is plausibly redundant. Turning it off could shrink every incremental commit
   and stretch compaction intervals by a large factor.
   - **This is correctness-sensitive, not a free win.** Must pass E2b/E4
     (kill mid-commit → restore → byte-identical verify) *specifically* with
     FPW off before trusting it. If any path ships a range whose base page
     isn't fully captured, FPW is exactly what would have saved it.
   - Measure WAL volume per commit and compaction frequency FPW on vs off at
     1/50/500MB to quantify the win.
2. **`wal_level` guardrail — must stay `replica`, document why.** Do NOT drop to
   `minimal`. Under `minimal`, bulk ops (`COPY` into a same-txn-created table,
   `CREATE TABLE AS`, `CREATE INDEX`) skip WAL entirely and only fsync files at
   commit — those changes would never appear in a shipped segment and vanish
   until the next full snapshot. A data-loss landmine *because* we ship WAL.
   Add as a code comment at the GUC list and a named constraint in
   V1-WAL-SHIPPING.md.
3. **`wal_compression=lz4`** — compresses full-page images inside WAL, shrinking
   the shipped LSN range itself (before per-segment gzip). Lower priority if A1
   lands (no FPIs to compress); measure regardless.

### A2. Numbered immutable manifests (ROADMAP v2 #2) — throughput/correctness ceiling

Replace the single CAS-swapped `manifest.json` with create-if-absent numbered
manifests (`manifest/00000000000042.json`, highest ID wins). Motivation is
hard, not cosmetic: GCS caps mutations per object **name** at ~1/s (E5b
measured 52% rejections beyond it), so one manifest name caps commit rate.
Numbered manifests remove the per-name cap, give free commit history/PITR, and
make crash-harness ordering assertions simpler (lexicographic list = commit
order). Prioritize before/with the E5 soak, since the soak will hit the cap.

### A3. Output gates (ROADMAP v3 #7) — cheapest latency win

Commit locally, keep executing, hold the client HTTP response (and any
webhooks/queue publishes) until the WAL PUT + manifest CAS confirm; on failure
discard held output and crash-restart. Hides 50-200ms commit latency behind
response construction with zero durability loss. Pairs with `await_durable:
false` per-query opt-out. Doesn't touch the durability model — pure latency.

### A4. Promote from footnotes

- **Content-addressed / dedup snapshot chunking** (Verneuil-style): hash
  snapshot pages, store by content hash, dedupe unchanged pages across
  snapshots. Makes A2-era branching (ROADMAP #8) cheaper and snapshots
  incremental (currently only WAL is incremental; snapshots are whole).
- **Client-side encryption** (AES-256-GCM, turbolite-style): more than a v2
  flag for the self-hostable "untrusted bucket" positioning. Decide if it's
  a launch feature.

### A5. Finish the original plan

- **E5 — 72h soak + real billing**, reconciling [COST-MODEL.md](COST-MODEL.md)
  line-by-line against the actual GCS + Cloud Run bill (traffic generator +
  `scripts/gc.ts` exist). Do A2 first so the soak doesn't fight the manifest cap.

---

## Housekeeping

- Remove tracked scratch files `_debug-v1.mjs`, `_debug-v2.mjs` from the repo
  (and add `_debug-*.mjs` to `.gitignore` alongside `_waltest.mjs`).
- `packages/*/package.json` set `main`/`exports` to `src/*.ts`; before npm
  publish they need a build step (tsc/tsup) and `dist` outputs. Fine for review
  as-is.
- Stale header comment in `packages/objectstore-fs/src/zeropg.ts` still
  describes the "v0 whole-datadir snapshot per commit" strategy and "v1 will
  replace..." — v1 shipped; update the header so reviewers aren't misled.
- Commit messages: clean, `reisepass` only, **no `Co-Authored-By`/Claude
  trailers** (the VM now has the global CLAUDE.md enforcing this).
