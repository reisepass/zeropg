# Thread 1: the idea (pairs with posts/01-the-idea.md)

1/
Here's a 500MB Postgres database with no server behind it.

When you click this after it's been idle: no VM, no container, no process exists. It wakes from zero, restores itself out of a GCS bucket, and serves you in ~11s. Small DBs do it in ~3.5s.

Idle cost: about 1 cent/month.
https://zeropg-demo-500mb-71428757273.europe-west1.run.app

2/
The idea I've spent months testing:

You can have REAL Postgres with zero idle cost today, if you accept migrating to a normal Postgres later.

And migrating later is boring, because it was real Postgres the whole time. pg_dump | pg_restore. One connection string change.

3/
How: PGlite (Postgres compiled to WASM, reports server_version 18.3) runs in-process on scale-to-zero compute. The database's durable home is a plain object-storage bucket.

Think: Litestream, but for Postgres.

4/
"But buckets can't be a database's home safely."

They can, with exactly one primitive: the conditional PUT.

Commit = CAS of a tiny manifest.json. Crash before it: old state intact. After: durable. Torn states are impossible by construction. We SIGKILLed every fault point x20 to check.

5/
"But scale-to-zero platforms run 2 instances during deploys, keep zombies alive..."

Yes. So the single-writer lease lives in the bucket too, with fencing tokens that only go up. A zombie's next commit physically can't land.

We deployed a rival service against the same bucket and watched it fence the original. Live.

6/
Does anything real run on it? Unmodified?

PrivateBin, NocoDB, Rallly, Documenso, and a Bluesky-compatible AT Protocol PDS. Official images, zero source patches, 880 real migrations. All live, all scale-to-zero, DB in a bucket.

The PDS cold starts in ~5s: https://pds-scale-to-zero.0rs.org

7/
The economics: compute-while-awake is the only real cost. Break-even vs the cheapest managed Postgres is ~4-5 awake hours/day.

An app that's idle 80%+ of the day (side projects, internal tools, per-tenant DBs, preview envs): 5-20x cheaper.

8/
The real thesis is social, not technical:

People default to SQLite because Postgres means a server. People fear clever databases because the exit is expensive.

Low floor (cents/month, your own bucket) + cheap exit (pg_dump) = you can pick Postgres on day one for free.

9/
It's a research project, not a product. Working code, live demos, and a JSONL of evidence for every number (crash matrices, fencing runs, cold-start distributions, backup disaster matrix). MIT licensed. Steal any part.

https://github.com/reisepass/zeropg

What I want is for this to become table stakes: serverless should include the database, and zero should mean zero.
