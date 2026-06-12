# Cost model: provider-aware write/snapshot policy

Design principle: **zero writes unless something changed, and no full snapshot until restore performance degrades past a budget.** Every upload must justify itself against a per-provider cost table. Eventually each `BlobStore` driver carries a `CostModel` so the policy engine (flush cadence, snapshot threshold, GC aggressiveness, storage class) is computed per cloud, not hardcoded.

Numbers below are from provider pricing pages as last reviewed (2026-06); they drift - each driver should pin them in code with a date and we re-verify per release. Marked per 1,000 operations.

## Provider cost tables

| | GCS Standard | S3 Standard | Cloudflare R2 |
|---|---|---|---|
| Storage /GB-month | ~$0.020 | $0.023 | $0.015 |
| Write ops (PUT/list, Class A) | $0.005 | $0.005 | $0.0045 |
| Read ops (GET, Class B) | $0.0004 | $0.0004 | $0.00036 |
| DELETE | free | free | free |
| Egress to own-cloud compute (same region) | free | free | free |
| Egress to internet | ~$0.12/GB | ~$0.09/GB | **$0 (free)** |
| Free tier (monthly) | 5GB + small ops (always-free) | none durable | **10GB + 1M writes + 10M reads** |
| Conditional write | `ifGenerationMatch`, no surcharge | `If-Match`/`If-None-Match`, no surcharge | etag precondition, no surcharge |

### Limits that shape the design (not just the bill)

- **GCS: ~1 write/second sustained per object name.** The manifest is one object name - strict-mode commit rate is capped at ~1/s before 429s. Above that, commits MUST batch (group N transactions per manifest CAS). This is a correctness-adjacent limit, not a cost knob.
- S3: 3,500 PUT/s per prefix - effectively unreachable for us; no per-object write cap documented, but the manifest CAS serializes us anyway.
- R2: no published hard per-object rate; Workers-side limits dominate.
- Minimum storage durations on cold tiers: S3 IA 30d, GCS Nearline 30d / Coldline 90d - moving short-lived generation garbage to a cold class costs MORE (early-delete fees). Cold classes are only for retained old generations kept ≥ the minimum.

## What things actually cost (worked, at target scale)

Per strict commit (v1 WAL shipping): 1 segment PUT + 1 manifest CAS = 2 write ops ≈ **$0.00001**. At 1,000 writes/day: ~60k ops/month ≈ **$0.30/month** on any provider. Ops are noise.

Storage: a 500MB DB with 2 retained generations ≈ 1GB ≈ **$0.02/month** on R2. This is the pitch number, and it's real.

The dominant *avoidable* costs, in order:
1. **Pointless snapshots** (v0 ships the full DB per commit; a 50MB DB at 1,000 writes/day uploads 50GB/day - bandwidth is free intra-cloud but it burns instance CPU-seconds, which on Cloud Run cost more than the bucket does).
2. **Stale generations not GC'd** (storage is the only line that grows unbounded).
3. **Internet egress on GCS/S3** if clients hydrate from the bucket directly (the CDN-seeded read-replica idea) - free on R2, expensive elsewhere; on GCS/S3 front it with a CDN or accept the per-GB fee.

## Snapshot policy: restore-budget driven, not write driven

Since ops are noise and intra-cloud bandwidth is free, full snapshots are NOT a cost problem - they're a *compute-time* problem (instance CPU for tar/gzip/upload) and a *restore-latency* problem when too rare. So:

- **Trigger compaction on a restore-time budget, not a byte count.** Track `estimatedRestoreMs = snapshotBytes/throughput + segmentCount × perGetOverhead + replayEstimate`. When it exceeds the budget (default: 2× the bare snapshot restore time, i.e. "segments may at most double cold start"), snapshot. The byte/count thresholds in V1-WAL-SHIPPING.md are the v1 approximation of this.
- **Never snapshot on wake** (see V1-WAL-SHIPPING.md) and never on a timer that fires with zero accumulated WAL. Idle databases must converge to literally zero ops: no heartbeat writes while not serving (lease renewal only while actively committing; an expired lease at rest is fine - the next writer takes over by CAS).
- **GC promptly**: deletes are free everywhere. Keep `retainGenerations: 1` beyond current as default.

## Driver interface sketch

```ts
interface CostModel {
  writeOpUsd: number          // per op
  readOpUsd: number
  storageGbMonthUsd: number
  internetEgressGbUsd: number // 0 on R2
  maxWritesPerObjectPerSec?: number  // 1 on GCS — forces commit batching
  freeTier?: { storageGb: number; writeOps: number; readOps: number }
}
interface BlobStore {
  // ...existing get/put/list/delete
  readonly cost: CostModel
}
```

Policy decisions computed from it:
- `minCommitBatchMs = 1000 / maxWritesPerObjectPerSec` (GCS: forces ≥1s batching under sustained writes; S3/R2: 0)
- snapshot cadence from the restore-time budget (above), with storage price scaling the retention knob
- whether the client-hydration/CDN story is on by default (R2: yes; GCS/S3: behind a "this costs egress" flag)
- free-tier awareness for the README cost calculator ("your app: $0.00/month on R2")

## Google Cloud Storage - the first driver we optimize

All figures Standard storage class, single region, as last reviewed 2026-06; pin and re-verify in the driver.

### Price sheet

| item | price | notes |
|---|---|---|
| Storage, Standard | ~$0.020/GB-month | region-dependent ($0.020 us-east1/europe-west1 ballpark) |
| Class A ops (PUT, LIST, **compose**, rewrite, patch) | $0.05 / 10k = $0.005/1k | every segment PUT, manifest CAS, list = Class A |
| Class B ops (GET, getMetadata) | $0.004 / 10k = $0.0004/1k | restore reads, manifest polls |
| DELETE | free | GC costs nothing in ops |
| Egress to same-region Google compute (Cloud Run/GCE/Functions) | free | the whole replication loop is op-cost only |
| Egress to internet | ~$0.12/GB (premium tier) | matters only for client/CDN hydration |
| Always-free tier | 5GB Standard + 5k Class A + 50k Class B /month | **US regions only** (us-east1/us-west1/us-central1) - europe-west1 gets nothing |

Colder classes (Nearline $0.010, Coldline $0.004, Archive $0.0012 /GB-month) carry 30/90/365-day minimums, per-GB retrieval fees, and ~2x Class A prices. Verdict for us: **never** for live generations or short-lived garbage; only for a long-term backup branch (e.g. "keep a monthly snapshot for a year" feature, later).

### Bucket configuration the driver should demand (or set itself)

1. **Disable soft delete.** GCS buckets default to a 7-day soft-delete retention, billed at the storage rate for deleted bytes. Our workload deletes superseded snapshots constantly - with v0 shipping a 50MB snapshot per commit, soft delete would bill ~7 days x every snapshot ever GC'd. This may be the single biggest hidden cost on GCS; turn it off at bucket creation (`softDeletePolicy.retentionDurationSeconds: 0`).
2. **No object versioning** (same reasoning - the manifest IS our versioning).
3. **No Autoclass** (per-object monitoring fee buys nothing; our objects are either hot or garbage).
4. **Single region, same region as the compute.** Dual-region doubles storage cost for an HA property the single-writer design can't use.
5. Region choice: if the user has no latency constraint, default recommendation `us-east1`/`us-central1` to capture the always-free tier; otherwise same-region-as-compute wins (egress-free and lowest latency dominate).

### Limits that bind

- **~1 sustained write/second per object name.** The manifest is one object name → strict-mode sustained commit rate caps at ~1/s before 429/`rateLimitExceeded`. Driver rule: `minCommitBatchMs ≈ 1000`; under burst load, group commits into one manifest CAS (group commit). Retries with backoff on 429 are mandatory anyway (GCS documents this as a soft, burstable limit).
- Per-bucket write ramp: ~1000 writes/s initial, auto-scales. Irrelevant at our scale.
- Conditional writes (`ifGenerationMatch`) carry no surcharge and no special quota - the CAS loop is free beyond the op itself.

### GCS-specific opportunities

- **Server-side `compose`**: GCS can concatenate up to 32 objects into one without downloading them (Class A op, supports `ifGenerationMatch`). This is segment compaction WITHOUT instance CPU or bandwidth: periodically compose N small WAL segment objects into one larger object and swap the manifest's segment list. Restore GET-count drops 32x for one op's price, and no Cloud Run instance needs to be awake to do it. (Compose concatenates raw bytes - works for our segments if compression is per-segment-framed, e.g. concatenated gzip members, which gunzip handles natively.) This softens the snapshot-cadence pressure: compose is the cheap middle tier between "many segments" and "full snapshot," GCS edition of Litestream's compaction levels.
- **Appendable objects / Rapid Storage (zonal)**: Google has been rolling out appendable objects on zonal buckets. If/when generally available in our regions, WAL shipping could append to one open segment object instead of minting many - fewer objects, fewer ops, simpler manifests. Different durability scope (zonal) - investigate before relying on it; flagged as a v2 driver variant, not v1.
- **Manifest polling for read replicas is Class B** ($0.0004/1k): clients polling the manifest every 5s cost ~$0.21/month each on ops - fine; internet egress for the segments they then fetch is the real cost (front with a CDN or Cloudflare in front of GCS, or steer the client-hydration story to R2).

### Worked example: target app on GCS (europe-west1)

100MB DB, 500 writes/day batched into ~200 commits, snapshot/compaction 4x/day, 2 generations retained:
- Ops: 200x2 + 4x2 ≈ 13k Class A/month ≈ $0.065
- Storage: ~0.3GB average ≈ $0.006
- Egress: $0 (Cloud Run same region)
- **Total ≈ $0.07/month** (or ≈ $0.00 in a US free-tier region). Soft delete left on could multiply this several-fold - hence rule 1.

## Other providers (briefer; each gets this treatment when its driver lands)

- **R2**: the cost-optimal home overall. Free egress makes bucket-served read replicas / CDN seeding free; free tier (10GB, 1M writes/mo ≈ 23 commits/min sustained) covers the entire target use case. Pair with the Durable Object tier from DESIGN.md 4.7.
- **S3**: no free tier, highest internet egress; fine intra-AWS (Lambda). No per-object write cap documented (manifest CAS serializes us anyway). S3 also supports multi-object concatenation only via multipart-copy (clunkier than GCS compose). S3 Express One Zone is a separate latency-oriented driver decision later - different pricing (per-GB request fees), single-AZ durability tradeoff.

## Experiment hooks

- E5 (soak + cost) must validate this table against the actual bill: predicted vs billed, line by line.
- Add E5b: GCS manifest CAS at >1/s sustained - confirm the 429 behavior and that batching holds the rate under the cap.

## Status (2026-06-12): measured + what is implemented

**E5b ran.** Sequential CAS against one object name: **2.43/s achieved, 52% of requests answered 429** (`results/e5b.jsonl`). The ~1/s documented cap is real and soft - burstable, but anything sustained above it grinds through rejections. The first v1-WAL-shipping E2c run then hit this organically: incremental commits are ~150ms, so 60 sequential strict writes exceeded the manifest cap and failed with the exact `gcs429` error. v0 could never reach this limit (9s snapshot commits); fixing it became mandatory the moment writes got fast.

Implemented now (the "tweak settings + driver behavior" tier):
- `CostModel` on the `BlobStore` interface; `GcsBlobStore.cost` pins the GCS table with a review date. `maxWritesPerObjectPerSec: 1`.
- **Group-commit pacing in ZeroPG**, derived from the cost model: commits are spaced >=1s apart on GCS; writes arriving inside the window coalesce into the next commit's WAL range (E2c probe 5: 10 concurrent writes -> few CASes). Idle databases pay zero latency - pacing only bites under sustained write load.
- **429/5xx retry with jittered backoff** in the GCS driver. Only clean rejections retry; ambiguous network failures do NOT (a retried-but-already-landed conditional PUT would read as a false FencedError).
- Bucket hygiene verified on our bucket: soft delete OFF, no versioning, no Autoclass, single region. (Soft delete is the headline trap: 7-day retention billed on every deleted byte, and we delete superseded snapshots constantly.)
- Idle = zero ops already holds: no heartbeat at rest, interval-mode flush no-ops when clean, sleep mode uploads only on SIGTERM/idle-backstop.

The v2 worth building (GCS-structural, in order):
1. **`compose`-based segment compaction.** Our WAL segments are stored raw, so GCS server-side compose (32:1, one Class A op, `ifGenerationMatch` support) can fold many small segments into one object with **zero instance CPU/bandwidth, and no instance even awake**. Restore GET-count drops 32x; full-snapshot compaction then triggers on replay-time budget only. This is the cheap middle tier between "many segments" and "full snapshot" - Litestream's compaction levels, GCS edition.
2. **Restore-budget-driven compaction** replacing the fixed 16MB/64-segment thresholds: `estimatedRestoreMs = snapshotBytes/throughput + segments*perGetMs + walBytes/replayRate`, snapshot when it exceeds ~1.5x the bare-snapshot restore. All three constants are now measured (E0, E2c, E3).
3. **Appendable objects (zonal Rapid Storage)**: would collapse segment-per-commit into appends to one open object. Zonal durability caveat; watch, don't build.

Not worth building: manifest sharding to dodge the 1/s cap (group commit is sufficient - single-writer caps useful commit rate anyway), cold storage classes for live generations (minimum-duration + retrieval fees exceed savings at our sizes), op-count micro-optimization (ops are cents/month at target scale; the binding constraints are the per-object write cap, restore latency, and instance CPU-seconds).
