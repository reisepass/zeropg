# E5 - the 72h soak + real-bill reconciliation (runbook)

The last pending scoreboard row (STATUS.md / EXPERIMENTS.md E5): run realistic
long-tail traffic against a scale-to-zero zeropg service for 72h+, prove zero
corruption with kills mixed in, then reconcile [COST-MODEL.md](../COST-MODEL.md)
and [BREAK-EVEN.md](../BREAK-EVEN.md) line-by-line against the actual bill.

## Topology (deployed by `scripts/deploy-e5-soak.sh`)

| piece | name | why |
|---|---|---|
| soak target | Cloud Run service `zeropg-e5-soak` (e3-service image, `sleep` durability, 1 vCPU / 1Gi / cpu-boost, label `purpose=e5-soak`) | identical knobs to the public demos, but NO public promotion, so the only traffic is the driver's - the bill is attributable |
| soak DB | `gs://zeropg-e5-soak-euw1` prefix `e5/soak` (dedicated bucket, label `purpose=e5-soak`) | storage + operations bill lines isolated from the shared demo bucket |
| driver | Cloud Run job `e5-soak-burst` (`experiments/e5-soak/burst.mjs`) triggered by Cloud Scheduler every 20 min | each execution = one slot; decides deterministically from the slot number whether it carries traffic |

## Traffic profile (deterministic, reproducible)

- EU business hours (05-20 UTC): 20% of 20-min slots carry a burst; night: 3.5%.
  Expected ~9-10 bursts/day, most gaps long enough for a real scale-to-zero,
  occasional adjacent slots keep the instance warm (realistic).
- A burst: 15-120 writes (~90% `/sql` INSERTs, ~10% `/notes` form posts) with
  50-800ms think-time, riding sleep-mode memory acks; then an explicit
  `/flush` (the durable watermark), a meta commit, and a second flush.
- Kill mix per burst: 70% natural idle reap, 20% clean `POST /sleep`,
  10% hard `/_fault/abort` (exit 137) - always after the watermark flush, so
  expected durable loss is zero (E4 P2b already proved the bounded-loss case).

## Continuous integrity (E5 probe 1)

Every burst starts by verifying, BEFORE it writes anything:

1. per-row `md5(payload)` recomputed server-side == stored md5 (corruption);
2. `count(e5_rows)` >= the durable watermark committed by the previous burst
   (acked-durable writes may never disappear).

A violation logs `INTEGRITY-VIOLATION` (Cloud Logging + the in-DB `e5_bursts`
ledger) and exits non-zero. The whole burst history lives in `e5_bursts` inside
the database itself, so it rides the durability machinery it is testing.

## Cost reconciliation (E5 probe 2)

Start: **2026-07-03** (scheduler enabled). Let it run >= 72h; longer is better
(a full billing week smooths the daily granularity of exported billing data).

1. **Predicted**, from COST-MODEL.md constants: bursts/day x awake-window
   (~15min idle timer + burst length) x 1 vCPU Cloud Run rate, + 2 Class A ops
   per commit x ~3 commits/burst, + <100MB storage. Write the prediction down
   BEFORE looking at the bill.
2. **Measured usage**, independent of billing lag:
   - awake time: Cloud Monitoring metric
     `run.googleapis.com/container/billable_instance_time`, filter
     `service_name=zeropg-e5-soak`
   - GCS ops: `storage.googleapis.com/api/request_count` filter
     `bucket_name=zeropg-e5-soak-euw1`, grouped by method (Class A = writes)
   - commit/burst counts: `SELECT count(*), min(at), max(at) FROM e5_bursts`
     and slot reports in Cloud Logging (`resource.labels.job_name=e5-soak-burst`)
3. **Billed**, once the export catches up (1-2 days lag): Billing console →
   report filtered by label `purpose=e5-soak` (bucket + service both carry it);
   the driver job is labeled `purpose=e5-soak-driver` so its own cost stays a
   separate line (it is overhead of the experiment, not of the architecture).
4. Reconcile the three; update COST-MODEL.md + BREAK-EVEN.md + the README
   scoreboard row (E5: pending → passed/failed with numbers), and drop the
   "still pending" caveat in `content/posts/07-the-break-even-math.md`.

## Bucket growth + GC (E5 probe 3)

At the end of the soak: record bucket size, run `tsx scripts/gc.ts` against the
prefix, then verify restorability (open the DB read-only or run one more burst)
- retention must always leave >= 1 fully restorable generation.

## Notes / decisions

- **A2 (numbered manifests) not required first:** TODO.md suggests doing A2
  before E5 because a soak could fight the ~1/s per-object-name manifest CAS
  cap. This profile can't: bursts ack from memory (sleep mode) and each burst
  performs ~3 spaced manifest CASes total. The cap only bites sustained strict
  commit streams, which is E5b's already-measured territory.
- **No deploys to the target during the soak** - revision rolls were E4 P3's
  territory; the soak keeps a stable revision so the bill is interpretable.
- The driver never randomizes: everything derives from the slot number, so the
  whole 72h is replayable from the schedule alone.
- Teardown: `gcloud scheduler jobs delete e5-soak-burst --location europe-west1`
  (the service then sleeps forever at ~bucket-only idle cost; delete the service
  + bucket after the bill reconciles).
