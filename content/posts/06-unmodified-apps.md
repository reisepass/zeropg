# We pointed 8 real apps at a Postgres that doesn't exist

*What actually breaks when unmodified open-source apps run against Postgres-in-WASM
over a single multiplexed session. Spoiler: less than you'd guess, and never what
you'd guess.*

[zeropg](https://github.com/reisepass/zeropg) serves a real Postgres wire protocol from
a scale-to-zero container whose database lives in a GCS bucket. The obvious question:
is it *actually* Postgres, or "Postgres until your ORM does something interesting"?

So we ran real apps against it. Not toys: PrivateBin, NocoDB, Rallly, Documenso,
Cal.com, two nostr relays, a webhook gateway, and cocoon (a Bluesky-compatible AT
Protocol PDS). Official images, zero source patches. The only change: replace the
`postgres:` container with the zeropg sidecar and point `DATABASE_URL` at
`127.0.0.1:5432`. Between them: **880 linear migrations** plus two apps that
self-bootstrap 124-table schemas at runtime, all driven end-to-end in a real browser,
every write read back from the bucket.

## What worked (verified, not assumed)

Everything you would call "real Postgres": PL/pgSQL functions, triggers, views, GIN
indexes (including `gin_trgm_ops` doing a genuine bitmap index scan, checked with
EXPLAIN), `CREATE INDEX CONCURRENTLY`, SERIALIZABLE transactions, savepoints with
partial rollback, advisory locks, LISTEN/NOTIFY, multi-schema layouts, composite-PK
rewrites mid-migration. PGlite reports `server_version` 18.3 and behaves like it.

Across 880 migrations, **nothing hit a Postgres feature PGlite lacks.** Every single
blocker reduced to one of two things.

## Blocker 1: extensions (solvable, with a twist)

Missing extensions caused every migration failure, and the failures look worse than
they are: one early `CREATE EXTENSION citext` failing cascades into "110 of 130
migrations failed," because every later migration references the table that never got
created. The real diagnosis is always "2 extensions missing."

The twist: PGlite ships ~33 contrib extensions precompiled to WASM (citext, pgcrypto,
pg_trgm, uuid_ossp, btree_gin, hstore, ...), but `CREATE EXTENSION IF NOT EXISTS` does
NOT lazy-load them. The extension exists only if its module was preloaded at database
creation. Preload it and the same SQL is a clean no-op. Three extensions (citext,
pgcrypto, pg_trgm) covered all 880 migrations; Cal.com's 588 needed zero.

The hard wall version: pgvector ships as a separate package (reachable), PostGIS does
not exist for PGlite at all. A GIS app is out; screen for that up front.

## Blocker 2: named prepared statements (the real wall)

zeropg's wire multiplexes every TCP connection onto ONE Postgres session. That is fine
for most drivers, because most drivers use *unnamed* prepared statements: node-postgres,
Knex, PHP's pdo_pgsql, and both of Prisma's runtime paths all just work.

The wall is drivers that create **named** server-side prepared statements and assume
each connection owns a clean namespace. Rust's sqlx prepares `sqlx_s_1`, `sqlx_s_2`...;
the second connection to prepare `sqlx_s_1` gets `42P05 prepared statement already
exists`. Diesel, same mechanism. If this failure smells familiar: it is exactly the
pgBouncer-transaction-pooling incompatibility, rediscovered. There is no
connection-string escape for either, so Rust-sqlx/Diesel apps are blocked, period.

Go's pgx sits right on the boundary and has the most instructive story. It defaults to
named cached statements (would collide), but exposes the mode as a DSN parameter, no
code change. First finding: `?default_query_exec_mode=simple_protocol` cleared it for
cocoon. Then webhookx corrected us: simple_protocol sends parameters as untyped text,
which breaks JSONB columns fed `[]byte` (rejected as a bytea literal). The mode that
survives both is **`cache_describe`**: the server still describes types (JSONB encodes
correctly) but no named statement outlives a connection. We hammered 200 parameterized
JSONB inserts through it with zero failures. If you remember one flag from this post,
it's that one.

And one Prisma correction worth publishing because we ourselves believed the wrong
version for weeks: Prisma's **runtime** works on zeropg in BOTH modes, driver-adapter
and the native Rust query engine (Documenso runs the native engine in production shape,
with `?sslmode=disable`). What cannot run is the **migrate/schema engine** (`migrate
dev`, `db push`); migrations get applied by the sidecar instead, from the app's own
migration files.

## The screen, if you want to reuse it

1. Does the app need a non-bundled extension (PostGIS)? Reject.
2. Does its driver keep named server-side prepared statements across pooled
   connections with no mode switch (sqlx, Diesel)? Reject.
3. Is it pgx? Inject `default_query_exec_mode=cache_describe`, pool > 1, proceed.
4. Everything else: it will very probably just run. The remaining limits are
   throughput-shaped, not correctness-shaped: one session serializes concurrent
   queries (measured: 20 overlapping queries from a pool of 10 complete exactly
   serialized, no errors), so heavy concurrent write traffic is your signal to
   graduate to a normal Postgres, not to debug.

Full evidence tables, per-app:
[docs/POSTGRES-APP-COMPAT.md](https://github.com/reisepass/zeropg/blob/main/docs/POSTGRES-APP-COMPAT.md).
The live demos (cold-starting from the bucket as you click):
[privatebin](https://privatebin-scale-to-zero.0rs.org) ·
[nocodb](https://nocodb-scale-to-zero.0rs.org) ·
[rallly](https://rallly-scale-to-zero.0rs.org) ·
[documenso](https://documenso-scale-to-zero.0rs.org) ·
[a real AT Protocol PDS](https://pds-scale-to-zero.0rs.org).
