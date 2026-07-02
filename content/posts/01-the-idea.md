# A Postgres that costs zero when nobody's using it

*The zeropg research project, and the idea it exists to spread.*

Here is a half-gigabyte Postgres database with no server behind it:
[zeropg-demo-500mb](https://zeropg-demo-500mb-71428757273.europe-west1.run.app).
When you click that link after it has been idle, there is no VM, no container, no
process. The instance wakes from literal zero, streams the database out of a Google
Cloud Storage bucket, opens it, and serves you. Measured over 20 forced cold starts:
11.2s median. The [10MB](https://zeropg-demo-1mb-71428757273.europe-west1.run.app) and
[50MB](https://zeropg-demo-50mb-71428757273.europe-west1.run.app) versions do it in
about 3.5s, which is mostly Cloud Run starting a container at all.

While idle, it costs the bucket bill. For the 500MB one, about a cent per month.

## The default-database problem

Most new projects pick SQLite, and not because they prefer its dialect. They pick it
because Postgres means a server, a server means a bill, and a bill feels absurd for a
thing with four users. The cost of that choice arrives later: the day the project grows,
you translate away SQLite's types, its dialect, its single-file model.

I spent the last months testing a different answer, and the result is
[zeropg](https://github.com/reisepass/zeropg), a research project with one message:

**You can have real Postgres with zero idle cost today, if you accept migrating to a
normal Postgres later. And that migration is boring, because it was real Postgres the
whole time.**

Not "Postgres-compatible." Not a dialect. [PGlite](https://pglite.dev) is Postgres
compiled to WASM (it reports `server_version` 18.3), running in-process on scale-to-zero
compute, with the database's durable home being a plain object-storage bucket.

## What it took (the short version)

Three things make the bucket a safe home for a database:

1. **A streaming pipeline.** On boot: parallel ranged GETs, gunzip, untar, straight
   onto `/tmp`; a 500MB database restores with 23MB of JS heap. On commit, the reverse.
2. **A commit that is one conditional PUT.** Every commit ends with a
   compare-and-swap of a tiny `manifest.json`. Crash before it: old state intact. After
   it: new state durable. There is no in-between, so torn states are impossible by
   construction.
3. **A lease the bucket itself enforces.** Scale-to-zero platforms run two instances
   during deploys and keep zombies alive past their welcome. So the single-writer
   guarantee lives in the bucket: a lease object with fencing tokens that only go up. We
   deployed a rival service against the same bucket and watched it fence the original,
   live.

Writes are incremental WAL shipping, the trick Litestream made famous for SQLite, done
for Postgres: a one-row insert ships a few hundred bytes, and a durable commit takes
about 200ms end to end. Think "Litestream, but for Postgres."

## Does anything real run on it?

Yes, unmodified. PrivateBin, NocoDB, Rallly, Documenso, and a Bluesky-compatible AT
Protocol PDS all run against zeropg with only a Docker/config change: swap the
`postgres:` service for a sidecar, point `DATABASE_URL` at localhost. 880 real
migrations applied. All live, all scaling to zero, all with the database in a bucket:
the [PDS](https://pds-scale-to-zero.0rs.org) cold-starts in ~5 seconds,
[PrivateBin](https://privatebin-scale-to-zero.0rs.org) in ~5, and a small Go backend we
wrote as a stress test measured ~3.5s, the same as the bare database demo.

## The part that makes it safe to recommend: the exit

Here is the actual thesis, and it is as much social as technical. The reason people
tolerate SQLite's limits is that its floor is so low. The reason people fear "clever"
databases is that the exit is expensive. zeropg's design goal was a low floor AND a
cheap exit:

- **Floor:** cents per month idle, one sidecar container, your own bucket.
- **Ceiling:** roughly 0.5GB of data, one writer, cold starts of a few seconds. Real
  limits, documented, measured.
- **Exit:** `pg_dump | pg_restore` into any managed Postgres, then change one connection
  string. No schema translation, no dialect rewrite, no data model surgery.

You are not betting your project on a research database. You are renting its economics
while you are small, with a pre-paid exit the day you are not.

The break-even math says the crossover is around 4-5 awake-hours per day: below that, a
scale-to-zero Postgres is 5-20x cheaper than the smallest managed instance. Above it,
or past ~0.5GB, graduate. The point is that both phases run the same database.

## It is a research project, on purpose

zeropg is not a product and I am not selling anything. It is working code, live demos,
and a JSONL of evidence for every number in this post (the repo's `results/` directory:
crash matrices with SIGKILL at every commit fault point, zombie-fencing runs, cold-start
distributions, a disaster matrix for the backup system). The code is MIT; steal any part.

What I want is for the idea to become table stakes: **serverless should include the
database, zero should mean zero, and choosing Postgres on day one should cost nothing.**

Repo: https://github.com/reisepass/zeropg
