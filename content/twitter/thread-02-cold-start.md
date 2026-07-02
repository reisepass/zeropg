# Thread 2: the cold-start equation (pairs with posts/02-the-cold-start-equation.md)

1/
We ran 13 services on scale-to-zero infra with Postgres restoring from a GCS bucket on every wake, then forced cold starts on all of them.

One equation explains every number:

cold_start ≈ platform_floor (~2s) + DB_restore (1.5-9s by size) + app_boot

Guess which term ruins everything.

2/
The measured table:

bare 10MB Postgres demo: 3.8s
zeropocket (Go, PocketBase-style): 3.5s
cocoon PDS (Go): ~5s
PrivateBin (PHP): ~5s
bare 500MB demo: 11.2s
nostream (Node): ~14.5s
Rallly (Next.js): 21-36s
Documenso (Next.js): ~30s
NocoDB (Node): ~34s
Cal.com (Next.js monorepo): >120s. Dropped.

3/
Read that again: a FULL backend (collections, auth, admin UI, in Go) cold-starts as fast as the bare database demo.

Restoring Postgres itself from a bucket, the "scary" part, costs ~1.5s at 10MB.

A static binary boots in milliseconds. Its cold start IS the restore.

4/
Meanwhile the same database under NocoDB waits ~29 seconds for Node to initialize itself.

"Scale-to-zero can't work, cold starts" is aimed at the wrong layer. The database contributes seconds, scaling with DATA size. The framework contributes tens of seconds, scaling with hype.

5/
Corollary: picking a runtime is now picking a cold-start budget.

Always-on servers let framework boot time hide at deploy time. Scale-to-zero makes it a per-user-visible latency.

Go/Rust: near free. Node: ~10-15s. Next.js monorepo: eviction.

6/
Bonus finding: sidecars are free. We A/B'd a Redis sidecar (Dragonfly vs valkey) on the same app: 14.5s vs 15.0s cold. A wash.

Containers boot in parallel; Redis is ready in <1s while the DB restore is still streaming. Add the cache, skip the guilt.

7/
Measurement traps that wasted our rounds:

- public URLs never truly idle: crawlers keep re-warming them. Classify cold/warm from platform boot logs, not the clock
- every probe resets the ~15min idle reaper; clean reps need 20-25min hands-off

8/
Best case: our AT Protocol PDS can't be cold-measured anymore AT ALL, because real Bluesky network traffic keeps it permanently warm.

A service with any organic traffic rarely cold-starts in practice. The problem partially deletes itself.

9/
Takeaway: the stack for scale-to-zero-with-a-database is a fast-booting binary + state that restores in O(data).

We assumed the serverless database would be the hard part. After 13 services: the database was the easy part. The 30-second cold starts came from the JavaScript.

Data + method: https://github.com/reisepass/zeropg/blob/main/docs/COLDSTART-MODEL.md
