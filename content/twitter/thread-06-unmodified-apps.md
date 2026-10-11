# Thread 6: unmodified apps (pairs with posts/06-unmodified-apps.md)

1/
We pointed 8 real open-source apps at a Postgres that doesn't exist (WASM Postgres, database lives in a GCS bucket, compute scales to zero).

PrivateBin, NocoDB, Rallly, Documenso, Cal.com, two nostr relays, a webhook gateway, a Bluesky-compatible AT Protocol PDS.

Official images. Zero source patches. 880 real migrations.

2/
The only change per app: delete the `postgres:` container, point DATABASE_URL at the sidecar on 127.0.0.1:5432.

The question we were testing: is it ACTUALLY Postgres, or "Postgres until your ORM does something interesting"?

3/
What worked, verified with EXPLAIN and a real browser, not assumed:

PL/pgSQL, triggers, views, GIN indexes (gin_trgm_ops doing a genuine bitmap index scan), CREATE INDEX CONCURRENTLY, SERIALIZABLE transactions, savepoints, advisory locks, LISTEN/NOTIFY, multi-schema layouts, 124-table runtime self-bootstraps.

4/
Across 880 migrations, NOTHING hit a Postgres feature PGlite lacks.

Every single blocker reduced to one of exactly two things. Neither is the one you'd guess.

5/
Blocker 1: extensions. And the failures lie to you.

One early `CREATE EXTENSION citext` failing cascades into "110 of 130 migrations failed" because everything downstream references the table that never got created.

The real diagnosis is always: 2 extensions missing.

6/
The twist: PGlite SHIPS ~33 contrib extensions compiled to WASM. But `CREATE EXTENSION IF NOT EXISTS` does not lazy-load them. The module must be preloaded at database creation; then the same SQL is a clean no-op.

3 extensions (citext, pgcrypto, pg_trgm) covered all 880 migrations.

Hard wall: PostGIS doesn't exist for PGlite. GIS apps are out. Screen for it up front.

7/
Blocker 2, the real wall: NAMED server-side prepared statements.

The wire multiplexes every TCP connection onto one Postgres session. Most drivers use unnamed statements and just work: node-postgres, Knex, pdo_pgsql, both Prisma runtime paths.

Rust sqlx prepares sqlx_s_1, sqlx_s_2... second connection: `42P05 prepared statement already exists`. Diesel, same. Blocked, period.

If that smells familiar: it's the pgBouncer transaction-pooling incompatibility, rediscovered.

8/
Go's pgx has the instructive story. Defaults to named cached statements (would collide) but exposes the mode as a DSN param.

First fix: ?default_query_exec_mode=simple_protocol. Worked for one app, then broke another: simple protocol sends params as untyped text, which rejects []byte into JSONB.

The mode that survives both: cache_describe. Types still described (JSONB encodes right), no named statement outlives a connection. 200 parameterized JSONB inserts, zero failures.

One flag to remember: `default_query_exec_mode=cache_describe`

9/
A correction we ourselves got wrong for weeks: Prisma's RUNTIME works in both modes, driver-adapter AND the native Rust query engine (Documenso runs the native engine, production shape).

What can't run is the migrate/schema engine (migrate dev, db push). The sidecar applies the app's own migration files instead.

10/
The screen, if you want to reuse it:

1. Needs PostGIS? Reject
2. Driver keeps named prepared statements with no mode switch (sqlx, Diesel)? Reject
3. pgx? Inject cache_describe, proceed
4. Everything else very probably just runs. The remaining limits are throughput-shaped, not correctness-shaped

11/
All of them ran live. PrivateBin still does, cold-starting out of the bucket as you click:

https://privatebin-scale-to-zero.0rs.org

NocoDB, Rallly, Documenso and the PDS are taken down now; deploy your own:
https://github.com/reisepass/zeropg/tree/main/examples

Per-app evidence tables: https://github.com/reisepass/zeropg/blob/main/docs/POSTGRES-APP-COMPAT.md
