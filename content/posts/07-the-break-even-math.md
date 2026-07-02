# The break-even math: it's request spacing, not request count, that bills

*When is a scale-to-zero Postgres actually cheaper than the smallest managed instance,
and when is it a trap? The napkin math, with the traps marked.*

[zeropg](https://github.com/reisepass/zeropg) runs real Postgres on scale-to-zero
compute with the database living in an object-storage bucket. The monthly cost is:

```
C = storage + bucket_ops + compute_while_awake
```

The instinct is to model this by data size and query count. Both instincts are wrong,
and the ways they are wrong decide who should use this architecture.

## Storage never matters, ops almost never do

Object storage is ~$0.02/GB-month, roughly 10x cheaper than the SSD under the smallest
Cloud SQL instance. You would need 500GB before storage alone hits $10/month, and a
database that size doesn't fit this architecture anyway (the working ceiling is ~0.5GB).
Idle cost for our live 500MB demo: about **one cent per month**.

Ops: an incremental commit costs 2 Class A operations, ~$0.00001. You would need a
million commits a month for ops to reach $10, and the bucket's own rate limit (GCS caps
writes per object name at ~1/s) stops you before the bill does.

So the entire cost model collapses to one variable: **hours awake per month.**

## Awake time is the whole game (and the trap)

A 1 vCPU Cloud Run instance costs ~$0.10/hour while running. The cheapest practical
managed Postgres on the same cloud is ~$9-11/month. Divide: break-even sits at
**~100-110 awake-hours/month, call it 3.5 hours/day** (closer to 5 after Cloud Run's
free tier). Idle 80%+ of the day: 5-20x cheaper than managed. Awake most of the day:
you are paying serverless premium for an always-on server, switch.

Here's the trap, and it is the most important sentence in this post: **the platform
bills instance-alive time, and every request restarts the ~15-minute idle timer.**

- 96 requests/day in one burst: awake ~15 minutes + the burst. Pennies.
- The same 96 requests spaced evenly every 15.1 minutes: the instance never sleeps.
  You pay 24/7 prices for 96 requests, without always-on performance.

It is request *spacing*, not request *count*, that bills. A cron job that pings your
app "to keep it healthy" every 10 minutes converts your scale-to-zero database into the
most expensive always-on Postgres you can buy. The same applies to writes: a sensor
writing one row every 5 minutes forces permanent wakefulness; the same rows batched
every 2 hours cost ~12 short sessions a day.

## The decision table

| workload shape | verdict |
|---|---|
| internal tool, business-hours bursts | scale-to-zero wins big (often 10-20x) |
| side project, a few sessions/day | wins big; idle cost ≈ bucket only |
| per-tenant DB, most tenants dormant | the killer case: dormant tenants cost cents |
| preview/staging environments | wins; they idle ~100% of the time |
| steady trickle of traffic, 24/7 | **loses.** The trickle defeats scale-to-zero |
| >4-5 busy hours/day | loses on compute; go managed |
| >~0.5GB data | graduate regardless of cost (cold start ~11s and growing) |

Note what's NOT in the winning column: anything latency-critical. Cold starts are
seconds. That's a product decision, not a cost one, and it filters out checkout paths
no matter what the bill says.

## The part that makes the math safe to act on

Cost math like this usually comes with lock-in risk: if the numbers change, you are
stuck re-platforming. The zeropg design position is that the exit has to be boring for
the entry to be rational: it is real Postgres (PGlite, Postgres compiled to WASM), so
when your app crosses the line in the table above, graduation is `pg_dump`, restore
into any managed Postgres, change one connection string. The two phases run the same
database; the cost model is a dial you can re-decide, not an architecture you married.

Full worked model, with the provider price tables and the simulation inputs:
[BREAK-EVEN.md](https://github.com/reisepass/zeropg/blob/main/BREAK-EVEN.md). One
caveat for fairness: the constants (restore throughput, commit latency, rate caps) are
measured; the monthly bill reconciliation against a 72h realistic soak is still pending
and is the next experiment on the list.
