# Thread 8: the SQLite slot (pairs with posts/08-the-sqlite-slot.md)

1/
Every project starts with the same quiet decision:

SQLite now + a painful database migration later, or real Postgres now + a Docker daemon forever.

That trade is gone. The slot SQLite occupies in your workflow can hold actual Postgres.

2/
The SQLite path: one file, no daemon, delete to reset. Lovely.

And the debt: a dialect you'll have to leave, ALTER TABLE that can't drop columns normally, types that are suggestions, and a "migrate to Postgres" ticket filed the day the project turns out to matter.

3/
The "do it properly" path in the Supabase world is `supabase start`:

a dozen-ish containers (Postgres, Kong, GoTrue, PostgREST, Realtime, Storage, studio, logging), gigabytes of first-run image pulls, and a Docker daemon that must be up before you write line one.

It faithfully replicates the cloud stack. That's exactly the problem. You wanted a database.

4/
The third option:

npm install @zeropg/client

A directory on disk plays the SQLite file. Underneath is PGlite: not an emulator, the Postgres source tree compiled to WASM. server_version 18.3, PL/pgSQL, triggers, GIN indexes, advisory locks, LISTEN/NOTIFY.

We know because we ran 880 real app migrations through it.

5/
The SQLite conveniences that matter survive:

- no daemon, no port, no password
- reset = point at a fresh directory
- kill -9 mid-write, reopen, committed rows are there (Postgres WAL recovery, not a promise; we ship the test: 4 rounds, 25/25 rows, every time)

Plus the classic PGlite footgun (hot-reload keeps the old process alive, two writers corrupt the datadir) is locked out.

6/
App expects DATABASE_URL? Add the wire server and psql/node-postgres/Knex/Drizzle/Prisma-runtime connect like it's any other Postgres, on 127.0.0.1.

One gap: Prisma's migrate ENGINE can't drive a single-session DB. `zeropg migrate dev` replays your normal Prisma migration files instead. Schema files unchanged.

7/
Stage 2 is where it becomes a lifecycle, not a dev tool:

the SAME database deploys to a scale-to-zero container. The datadir moves into a GCS bucket. Idle cost: cents of bucket storage. First request cold-starts it in seconds (~3.8s p50 at 10MB, ~11s at 500MB, measured).

Nothing about your app changed. You changed where the bytes sleep.

8/
Supabase-shaped version, live right now, sleeping until you click:

https://supabase-scale-to-zero.0rs.org

PostgREST + GoTrue on the same substrate. Stock supabase-js, unmodified: signup, login, RLS. No realtime, no edge functions (deliberately).

9/
Stage 3, the 1% case: your thing takes off.

The exit is deliberately boring: pg_dump out, restore into managed Supabase/RDS/Cloud SQL, change one connection string.

Verified: row-level checksum-identical restore into stock PostgreSQL 18.4. There was never a format to escape. It was Postgres the whole time.

10/
You'll know it's time from 3 signals:

- awake more than a few hours/day (economics flip)
- DB past ~0.5-4GB (cold starts stop being cute)
- sustained concurrent writes (single-writer WASM serializes; that's a real cluster's job)

These aren't bugs to file. They're the graduation bell.

11/
The trade, stated plainly: single writer, serialized concurrency, preloaded-only extensions (no PostGIS), no realtime.

What you get back: the prototype database and the production database stop being different databases.

SQLite's slot. Postgres's semantics. Every lifecycle step is a connection-string change.

https://github.com/reisepass/zeropg
