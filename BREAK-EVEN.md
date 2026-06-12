# Break-even: when does zeropg cost MORE than a small always-on Postgres?

Question: ignoring performance entirely, at what usage level (ops, DB size, or - the real driver - awake time) does zeropg-on-object-storage become more expensive than the smallest managed Postgres on the same cloud?

All prices: cheapest practical tiers, on-demand, as last reviewed 2026-06 - they drift, re-verify before quoting. The mini-simulation at the end is the thing to actually run; the napkin math here picks the model.

## 1. The cost model (why "ops and GB" is the wrong axis)

A zeropg month costs:

```
C = storage + bucket_ops + compute_awake
  = GB·s_rate  +  commits·2·op_rate  +  H_awake·instance_rate
```

Worked at target scale (GCS, 1vCPU/1GiB Cloud Run):

| term | unit cost | needed to reach $10/mo ALONE |
|---|---|---|
| storage | $0.02/GB-mo | 500 GB (won't fit in memory anyway) |
| bucket ops (v1: 2 Class A/commit) | ~$0.00001/commit | ~1M commits/mo ≈ 23/min sustained (GCS manifest cap ~1/s ≈ 2.6M/mo ceiling → ops max out near ~$26/mo) |
| compute while awake | ~$0.095/hr | ~105 hr/mo ≈ 3.5 hr/day |

So: **storage never drives break-even** (object storage is ~10x cheaper per GB than Cloud SQL's minimum SSD), **ops almost never do** (you hit the GCS rate cap before ops cost matters), and **awake compute dominates everything**. But sustained writes FORCE awake time - that's the coupling: a write every <15min keeps the instance alive 24/7. The break-even question reduces to: *how many hours per month is the instance awake?*

## 2. Modeling the start/stop mechanism

While alive, everything is in-memory: requests cost no bucket reads, commits cost 2 ops. The billable quantity is instance-alive time, which the platform determines:

```
H_awake = Σ_sessions (session_length + idle_timeout)        [capped at 730 hr/mo]
```

- A "session" = a burst of traffic with gaps < idle_timeout (Cloud Run reaps after ~15 min idle; configurable down to ~5 min with min-instances=0).
- Pathological worst case: 1 tiny request every 15.1 minutes = 96 sessions/day x 15 min = 24h awake = always-on prices WITHOUT always-on benefits. The model must include this: **it's request spacing, not request count, that bills**.
- Each wake also burns one cold start of CPU (2-11s) + one restore's worth of Class B reads: ~$0.0003/wake - negligible below hundreds of wakes/day.
- Each sleep (in `sleep` durability mode) burns one snapshot/flush: 1-2 Class A + CPU seconds - also negligible.

So the simulation inputs are: `sessions_per_day`, `avg_session_minutes`, `idle_timeout`, `db_size` (→ memory tier), `commits_per_day` (→ ops + forced awake floor), and the provider price table.

## 3. Google Cloud: zeropg (GCS + Cloud Run) vs cheapest Cloud SQL

Baseline: Cloud SQL Postgres, smallest practical (shared-core db-f1-micro class, ~0.6GB RAM) ≈ **$9-11/month** including 10GB SSD (us/eu region, on-demand). (Enterprise edition micro ≈ $0.011-0.015/hr + $0.17/GB-mo storage.)

zeropg instance rates (Cloud Run request-based billing, tier-1 region): ~$0.0864/vCPU-hr + $0.009/GiB-hr:

| DB size | tier needed (E3b data) | $/awake-hr | break-even awake | as hr/day |
|---|---|---|---|---|
| ≤50 MB | 1 vCPU / 512MiB-1GiB | ~$0.091-0.095 | ~110 hr/mo | **~3.6 hr/day** |
| ~500 MB | 1 vCPU / 2GiB | ~$0.104 | ~100 hr/mo | **~3.3 hr/day** |
| ~1.5 GB | 1 vCPU / 4GiB | ~$0.122 | ~86 hr/mo | ~2.9 hr/day (vs a $9 micro that can't actually hold 1.5GB working set well - fairer baseline is the next Cloud SQL tier ~$25-30/mo → ~7 hr/day) |

Adjustments:
- **Cloud Run free tier** (180k vCPU-s + 360k GiB-s/mo ≈ 50 vCPU-hr): adds ~1.6 hr/day of free awake time → realistic break-even **~5 hr/day** for small DBs.
- **Write-rate ceiling**: commits spaced < idle_timeout keep it awake. Break-even in write terms: writes spread evenly across > ~5 awake-hours/day of activity → Cloud SQL wins; the same total writes in 1-2 daily bursts → zeropg wins by 5-10x.
- **DB-size ceiling**: independent of cost, ~2-4GB is where cold starts (E3: 11s @ 500MB, scaling roughly linearly) and memory tiers make migration sensible. Cost break-even rarely binds before the size/latency one does.

**GCP rule of thumb: zeropg wins below ~4-5 awake-hours/day (after free tier) or ~150k evenly-spaced writes/month; an app idle 80%+ of the day is 5-20x cheaper on zeropg.**

## 4. AWS: zeropg (S3 + Lambda or Fargate) vs cheapest RDS

Baseline: RDS Postgres db.t4g.micro ≈ $11.7/mo + 20GB gp3 ≈ $2.6 → **~$14.3/month** (single-AZ, on-demand).

The right comparison is **S3 + Fargate (ECS) scale-to-zero** - the same shape as Cloud Run: a container that's billed while running and stopped when idle. (Lambda's freeze-between-invocations model is a different compute product with its own semantics; noted at the end only as a curiosity.)

Fargate rates: $0.04048/vCPU-hr + $0.004445/GB-hr, billable in 0.25 vCPU / 0.5GB steps - much finer floors than Cloud Run's practical tiers:

| DB size | Fargate task | $/awake-hr | break-even vs $14.3 RDS | as hr/day |
|---|---|---|---|---|
| ≤50 MB | 0.25 vCPU / 1GB | ~$0.0146 | 980 hr/mo > 730 → **never** (always-on ≈ $10.7/mo, still under RDS) | - |
| ~500 MB | 0.25 vCPU / 2GB | ~$0.0190 | 752 hr/mo ≈ **never** (always-on ≈ $13.9/mo ≈ RDS) | ~24 hr/day |
| ~1.5 GB | 0.5 vCPU / 4GB | ~$0.0380 | ~375 hr/mo | **~12.5 hr/day** |

The striking result: **the smallest Fargate task running 24/7 is still cheaper than the smallest RDS** - AWS prices tiny container slices low and its managed-Postgres floor high, so for small DBs the cost crossover effectively doesn't exist; you migrate for size/latency/throughput reasons, not price. (Caveat: 0.25 vCPU makes cold starts ~4x slower than the 1 vCPU E3 numbers; that's a latency choice, not a cost one.)

Two operational caveats, stated plainly:

- **ECS/Fargate has no native request-driven scale-from-zero.** Cloud Run wakes on the request; ECS needs a waker (ALB + a tiny Lambda/API Gateway trigger that sets desiredCount=1, or App Runner as the managed alternative - though App Runner charges for provisioned memory while idle, ~$0.007/GB-hr, weakening the scale-to-zero story). This is an orchestration wrinkle the GCP path doesn't have, and it slightly dilutes the "no orchestrator" pitch on AWS - the waker is dumb glue, not a coordinator, but it's a moving part. The driver docs must ship the recipe.
- Lambda footnote: frozen containers bill nothing between invocations, so S3+Lambda is even cheaper for spiky traffic - but the 15-min duration cap, freeze semantics around the lease (re-validate on thaw), and packaging constraints make it a separate, later target, not the default AWS story.

**AWS rule of thumb: below ~1GB of database, zeropg on Fargate is cheaper than RDS even running 24/7 - the migration trigger on AWS is size or sustained throughput, never the bill.**

## 5. Azure: zeropg (Blob Storage + Container Apps) vs cheapest Azure Database for PostgreSQL

Baseline: Flexible Server Burstable B1ms (1 vCPU, 2GB) ≈ $12.4/mo + 32GB storage ≈ $3.7 → **~$16/month**.

zeropg: Blob Storage (Hot LRS ~$0.018/GB-mo, write ops ~$0.065/10k = $0.0065/1k - the priciest writes of the three, still noise) + Container Apps consumption plan (~$0.000024/vCPU-s + $0.000003/GiB-s active ≈ **$0.10/hr** at 1vCPU/2GiB, minus a meaningful monthly free grant: 180k vCPU-s + 360k GiB-s, like GCP's).

Break-even: 16/0.10 ≈ 160 hr/mo ≈ **~5.3 hr/day** (≈ 6.9 hr/day counting the free grant). Same shape as GCP, slightly friendlier because Azure's managed-Postgres floor is higher. Caveat to verify in the driver: Container Apps' conditional-write support comes via Blob's etag preconditions (`If-Match`/`If-None-Match`) - fully equivalent to GCS generations; Azure also has unique append blobs worth a look for WAL (the appendable-object idea GCS is only now rolling out).

## 6. The summary table

| cloud | always-on baseline | zeropg awake-cost | break-even (after free tiers) | practical meaning |
|---|---|---|---|---|
| GCP | Cloud SQL micro ~$10/mo | ~$0.10/hr | **~4-5 awake-hr/day** | internal tools, side projects, per-tenant DBs: zeropg. Steady all-day traffic: Cloud SQL |
| AWS | RDS t4g.micro ~$14/mo | Fargate ~$0.015-0.019/hr (small tasks) | **cost: ~never below ~1GB DB** (smallest task 24/7 ≈ $10.7/mo < RDS) | migrate on size/throughput, never the bill; needs a scale-from-zero waker (no native one in ECS) |
| Azure | Flexible B1ms ~$16/mo | ~$0.10/hr | **~5-7 awake-hr/day** | same shape as GCP, higher baseline floor |

Secondary ceilings that bind before cost does:
- **DB size**: ≳2-4GB → cold start (≈ linear, ~22s/GB measured) and memory tiers argue for migration regardless of $.
- **Sustained write spacing**: writes every <15 min around the clock = 24h awake = $70/mo on GCP → migrate (or drop idle_timeout, or accept it).
- **GCS 1 write/s manifest cap**: a hard throughput ceiling strict mode can't exceed; sustained >1 commit/s is a migration signal on GCP irrespective of price.

## 7. Mini-simulation (to build: `scripts/breakeven.ts`)

Inputs: `{ provider, dbGb, commitsPerDay, sessionsPerDay, sessionMinutes, idleTimeoutMin, durability }`.

1. Derive awake hours: `min(730, sessions·(len+idle)·30/60)`; add forced-awake floor from commit spacing (commits modeled as Poisson within sessions vs evenly spread - expose both).
2. Memory tier from dbGb (E3b table). Cold starts/month = sessions·30; add restore Class B ops + cold-start CPU seconds; sleep-mode flush ops per session.
3. Price both stacks from the provider's `CostModel` (extended with `computePerVcpuHr`, `computePerGibHr`, `freeComputeGrant`, `managedPgFloorUsd`).
4. Output: monthly $ for zeropg vs managed PG, the binding constraint (cost / size / write-rate), and the crossover surface (sweep sessionsPerDay x dbGb, print the frontier).
5. Calibrate against the E5 soak's real bill, then put the calculator in the README ("your app: $0.31/mo on zeropg, crossover at 14k requests/day").

The punchline the math keeps producing: **you don't outgrow zeropg by writing too much data or too many rows - you outgrow it by being awake too much of the day.** Which is exactly the migration story the SDK's env-var switch was designed for (DESIGN.md §5).
