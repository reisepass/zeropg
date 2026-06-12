# Experiments: validating blob-pglite on Google Cloud

Goal: prove (or break) the DESIGN.md architecture on Cloud Run + GCS with the smallest possible code per step. Each experiment has a deliverable (code to write), a question it answers, and a kill criterion - the result that would force a design change. Run them in order; each de-risks the next.

Shared infra for all experiments:

- A GCP project, one regional GCS bucket (same region as Cloud Run, e.g. `europe-west1`), one Artifact Registry repo.
- A `scripts/` dir with `deploy.sh` (gcloud run deploy with pinned flags) and `nuke-prefix.sh` (clear a bucket prefix between runs).
- All measurements logged as JSON lines so results can be compared across runs.

## E0: GCS conditional-write primitives (no PGlite, no Cloud Run)

The entire design rests on `ifGenerationMatch` doing what the docs say. Verify it first, from a laptop, in an afternoon.

**Code to write:**
- `packages/blobstore/src/types.ts` - the `BlobStore` interface from DESIGN.md 4.1.
- `packages/blobstore/src/gcs.ts` - GCS JSON API transport (plain `fetch`, no SDK: Cloud Run gives us a metadata-server token, locally use ADC). Implements `get`/`put`/`list`/`delete` with `ifGenerationMatch` support on `put`.
- `experiments/e0-primitives.ts` - a probe script.

**Probes:**
1. Create-if-absent: `put` with `ifGenerationMatch=0` succeeds on a fresh key, fails with 412 on an existing key.
2. Compare-and-swap: `put` conditioned on the current generation succeeds; conditioned on a stale generation fails with 412.
3. Race: fire N=20 concurrent create-if-absent puts for the same key (and separately N concurrent CAS puts against the same base generation). Assert exactly one winner every time, over 100 rounds.
4. Read-after-write: immediately `get` after a winning `put`, confirm the body is the winner's (GCS is strongly consistent; confirm, don't assume).
5. Record p50/p99 latency for GET/PUT/conditional-PUT on 1KB, 1MB, 16MB objects from laptop (baseline only; E3 repeats this from inside Cloud Run).

**Kill criterion:** any race round with two winners, or 412s not behaving as documented. (Expected: passes. This is cheap insurance.)

**Also:** run the same probe against `fake-gcs-server` to find out whether it honors generation preconditions well enough for CI. If not, CI uses real GCS with a dedicated bucket, or we accept MinIO+S3-transport for CI and real-GCS only in these experiments.

## E1: lease protocol library (laptop, real GCS)

**Code to write:**
- `packages/lease/src/lease.ts` - acquire (create-if-absent), renew (CAS on own generation), takeover-if-expired (CAS), release; fencing token sourced from the manifest; clean typed errors (`LockedError`, `FencedError`).
- `experiments/e1-lease.ts` - scenario runner with a fake clock injected for TTL tests.

**Probes:**
1. Second acquirer gets `LockedError` with holder + expiry in the message.
2. Two simultaneous takeover attempts on an expired lease: exactly one wins (CAS), token increments exactly once.
3. Zombie simulation: holder A's lease expires, B takes over (token+1), A attempts a manifest CAS with its stale generation - must fail. Run 100 iterations.
4. Heartbeat under jitter: renew loop with random 0-2x delays around the TTL boundary; assert the invariant "A renews successfully XOR B can take over," never both.

**Kill criterion:** any interleaving where two holders both believe they hold the lease AND both can advance the manifest. (Token bookkeeping bugs show up here, not in production.)

## E2: ObjectStoreFS v0 end-to-end (laptop → GCS)

The crude-but-correct v0 from the roadmap: whole-datadir tarball per sync, manifest CAS as commit.

**Code to write:**
- `packages/objectstore-fs/src/index.ts` - PGlite `Filesystem` implementation over MemoryFS: `initialSyncFs` restores manifest+snapshot from the bucket, `syncToFs` does `dumpTar` → zstd → PUT snapshot → CAS manifest. Lease wired in from E1.
- `experiments/e2-roundtrip.ts` - create DB, insert rows, close; reopen from bucket cold, verify rows; loop with growing data.

**Probes:**
1. Correctness round-trip at 1MB / 10MB / 100MB / 500MB database sizes.
2. Timings per size: `dumpTar` duration, compressed snapshot size, upload time, cold-start restore time. This produces the v0 performance table for the README and tells us when v1 WAL shipping becomes mandatory rather than nice.
3. `dumpTar` callability (open question 9.3): confirm it can run at `syncToFs` time on a live instance, or document the workaround (walk MemoryFS directly).
4. Crash safety, local: port the kill-mid-commit harness - child process killed with SIGKILL at injected fault points (mid-snapshot-upload, between snapshot and manifest CAS, mid-manifest), parent reopens from bucket and verifies integrity with a checksum table. Every fault point × 20 runs.

**Kill criterion:** any reopen that fails integrity, or `dumpTar` fundamentally unusable mid-session with no workaround.

## E3: PGlite inside Cloud Run (first cloud deploy)

**Code to write:**
- `experiments/e3-service/` - minimal HTTP service (Hono or plain `http`): `POST /sql` runs a statement, `GET /healthz`, `GET /metrics` dumps timing JSON. Dockerfile (node:22-slim). Deployed with `--max-instances=1 --min-instances=0 --concurrency=1`.

**Probes:**
1. Boot path: container start → PGlite ready, split into (a) WASM init, (b) initdb-fresh vs (c) restore-from-bucket. Answers open question 9.5: if initdb blows the startup budget, switch to seeding from a prebuilt empty snapshot (likely the right design anyway).
2. Memory: RSS at idle and under load for each DB size from E2; find the smallest Cloud Run memory tier per size (cost table input).
3. GCS latency from inside the region: repeat E0 probe 5. Expect single-digit ms; this sets the strict-durability commit cost.
4. Scale-to-zero cycle: hit it, wait for idle-kill, hit it again; measure perceived cold-request latency end to end. Repeat 20x for distribution.
5. Strict vs relaxed: per-request commit latency with `relaxedDurability` false vs true (batched flush).

**Kill criterion:** cold start so slow it breaks the "scale to zero, wake on request" story even with a seeded snapshot (e.g. >10s for a 10MB DB), or memory floor making the cheapest tiers unusable.

## E4: Cloud Run lifecycle hazards (the platform-specific unknowns)

These are the experiments that can genuinely surprise us. Cloud Run **throttles CPU to near-zero between requests** unless `--cpu-always-allocated` is set, and gives a SIGTERM + 10s grace on shutdown. Both interact directly with lease heartbeats and relaxed-mode flushing.

**Code to write:**
- Extensions to the E3 service: background heartbeat loop with timestamped logging, SIGTERM handler that flushes pending segments + manifest and releases the lease, fault-injection endpoints (`/hang`, `/abort`, `/pause-heartbeat`).

**Probes:**
1. Heartbeat under CPU throttling (the big one): default throttled CPU, send one request, go idle past the lease TTL, send another. Did the heartbeat fire while idle? Expected: NO under throttling. Then evaluate the three candidate mitigations:
   a. `--cpu-always-allocated` (costs money - measure exactly how much for a min-instances=1 service),
   b. lease TTL >> idle windows + re-validate lease at request start before any commit (lease check becomes part of the request path, zero background work needed),
   c. Cloud Scheduler ping as keepalive (rejected if a+b suffice - smells like an orchestrator).
   The design bet is (b): no background process required at all. This experiment proves whether (b) alone is safe - it should be, since correctness never depends on the heartbeat, only commit availability does.
2. SIGTERM flush: with relaxed durability and pending un-flushed commits, trigger a revision replacement; verify the grace-period flush lands the manifest. Then SIGKILL-style (no grace) via instance crash: verify loss is bounded by the flush interval and the DB restores cleanly.
3. Revision-switch double-instance window: deploy a new revision while the old one is mid-traffic with `--max-instances=1`. Cloud Run runs both briefly. Verify: exactly one holds the lease, the other returns 503 "locked by writer X" (or queues until takeover), and no manifest interleaving occurs. 20 deploy cycles in a loop.
4. True concurrent writers: second Cloud Run service, same bucket prefix. Verify clean rejection. Then force a zombie (pause-heartbeat endpoint on A, wait for expiry, B takes over, unpause A, A tries to commit): assert `FencedError` on A, intact data via B. This is DESIGN.md's failure matrix, live on the real platform.

5. Idle-shutdown vs new-request race (scale-to-zero handoff): let the instance go idle until Cloud Run initiates shutdown, and fire a new request exactly during the SIGTERM grace window (instrument the SIGTERM handler to log + artificially stretch its flush to widen the window). Cloud Run routes the new request to a NEW instance - a dying instance is already out of rotation - so this is a forced lease handoff under load. Verify: (a) the new instance, finding the lease held by the dying one, retries briefly instead of hard-erroring, and acquires it as soon as the SIGTERM handler releases it; (b) the new instance sees the dying instance's final flush - i.e. it must fetch/validate the manifest AFTER lease acquisition, not before. **Known suspect:** the e3-service boot timings report manifestGet before lease, which implies restore-then-acquire ordering; that loses the dying instance's last commit from the new instance's view (correctness-safe due to fencing, but durably-acknowledged data would be invisible until the next boot). Fix is restore-after-acquire or an etag re-check post-acquisition; this probe proves it.

**Kill criterion:** none of (a)/(b)/(c) gives a safe commit path under throttling, or the revision-switch window produces a manifest interleaving. Either would force redesign of the lease lifecycle.

## E5: soak + cost (the "$0.02/month" claim)

**Code to write:**
- `experiments/e5-soak.ts` - traffic generator: realistic long-tail profile (bursts of writes, long idle gaps, scale-to-zero in between) against the E3/E4 service for 72h.
- A GC job invocation (the retention deleter from DESIGN.md 4.6) run at the end.

**Probes:**
1. Zero corruption over 72h with randomized instance kills (deploy loop) mixed in; verify with a continuous checksum table.
2. Actual billed cost: Cloud Run (with the E4-chosen CPU mode) + GCS storage + GCS operations. Operations count matters: every strict commit is ≥2 PUTs (segment-less v0: snapshot + manifest); confirm the math at, say, 1000 writes/day.
3. Bucket growth + GC: snapshots accumulate; run retention GC, verify restorability is preserved (always ≥1 full restorable generation) by restoring after GC.

**Kill criterion:** cost an order of magnitude above the pitch for the canonical tiny app, or any soak corruption.

## Sequencing and effort

| Exp | Where | Depends on | Rough effort |
|---|---|---|---|
| E0 primitives | laptop | - | 0.5-1 day |
| E1 lease | laptop | E0 | 1-2 days |
| E2 ObjectStoreFS v0 | laptop | E1 | 2-4 days |
| E3 Cloud Run basics | cloud | E2 | 1-2 days |
| E4 lifecycle hazards | cloud | E3 | 2-3 days |
| E5 soak + cost | cloud | E4 | 1 day code + 72h wall clock |

E0+E1 are pure-risk-retirement and produce the two foundational packages. E2 produces the actual v0 product. E3-E5 produce the Cloud Run recipe (DESIGN.md 4.7) and the numbers for the README.

## Decisions the experiments must output

1. CI story: fake-gcs-server adequate for generation preconditions, or real-GCS / MinIO split (E0).
2. initdb in-cloud vs prebuilt empty snapshot seed (E3 → likely changes v0 to "create database = pure bucket write").
3. Lease liveness mode on Cloud Run: throttled CPU + request-path lease validation vs `--cpu-always-allocated` (E4.1) - this decides whether the no-orchestrator, no-background-work story holds as-is.
4. The DB-size threshold where v0 tarball-per-commit stops being acceptable and v1 WAL shipping becomes the priority (E2.2 + E3.5 numbers).
5. The real monthly cost figure to put in the README (E5.2).
