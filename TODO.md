# TODO — next steps

Two tracks run in parallel. **Track A** (writer/engine) and **Track B** (R2) share
nothing operationally (different cloud, different bucket, different transport),
so they can be worked by two sessions at once without colliding on the GCS
bucket or the live Cloud Run demos. Background and ranking: [docs/ROADMAP.md](docs/ROADMAP.md),
[docs/RESEARCH-NOTES.md](docs/RESEARCH-NOTES.md). Status: [STATUS.md](STATUS.md).

---

## Track D — secondary cold-storage backups ✅ DONE (merged to main 2026-06-14)

A database system cannot ship without proven backups. Track D is the "daily
backups to a second, colder place, keep the last N / drop older than X days"
feature, expressed in zeropg's object model. Design: [docs/D-COLD-BACKUP.md](docs/D-COLD-BACKUP.md).

- **D1-D3 ✅** `ColdArchiver.backupOnce()` + CAS'd backup index; retention engine
  (`keepLast` + `maxAgeDays` + GFS, union keep-set, never-delete-newest, cold-tier
  min-storage-duration guard); `restoreFromBackup` + `scripts/backup.ts` /
  `scripts/restore-backup.ts` + the store-less round-trip test
  (`experiments/d-cold-backup.ts`).
- **Default wiring ✅** `ZeroPGOptions.backup` (`BackupTarget`): every compaction
  snapshot auto-takes a cold backup of that committed point + a retention sweep,
  on a non-fatal background hook awaited by `close()`/`flush()`. Unset ⇒ no-op,
  so single-bucket setups are unaffected.
- **E6 disaster matrix ✅** `experiments/e6-backup-disaster.ts`, each fault x20
  against real IBM COS: SIGKILL mid-backup, primary-snapshot loss, full primary
  wipe → byte-identical rebuild that boots + serves SQL, retention never deletes
  the last restorable backup, crash during retention GC, index CAS races, crash
  during restore, 1/50/500MB round-trips. Results in `results/e6-disaster.jsonl`.
- **Bug fixed (E6-caught):** a crash between the backup-object PUT and the index
  append orphaned the object un-adoptably → nothing restorable. `adoptExisting`
  now reconstructs the orphan's index entry from the manifest + a HEAD. See the
  design doc's "Bug E6 caught" section.
- **Deferred:** D4 (storage-class plumbing + cost rows for Archive/Glacier/IA),
  D5 (incremental/PITR mode, after A2's numbered manifests).

---

## Track B — Cloudflare R2 (do this in parallel, high priority)

> **Status 2026-06-13 — landed (build + design); live-R2 gate pending creds.**
> `R2BlobStore` (S3 API + SigV4, streaming + multipart + R2 `CostModel`) in
> `packages/blobstore/src/r2.ts`; transport-agnostic CAS conformance suite
> (`experiments/cas-conformance.ts`) **passes all 5 probes against GCS** and is
> one env-block from gating real R2; `casStrength` tier added to `CostModel`
> (GCS `generation` / R2 `etag`, ABA shown moot — B3 done); Durable-Object
> compute recommendation + Workers/DO porting plan + free-egress replica plan in
> [docs/R2.md](docs/R2.md), with a typechecking DO/Worker skeleton in
> `examples/cloudflare-do/`. **Blocked on real R2 credentials:** the live-R2
> conformance run (the non-negotiable per-backend gate), deploying the DO/Worker,
> and porting E2c/E3/E4 for real numbers.

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

## Track C — IBM Cloud (Code Engine + COS): the next experiment after R2

The most interesting next platform. IBM Cloud has **both** halves of a perfect
match for zeropg: **Cloud Object Storage** (25GB free Lite tier) and **Code
Engine**, a scale-to-zero container runtime that is a near-exact analog of
Cloud Run. So the experiment is: run the *whole* zeropg stack — writer +
storage — entirely inside IBM Cloud, the same shape we proved on GCS, on the
most generous free tier found in the storage survey ([docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md)).

> **Prepared 2026-06-13 — credentials + storage are live on the orchestrator VM:**
> - `ibmcloud` CLI installed on blob-pglite-dev, logged in via API key
>   (account "Forest Protocols Inc", region eu-de); `cloud-object-storage` and
>   `code-engine` plugins installed.
> - COS Lite instance `zeropg-cos` + bucket `zeropg-exp-eude-cd4040f4` created.
> - HMAC credentials + endpoints + bucket in `~/.zeropg-ibm.env` (chmod 600,
>   NOT in the repo). `source ~/.zeropg-ibm.env` to use.
> - **CAS confirmed live**: a probe through our own `R2BlobStore` (S3+SigV4)
>   pointed at the COS endpoint passed both create-if-absent AND
>   compare-and-swap-on-update. So **the existing S3 transport already drives
>   IBM COS with zero new transport code** — just construct `R2BlobStore` with
>   `endpoint=$COS_ENDPOINT`, the HMAC keys, and `region=eu-de`.

Steps:

1. **Confirm the storage half is wired** (done in spirit): run the
   transport-agnostic `experiments/cas-conformance.ts` against COS (point it at
   the env above) so the per-backend gate is on record alongside GCS/R2. Decide
   whether COS deserves a named `IbmCosBlobStore` thin wrapper (endpoint +
   `casStrength: 'etag'`) or just documented `R2BlobStore` construction.
2. **Code Engine deploy**: containerize the e3-service (already built) and
   `ibmcloud ce application create` it with scale-to-zero (min-scale 0,
   max-scale 1, concurrency 1 — the Cloud Run flags have direct CE analogs).
   Use the COS **direct** endpoint (`$COS_ENDPOINT_DIRECT`,
   `s3.direct.eu-de…`) from inside Code Engine — same-cloud, no egress.
3. **Port the experiment harness**: E3 (cold-start distribution — CE's
   cold-start floor vs Cloud Run's ~2s is the headline unknown), E2c
   (incremental round-trip + crash matrix) against COS, E4 (CE lifecycle:
   scale-to-zero handoff, SIGTERM grace, the idle-shutdown-vs-new-request race
   — CE's revision/scaling behavior may differ from Cloud Run's). Reuse the
   JSONL result format; this produces the IBM column for the cost/perf tables.
4. **Cost reconcile**: COS Lite 25GB free + CE free grant (vCPU-s/GiB-s monthly,
   like Cloud Run's). Update [COST-MODEL.md](COST-MODEL.md) and
   [BREAK-EVEN.md](BREAK-EVEN.md) with a measured IBM row — IBM may be the
   cheapest all-in free-tier home (25GB storage vs R2's 10GB / GCS's US-only 5GB).

**Watch:** Code Engine cold-start latency and CPU-throttling behavior between
requests (the E4 lease-liveness bet — request-path lease validation, no
background work — must re-hold on CE); COS `If-None-Match: *` wildcard already
confirmed; CE's max instance / concurrency knobs map to the single-writer model.

---

## Track A — writer / Postgres-engine (continue on GCS + Cloud Run)

> **Status 2026-06-13.** A1 **landed**: `full_page_writes` is configurable
> (`ZeroPGOptions.fullPageWrites` / `ZEROPG_FULL_PAGE_WRITES`), plus
> `wal_compression`. Default stays stock-safe ON; OFF ships **~22× less WAL**
> (~46KB vs ~1MB per update-commit) and cut compactions 11→3 over 200 commits
> (`results/fpw.jsonl`). **Crash-gated on main**: E2b 20/20/20 + e4b pass with
> FPW both on AND off (`results/trackA-merge-battery.log`) — FPW-off proven
> safe to enable; kept opt-in pending the E5 soak. A1.2 **done** (wal_level
> guardrail comment + V1-WAL-SHIPPING.md constraint). A1.3 measured (only
> `pglz` in the WASM build). A2 **design only** —
> [docs/A2-NUMBERED-MANIFESTS.md](docs/A2-NUMBERED-MANIFESTS.md), no change to
> the commit point yet. **Remaining: A2 implementation, A3 output gates, A4
> dedup-chunking / client-encryption, A5 the 72h E5 soak.**

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

## Track E — unified client / DX package (the "default Postgres everywhere" story)

The product thesis (see chat + future `docs/DX.md`/`docs/POSITIONING.md`): zeropg
should be someone's *default* way to use Postgres — in local dev AND in
scale-to-zero prod — through **one package with one interface**, where the only
thing that changes from laptop to bucket to always-on server is the connection
string. This is DESIGN.md §5 made literal. Three core pieces:

### E1. Local lockfile mechanism — prevent file corruption from concurrent processes

PGlite is single-connection/single-process and the NodeFS backend has no
cross-process guard, so hot-reloading dev servers (Next.js, `tsx watch`,
nodemon) routinely overlap an old + new process on one datadir and tear the
files. **We own this in our client wrapper — no PGlite fork** (DESIGN §7: a fork
inherits the WASM build burden for zero benefit here). Two layers, both
fork-free, both in our `connect()` layer around the PGlite open/close:

1. **Cross-process**: a sibling `.lock` file created with `O_EXCL` (`'wx'`)
   holding the owner PID; on `EEXIST`, reclaim if the holder PID is dead
   (`process.kill(pid,0)`), else wait out the live holder (reuse the existing
   `acquireTimeoutMs` boot-wait — the hot-reload overlap is the *same* problem
   as the Cloud Run revision-switch double-instance window we already solved).
   This mirrors upstream PGlite PR #892
   (https://github.com/electric-sql/pglite/pull/892, NodeFS `.lock` +
   `takeover`, currently unmerged) — replicate it externally; cheer the PR along
   as defense-in-depth but do not depend on it landing.
2. **Same-process HMR**: a PID lockfile can't distinguish two PGlite instances
   in the *same* process (Next.js module reload keeps the process alive). Pin
   the instance to `globalThis` keyed by datadir (the Prisma-client-in-Next-dev
   pattern) so a reload reuses the one instance instead of opening a second.

Note this is the *local* analog of the remote single-writer protection, which
is already built and stronger: the bucket lease + fencing tokens (E4 P4 fenced a
live rival service). `O_EXCL` and `If-None-Match: *` are the same atomic
primitive in two media (STORAGE-BACKENDS.md lists both). For remote we do NOT
trust the platform's `max-instances=1` — the lease is the protection and it
already passed the rival-service test.

### E2. Single env-var connection-string switch — `connect(DATABASE_URL)`

One factory, one node-postgres-shaped interface (`query`/`transaction`/`end`,
`{rows,rowCount,fields}`), four engines behind it, **zero app code change** across
the ladder. **Bundle `pg`** as a dependency so `postgres://` works with no extra
install.

| `DATABASE_URL` | engine | driver app sees |
|---|---|---|
| `memory://` | embedded PGlite in-process | pg-shaped adapter |
| `file://./dev.db` | PGlite (local lockfile from E1; optionally behind a managed localhost `pglite-socket` server for true multi-process + real-wire parity) | adapter or real `pg` |
| `gs://` / `r2://` / `s3://` / `cos://` | bucket-backed zeropg, scale-to-zero | adapter over the server's HTTP `/sql` |
| `postgres://…` | graduated RDS / Cloud SQL / Neon | real `pg` |

Decide the `file://` default: in-process embed (fast, lockfile-protected) vs
auto-managed `pglite-socket` server (kills multi-process corruption by
construction + gives byte-identical `pg`-over-wire parity with prod). Likely:
`memory://` in-process, `file://` defaults to the socket server, lockfile as the
opt-out path's guard. Builds on `packages/server` (`ZeroPGRemoteClient`, the
standalone server's loopback 5432 + `/sql`).

### E3. Pre-warm / wake — ALREADY BUILT; expose it through the unified client

`packages/server` already has both halves: the server serves `/wake` (the HTTP
request itself wakes the instance), `/ready` (restore progress), `/healthz`/`/up`;
`ZeroPGRemoteClient` (`packages/server/src/remote-client.ts`) has `wake()`,
`waitReady()`, and `ensureReady()` (wake + poll-until-restored in one call).
Remaining work: surface `ensureReady()` through the E2 unified client (so a
remote `connect()` can pre-warm before first query), and add a CLI `prewarm`
command (and document the `/wake` ping for an external scheduler/keepalive).

> See also: the OSS local **studio** (`npx @zeropg/studio`) — registry +
> connection-string vault + free-tier usage gauge (derived from a bucket LIST,
> not billing APIs) + SQL console — to be specced in `docs/STUDIO.md`. Separate
> from this package but the same "client-side, we host nothing" philosophy.

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
