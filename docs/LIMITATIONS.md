# Limitations: what breaks, what to configure, when to leave

The one-page version. Every line here was hit for real while running unmodified apps;
the evidence and mechanisms live in [POSTGRES-APP-COMPAT.md](POSTGRES-APP-COMPAT.md),
the cost math in [../BREAK-EVEN.md](../BREAK-EVEN.md), the exit in [GRADUATION.md](GRADUATION.md).

## Architecture limits (by design, not bugs)

1. **One writer.** A single instance holds the lease and owns all writes. Any number of
   leaseless read replicas can follow the bucket. There is no multi-writer mode and none
   is planned.
2. **One session behind the wire.** pglite-socket serializes every connection onto one
   PGlite session. Consequences:
   - Concurrency is a **throughput** limit, never a correctness one (measured: 20
     overlapping queries from a Pool(10) complete cleanly, exactly serialized).
   - **Read-after-write over separate connections can lag** under load: a row committed
     behind a busy session can appear seconds after the HTTP 200 that wrote it.
     Verification and tests must poll, not assume immediate visibility.
   - **Do not issue a dependent query while a result cursor is still open** on another
     connection path; under concurrency this deadlocks the single session. Drain results
     first (fixed this way in zeropocket).
3. **The database must fit in instance memory.** The datadir lives on tmpfs. Measured
   tiers: a 500MB database runs in a 1GiB container (tight), 2GiB comfortable. Rough
   working ceiling before graduation: **~0.5GB of data** (cold start ~11s there, scaling
   roughly linearly with size).
4. **Cold starts are real**: ~3.5-5s for small DBs on Cloud Run, plus your app's own boot
   weight, which usually dominates. See [COLDSTART-MODEL.md](COLDSTART-MODEL.md). Wrong
   for a checkout path; fine for things that are idle 95% of the day.
5. **Durability is a dial you must consciously set.** `strict` = ack ⇒ in the bucket
   (~0.2s writes). `interval`/`sleep` = memory-speed writes with a bounded loss window
   (since the last flush) if the instance dies uncleanly. The serverless-native default
   is `sleep`; know what you picked.

## Driver / ORM compatibility

| stack | verdict | detail |
|---|---|---|
| node-postgres (`pg`), Knex, anything using unnamed prepared statements | ✅ works | Cal.com, Rallly, NocoDB, nostream all verified |
| PHP `pdo_pgsql` / libpq | ✅ works | PrivateBin verified; no `sslmode` needed |
| Prisma **at runtime** (driver-adapter AND native query engine) | ✅ works | native engine needs `?sslmode=disable` and user `postgres` (Documenso verified) |
| Prisma **migrate/schema engine** (`migrate dev`, `db push`, `migrate deploy`) | ❌ cannot run | needs shadow DB + its own connections; apply migrations via the zeropg-db-migrate sidecar instead (it runs the app's real SQL migrations in-process) |
| Go `pgx` v5 / GORM | ✅ with one DSN param | `?default_query_exec_mode=cache_describe` and pool > 1. NOT `simple_protocol`: it sends `[]byte` params untyped and breaks JSONB columns (webhookx hit `22P02`). cocoon + webhookx verified |
| PostgREST | ✅ with flags | `db-prepared-statements=false`, pool=1 (built into @zeropg/server); the assembled Supabase stack (PostgREST + GoTrue + RLS) is verified live |
| GoTrue (pop/pgx v4) | ✅ with `statement_cache_mode=describe` | clears the 42P05 collision |
| Rust **sqlx** | ❌ blocked | creates NAMED server-side prepared statements per connection; the shared session collides (`42P05`). No connection-string escape hatch. Blocks nostr-rs-relay |
| Rust **Diesel** | ❌ blocked | same mechanism (also a known pgBouncer-transaction-mode breaker, diesel-rs/diesel#1028). Blocks rsky-pds |

The screen to apply to any new app: **does its driver create named server-side prepared
statements and keep them across pooled connections?** If yes and there is no mode switch,
it will not run today. A per-connection statement-namespacing fix requires a real
wire-protocol parser in pglite-socket (assessed: deep change, not a patch; see
POSTGRES-APP-COMPAT.md Limitation 5).

## Extensions

- PGlite only has an extension if its JS module was **preloaded** into `PGlite.create({ extensions })`.
  `CREATE EXTENSION IF NOT EXISTS` does not lazy-load; without preload you get
  `extension "X" is not available`. With preload it is a clean no-op.
- **~33 contrib extensions ship with PGlite** (citext, pgcrypto, pg_trgm, uuid_ossp,
  btree_gin, hstore, ltree, unaccent, ...). Across 880 real migrations from 3 apps, these
  three covered every need: `citext`, `pgcrypto`, `pg_trgm`.
- **pgvector** is a separate package (`@electric-sql/pglite/vector`), reachable but wired
  differently. **PostGIS does not exist** for PGlite; a GIS app is out. FDW bundles load
  but their runtime behavior from the WASM sandbox is untested.
- Gotcha for Docker images consuming the published npm packages: make sure the server
  actually forwards `extensions` to `PGlite.create` (older @zeropg/objectstore-fs@0.0.1
  images hit this; the supabase example shows the working wiring).

## Operational gotchas (platform-level)

- **Migrations must come from the same app image that runs**, never repo HEAD: version
  skew between bundled client and schema produces real 500s (Cal.com `P2022`).
- **Apps must retry the initial DB connection**: the sidecar's control-port health check
  can return 200 a few seconds before the Postgres wire is up (`ECONNREFUSED` window).
- On Cloud Run, don't route `/healthz` on the app's public port (the edge intercepts it);
  use another path like `/livez`. Don't set `PORT` yourself on the ingress container. Pin
  app images by `@sha256` digest to force revision rolls.
- GCS caps writes per object name at ~1/s: sustained strict-commit writers group-commit
  and pace (handled in the driver; visible as latency, not errors).
- A write every <15 minutes keeps the instance awake forever: you get always-on prices
  without always-on benefits. Request **spacing**, not request count, is what bills
  ([BREAK-EVEN.md](../BREAK-EVEN.md)).

## When to leave (the point of the whole design)

Graduate to an always-on Postgres when any of these hold:

- data approaching **~0.5GB** (cold start and memory tiers start to hurt),
- sustained **concurrent write** traffic (the single session is your ceiling),
- awake **>4-5 hours/day** (an always-on instance becomes cheaper).

Graduation is `pg_dump | pg_restore` plus one connection-string change, because it was
real Postgres the whole time. Runbook: [GRADUATION.md](GRADUATION.md).
