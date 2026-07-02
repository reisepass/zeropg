# zeropg: a Postgres that costs zero when nobody's using it

> **SUPERSEDED (2026-07-02).** This early draft predates v1 incremental WAL shipping
> being the headline, the 8-app compatibility campaign, and the cold-start model. The
> current, publishable series lives in [`../content/`](../content/README.md); the
> updated anchor post is [`../content/posts/01-the-idea.md`](../content/posts/01-the-idea.md).
> Kept for the record; some numbers below are v0-era.

*Draft launch post - numbers measured live on Cloud Run + GCS, June 2026.*

Here is a Postgres database with no database server behind it:

> **[zeropg-demo-500mb.run.app](https://zeropg-demo-500mb-71428757273.europe-west1.run.app)** — half a gigabyte of Postgres that, when you click it after it has been idle, wakes from literal zero — no VM, no container, no process — restores itself out of a GCS bucket, and serves you. p50 11.2s, p99 12.3s, measured over 20 forced cold starts. The [10MB](https://zeropg-demo-1mb-71428757273.europe-west1.run.app) and [50MB](https://zeropg-demo-50mb-71428757273.europe-west1.run.app) versions do it in ~3.5s, which is mostly Cloud Run starting the container at all.

While idle it costs the GCS storage bill: about **one cent per month** for the 500MB one, fractions of that for the others.

## The trick

[PGlite](https://pglite.dev) is Postgres compiled to WASM; it runs in-process and is delightful for tests and local dev. The question zeropg answers: what does it take to make *the bucket* the database's durable home, safely, so the compute can scale to zero?

Three things, it turns out:

**1. A streaming snapshot pipeline.** On boot: parallel ranged GETs → gunzip → untar, straight onto `/tmp`, then PGlite opens the directory and faults pages lazily. Peak JS heap for restoring a 500MB database: 23MB. On commit, the same pipeline in reverse, ending in one conditional PUT of a tiny `manifest.json` — and that CAS *is* the commit. Crash before it: old state intact. After it: new state durable. There is no in-between, and the object store is never asked for fsync semantics it doesn't have.

**2. A lease the object store enforces.** Scale-to-zero platforms run two instances during revision switches, keep zombies alive past their welcome, and SIGKILL anything that crash-loops. The single-writer guarantee therefore can't live in the platform; it lives in the bucket: `lease.json` created with if-absent semantics, renewed by CAS, taken over by CAS after TTL expiry, with a fencing token that only goes up. Every commit CASes the manifest; a takeover stamps its token into the manifest immediately, so a zombie's next commit fails instantly. We tested this by deploying a rival service against the same bucket prefix and watching it fence the original, live.

**3. Incremental WAL shipping — and durability as a dial.** Early in the night, a durable write shipped the whole database (7.8 seconds on the 50MB demo). Now a commit ships only the WAL byte range it appended — one immutable object, a few hundred bytes for a one-row insert — and the conditional manifest swap makes it durable: measured live, **WAL scan 1.3ms + upload 79ms + manifest CAS 97ms**. The full snapshot demoted itself to a compaction artifact that doubles as a rolling backup. Two things bit us on the way: Postgres preallocates WAL files at full size and fills them by *overwrite* (so capture must track LSNs, never file sizes — we learned this the hard way), and GCS rate-caps writes to one object name at ~1/s (we measured 52% rejections beyond it), which forced proper group commit: concurrent writes coalesce into one manifest swap, ten-for-one in our tests.

And still, "every write durable before ack" is the wrong default for an app that's idle 95% of the day. The serverless-native mode is `sleep`: writes run at memory speed (~150ms round-trip on the demo, mostly the lease check), and one flush happens when the platform tells the instance to sleep — plus an idle-flush backstop, because Cloud Run only grants 10 seconds of grace after SIGTERM.

## Things the platform taught us

- **Postgres ships its garage.** `max_wal_size` defaults to 1GB and Postgres keeps recycled WAL segments around up to that budget — inside the datadir. Our 500MB database produced 969MB snapshots until we pinned `max_wal_size=64MB, wal_recycle=off` (the settings persist *inside* the snapshot, so every future boot inherits them).
- **Don't gzip what doesn't gzip.** A serverless vCPU deflates at ~12MB/s; the NIC does 100+MB/s. zeropg test-compresses a sample of the largest heap file at snapshot time and ships raw tar when compression wouldn't pay. That single decision took the 500MB cold restore from 13.2s to 9.6s.
- **Exit politely.** Cloud Run rate-limits containers that exit non-zero (429s for tens of seconds — crash-restart backoff). Intentional restarts must exit 0.
- **Boot patiently.** During a revision switch the new instance boots while the old one still holds the lease. Failing the boot is wrong; waiting out the TTL (≤90s) makes deploys seamless.

## Limits, stated plainly

One writer. Database must fit in instance memory. v0 strict writes are slow on big DBs (that's what WAL shipping fixes). And cold starts are real — 3.5s small, ~11s at 500MB — fine for side projects, internal tools, per-tenant DBs, preview envs; wrong for a checkout path.

But when the app outgrows all of this, the exit is `pg_dump | pg_restore` into any managed Postgres. No schema translation, no dialect rewrite. It was Postgres the whole time.

*Everything is experiment-driven: the repo has the E0–E5 harnesses and JSONL evidence for every number in this post.*
