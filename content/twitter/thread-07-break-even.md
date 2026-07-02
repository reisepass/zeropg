# Thread 7: the break-even math (pairs with posts/07-the-break-even-math.md)

1/
When is a scale-to-zero Postgres actually cheaper than the smallest managed instance, and when is it a trap?

The napkin math has a counterintuitive punchline: it's request SPACING, not request COUNT, that bills you.

2/
Monthly cost:

C = storage + bucket_ops + compute_while_awake

Instinct says model by data size and query count. Both instincts are wrong, and the ways they're wrong decide who should use this architecture.

3/
Storage never matters: buckets are ~$0.02/GB-month, ~10x cheaper than the SSD under the smallest Cloud SQL. Our live 500MB demo idles at about ONE CENT per month.

Ops almost never matter: an incremental commit is 2 Class A ops, ~$0.00001. The bucket's own rate cap stops you before the bill does.

The whole model collapses to one variable: hours awake per month.

4/
A 1 vCPU Cloud Run instance: ~$0.10/hour while running. Cheapest practical managed Postgres: ~$9-11/month.

Divide: break-even at ~100-110 awake-hours/month, call it 3.5 hours/day (closer to 5 after the free tier).

Idle 80%+ of the day: 5-20x cheaper. Awake most of the day: you're paying serverless premium for an always-on server. Switch.

5/
Now the trap, the most important sentence in the thread:

The platform bills instance-ALIVE time, and every request restarts the ~15-minute idle timer.

96 requests in one burst: awake ~15 min + the burst. Pennies.
The same 96 requests spaced every 15.1 minutes: the instance NEVER sleeps. 24/7 prices for 96 requests.

6/
Corollaries people learn the expensive way:

- a cron that pings your app "to keep it healthy" every 10 min converts it into the most expensive always-on Postgres you can buy
- a sensor writing one row every 5 min: permanent wakefulness. The same rows batched every 2 hours: ~12 short sessions a day

7/
The decision table:

internal tool, business-hours bursts: wins big (often 10-20x)
side project, a few sessions/day: wins big
per-tenant DBs, most tenants dormant: the killer case, dormant tenants cost cents
preview/staging envs: wins, they idle ~100%
steady 24/7 trickle: LOSES. The trickle defeats scale-to-zero
>4-5 busy hours/day: loses on compute, go managed
>~0.5GB data: graduate regardless of cost

8/
Note what's NOT in the winning column: anything latency-critical. Cold starts are seconds. That's a product decision, not a cost one, and it filters out checkout paths no matter what the bill says.

9/
What makes the math safe to act on: the exit is boring.

It's real Postgres the whole time, so when you cross the line in the table, graduation is pg_dump, restore into any managed Postgres, change one connection string. The cost model is a dial you can re-decide, not an architecture you married.

10/
Full worked model with provider price tables: https://github.com/reisepass/zeropg/blob/main/BREAK-EVEN.md

Fairness caveat: the constants (restore throughput, commit latency, rate caps) are measured; the bill reconciliation against a 72h realistic soak is the next experiment on the list.
