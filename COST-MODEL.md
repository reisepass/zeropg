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

## Per-provider strategy notes

- **R2**: the cost-optimal home. Free egress makes bucket-served read replicas / CDN seeding free; free tier covers the entire target use case (10GB, 1M writes/mo ≈ 23 commits/min sustained). Pair with the Durable Object tier from DESIGN.md 4.7.
- **GCS**: the 1 write/s/object manifest cap is the binding constraint - the driver must enforce commit batching at sustained load. Otherwise cheap; always-free tier covers small DBs.
- **S3**: no free tier, highest egress; fine intra-AWS (Lambda). S3 Express One Zone is a separate, latency-oriented driver decision later - different pricing (per-GB request fees), single-AZ durability tradeoff.

## Experiment hooks

- E5 (soak + cost) must validate this table against the actual bill: predicted vs billed, line by line.
- Add E5b: GCS manifest CAS at >1/s sustained - confirm the 429 behavior and that batching holds the rate under the cap.
