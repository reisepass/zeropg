# The SQLite slot

*Every project starts with the same quiet decision: SQLite now and a database
migration later, or real Postgres now and a Docker daemon forever. That
trade is gone. The slot SQLite occupies in your workflow can hold actual
Postgres, and the same database then moves laptop to free tier to managed
without a rewrite at any step.*

## The decision you make before line one

You know the ritual. It's a weekend project, so you reach for SQLite: one
file, no daemon, no config, delete the file to reset. And you accept the
debt that comes with it: a SQL dialect you'll have to leave, `ALTER TABLE`
that can't drop a column the normal way, types that are more suggestion
than schema, and a looming "migrate to Postgres" ticket that gets filed the
day the project turns out to matter.

Or you do it properly from day one and run the real thing locally. In the
Supabase world that's `supabase start`: a faithful replica of the cloud
stack on your machine, which is exactly its problem as a dev database. It's
a dozen-ish containers (Postgres, Kong, GoTrue, PostgREST, Realtime,
Storage, a studio, a logging pipeline), gigabytes of images on first pull,
and a Docker daemon that has to be up before you can write line one. It
replicates production faithfully because that's the design goal. But most
of the time what you wanted was a database.

[zeropg](https://github.com/reisepass/zeropg) is our research project on the
third option: take the SQLite slot, put Postgres in it.

## Stage 1: the laptop, no daemon

```sh
npm install @zeropg/client
```

```js
import { connect } from '@zeropg/client'

const db = await connect('file://./data/dev-db')
await db.exec('create table todos (id serial primary key, title text)')
```

That's the whole setup. A directory on disk plays the role of the SQLite
file. Underneath it is PGlite, which is not a Postgres emulator: it is the
Postgres source tree compiled to WebAssembly. It reports `server_version`
18.3 and behaves like it, because it is it: PL/pgSQL, triggers, GIN
indexes, savepoints, advisory locks, LISTEN/NOTIFY, the works (we verified
this the hard way, by running
[880 real migrations from 8 unmodified apps](06-unmodified-apps.md)).

The parts of "SQLite convenience" that actually matter survive:

- **No daemon, no port, no password.** The database is a dependency of your
  project, not a service on your machine.
- **Reset is trivial.** Point at a fresh directory, or keep a few datadirs
  around as fixtures (one per test suite, one with seed data).
- **Crash-safe like you'd hope.** `kill -9` the process mid-write and reopen:
  committed rows are there, every time, because this is Postgres WAL
  recovery, not a promise. We ship the test: 4 rounds of `kill -9` against
  a writer, 25/25 committed rows intact each round, and a dead process's
  lock is reclaimed in ~80-95ms instead of a timeout wait. The wrapper also
  solves the classic PGlite footgun where a hot-reload dev server keeps the
  old process alive and two writers corrupt the datadir: the second opener
  is locked out, and when the holder dies, the waiter takes over cleanly.

When your app expects a `DATABASE_URL` instead of a library handle, you add
the wire: `@zeropg/server` serves the byte-identical Postgres wire protocol
on 127.0.0.1, and `psql`, node-postgres, Knex, Drizzle, and both of
Prisma's runtime paths connect like it's any other Postgres. The one gap:
Prisma's migrate engine can't drive a single-session database, so
`zeropg migrate dev` replays your ordinary Prisma migration files instead.
Your schema files don't change.

## Stage 2: deploy it for free, still Postgres

Here's where the story stops being "nice dev tool" and becomes a lifecycle.
The same database, unchanged, deploys to a scale-to-zero container (Cloud
Run today; the design is bucket-generic): the datadir now lives in a GCS
bucket, the container restores from it on the first request and evaporates
after the last one. While nobody uses your app, the database costs bucket
storage: cents. When someone shows up, it cold-starts in a few seconds
(measured: ~3.8s p50 for a 10MB database, ~11s at 500MB, and
[the app framework is usually the slower part](02-the-cold-start-equation.md)).

For the Supabase-shaped version of this, we run PostgREST + GoTrue on the
same substrate, so stock `supabase-js` works unmodified against a stack
that sleeps at zero:
[supabase-scale-to-zero.0rs.org](https://supabase-scale-to-zero.0rs.org) is
live and you can watch it wake. Signup, login, row-level security, the API
you'd write against the hosted product, minus realtime and edge functions
(deliberately out of scope).

The point is what did NOT happen between stage 1 and stage 2: no dialect
migration, no ORM swap, no schema translation. You changed where the bytes
sleep.

## Stage 3: the 1% case, and the boring exit

Most side projects never get traffic. That's not pessimism, it's the reason
scale-to-zero economics work. But if yours is the one that takes off, the
exit is deliberately boring:
[`pg_dump` out, restore into managed Postgres, change one connection string](https://github.com/reisepass/zeropg/blob/main/docs/GRADUATION.md).
We verified the dump from a zeropg database restores byte-identically
(row-level checksums) into a stock PostgreSQL 18.4 server. There's no
proprietary format to escape, because there was never a format: it was
Postgres the whole time. Graduate to managed Supabase and keep your
supabase-js code, or to RDS/Cloud SQL and keep your ORM code.

You'll know it's time from one of three signals: the instance is awake more
than a few hours a day (the economics flip), the database has grown past
the 0.5-4GB range (cold starts stop being cute), or you have sustained
concurrent write traffic (a single-writer WASM engine serializes it; that's
a real Postgres cluster's job). Full math in
[BREAK-EVEN.md](https://github.com/reisepass/zeropg/blob/main/BREAK-EVEN.md).

## What you're trading, stated plainly

zeropg is single-writer and single-session: concurrent queries serialize,
which is fine for dev and small production and wrong for high-concurrency
production (that's signal 3 above, and it's your graduation bell, not a bug
to file). Extensions must be preloaded at database creation (three covered
all 880 migrations we ran; PostGIS doesn't exist for PGlite at all). No
realtime subscriptions, no edge functions. The
[LIMITATIONS doc](https://github.com/reisepass/zeropg/blob/main/docs/LIMITATIONS.md)
is the full list.

The trade you get back: the prototype database and the production database
stop being different databases. SQLite's slot, Postgres's semantics, and a
migration path where every step is a connection-string change.
