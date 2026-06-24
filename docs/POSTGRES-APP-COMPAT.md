# Running real Postgres apps on zeropg — compatibility findings

Source-verified by running 5 real, unmodified apps against zeropg (PGlite over the
pglite-socket Postgres wire), Docker/config-only, each driven end-to-end in a real
browser and read back from the database. The point of this doc is the **limitations
matrix** — what breaks, why, and what the tooling should do about it.

## Results

| App | ORM / driver | Schema onto zeropg | Tables | Extensions needed | Verified write |
|---|---|---|---|---|---|
| Rallly | Prisma **driver-adapter** (`@prisma/adapter-pg`) | 130 migrations | 30 | `citext`, `pgcrypto` | user/account/space graph |
| Cal.com | Prisma **driver-adapter** | 588 migrations | 124 | **none** | signup users row (+104 app-store seed rows) |
| Documenso | Prisma **native query engine** | 162 migrations | 52 | `pgcrypto`, `pg_trgm` | user + personal org graph |
| NocoDB | Knex (`pg`) | **runtime self-bootstrap** | 124 | **none** | metadata + per-base data row |
| PrivateBin | PHP `pdo_pgsql` (libpq) | **runtime self-create** | 3 | **none** | encrypted paste row |
| cocoon (AT Proto PDS) | GORM + **`pgx` v5** (`?default_query_exec_mode=simple_protocol`) | **runtime AutoMigrate** | 13 | **none** | account row + record + repo MST blocks |

(Cap was rejected before building — it is MySQL/PlanetScale, a dialect zeropg can't serve.)

## The headline: no fundamental incompatibility found

Across **880 linear migrations** (Rallly+Cal.com+Documenso) plus **two runtime-bootstrapped
schemas** (NocoDB's 124-table Knex bootstrap, PrivateBin's PDO auto-create), **nothing
hit a Postgres feature PGlite lacks.** Every blocker reduced to a missing *bundled*
contrib extension.

### Confirmed-working Postgres surface (empirically verified — each checked to take effect, not just "no error")

- **PL/pgSQL functions** (Cal.com: 30, one called returned the right value), **triggers** (28), **views** (3).
- **GIN indexes**: built-in `array_ops` on `text[]` (Cal.com), and **`gin_trgm_ops` fully functional** (Documenso) — `EXPLAIN` shows a real *Bitmap Index Scan + Recheck*, `similarity()` returns correct ranked results. Not a seqscan-fallback / no-op.
- **`CREATE INDEX CONCURRENTLY`** (Cal.com) — works; degenerates to a normal `CREATE INDEX` (single connection).
- **Transactions**: `BEGIN ISOLATION LEVEL SERIALIZABLE`, `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` (NocoDB, count correct after partial rollback).
- **Advisory locks** `pg_try_advisory_lock`/`pg_advisory_unlock` (NocoDB — Knex's migration-lock primitive); **`LISTEN`/`NOTIFY`** (NocoDB).
- **Multi-schema**: `CREATE SCHEMA` + `serial`/sequences, table-per-schema (NocoDB = a Postgres schema per base).
- **In-place data migrations**: `DROP PRIMARY KEY` + composite-PK rewrite, `ALTER TABLE ADD COLUMN`, batched `INSERT ... SELECT` (NocoDB).
- **contrib functions/types**: `gen_random_uuid()`, `gen_random_bytes()` (pgcrypto), `citext`, plus enums, CHECK constraints, partial indexes, generated defaults.

`server_version` reports **18.3** (PGlite 0.5 tracks current Postgres).

## Limitation 1 — extensions are the ONLY recurring blocker (and they're bundled)

`citext`, `pgcrypto`, `pg_trgm` covered every need; all ship in `@electric-sql/pglite/contrib/*`.
A missing extension **cascades**: the early migration that needs it fails, the table it
creates never exists, and every later migration referencing that table fails too — so
"110 of 130 failed" is really "2 extensions missing." Cal.com (588) and NocoDB (124)
needed **zero** extensions, so a large mature schema can be totally vanilla.

**The exact mechanism (precise):** the error is `extension "X" is not available`, thrown at
the `CREATE EXTENSION` line. `CREATE EXTENSION IF NOT EXISTS X` does **not** lazy-load — PGlite
only has an extension if its JS contrib module was passed to `PGlite.create({ extensions })`,
which injects the WASM bundle; then `CREATE EXTENSION IF NOT EXISTS` is a clean no-op. So the
fix is always "preload the module," never an SQL change.

→ **Tooling action:** auto-detect required extensions by scanning the migration / bootstrap
SQL — `CREATE EXTENSION`, and type/function tells (`citext` columns → citext;
`gen_random_uuid()`/`gen_random_bytes()` → pgcrypto; `gin_trgm_ops`/`similarity()` → pg_trgm) —
and wire the matching `@electric-sql/pglite/contrib/*` module into `serveWire({ extensions })`
automatically. Today they're passed manually.

**How extensions are delivered:** electric-sql pre-compiles each Postgres contrib extension to
WASM and ships it as a `.tar.gz` bundle inside `@electric-sql/pglite/dist/`. The
`@electric-sql/pglite/contrib/<name>` import is a one-line pointer to that bundle; passing it to
`PGlite.create({ extensions })` extracts it into PGlite's in-WASM filesystem so `CREATE EXTENSION`
can load it. **~33 contrib extensions ship** today: `amcheck, auto_explain, bloom, btree_gin,
btree_gist, citext, cube, dict_int, dict_xsyn, earthdistance, file_fdw, fuzzystrmatch, hstore,
intarray, isn, lo, ltree, pageinspect, pg_buffercache, pg_freespacemap, pg_stat_statements,
pg_surgery, pg_trgm, pg_visibility, pg_walinspect, pgcrypto, postgres_fdw, seg, tablefunc, tcn,
tsm_system_rows, tsm_system_time, unaccent, uuid_ossp`.

**The hard wall (what PGlite genuinely can't do):** an extension PGlite does **not** ship.
- **`pgvector`** — not in contrib; it's a separate package (`@electric-sql/pglite/vector`), so it IS
  reachable but you wire it differently. (This is why Twenty/Khoj from the self-host research are
  pgvector-gated rather than impossible.)
- **PostGIS** — genuinely not shipped (a large non-contrib extension). A GIS app is out.
- **FDWs** — `file_fdw` and `postgres_fdw` bundles DO ship, so `CREATE EXTENSION` loads; whether they
  *function* (file/network access) from the WASM sandbox is untested here — don't assume.
- Anything needing a non-bundled extension → screen for `CREATE EXTENSION <x>` where `<x>` isn't in
  the list above, and reject up front.

## Limitation 2 — Prisma's NATIVE query engine works at runtime (correction to a prior belief)

We previously concluded "Prisma's native engine can't drive single-session PGlite." That is
true only for the **schema/migrate engine** (`migrate dev` / `db push` — the Rust binary
that needs a shadow DB + advisory locks). Documenso uses the **native query engine** at
**runtime** (`new PrismaClient({ datasourceUrl })`, no adapter) and it drives pglite-socket
fine — with two required connection-string params: **`?sslmode=disable`** and user
**`postgres`**. So at runtime, BOTH Prisma paths work: driver-adapter (Cal.com, Rallly) and
native query engine (Documenso). Only the migration step must avoid the schema engine
(apply migrations in-process via zeropg-db instead).

## Limitation 3 — migrations must match the app image's version, not HEAD

Cal.com broke with a real 500 (`P2022 / 42703: column "disableImpersonation" does not exist`)
when migrations were cloned from `main` (595) but the image was `v6.2.0` (588): main had
dropped a column the bundled Prisma client still expected. **Fix that generalizes:** pull
the migrations from the *same image the app runs* (`COPY --from=<app-image>`), never from
the repo HEAD. This guarantees schema ↔ client agreement.

## Limitation 4 — single-session serialization: slow, not broken (+ a read-after-write timing gotcha)

PGlite is one session; pglite-socket serializes all connections onto it. **Measured** (NocoDB):
a `pg` Pool(max:10) firing 20 overlapping `pg_sleep(0.05)` queries completed in **1033ms** =
exactly 20×50ms serialized — one writer, no deadlock, no "too many connections", no dropped
query. So concurrency is a **throughput** limit, never a correctness one: NocoDB's concurrent
124-table bootstrap and Cal.com's 104-row app-store seed both completed clean.

The one operational gotcha: **writes can land seconds behind the HTTP response under load.** An
independent verifier querying immediately after a signup `201` got `NOT FOUND`, because the
row's commit was queued behind the app's boot/seed work on the single session; it appeared
seconds later. → **Tooling/test action:** read-after-write verification must **poll/retry**,
not assume immediate visibility, on a busy single-session instance. Concurrent transactional
throughput is the real ceiling and the signal to graduate to a managed Postgres.

## Limitation 5 — NAMED server-side prepared statements are the real wall (now characterized)

Four client stacks drive pglite-socket cleanly: node-postgres (Cal.com/Rallly/NocoDB/**nostream**),
Prisma native engine over libpq-style (Documenso), and PHP `pdo_pgsql`/libpq (PrivateBin). They
share one trait: they use **UNNAMED** prepared statements (the empty-string statement name in the
extended protocol), so nothing in the catalog collides when many connections share PGlite's single
session. nostream specifically was run with **persistent pooled** knex/`pg` connections issuing
parameterized extended-protocol queries — verified fine — so persistent connections per se are NOT
the problem.

**The wall is NAMED server-side prepared statements.** Rust's **`sqlx`** creates named statements
`sqlx_s_1`, `sqlx_s_2`, … assuming each TCP connection owns a clean catalog namespace. pglite-socket
multiplexes every connection onto ONE PGlite session and never resets prepared statements between
connection lifecycles, so the second connection that prepares `sqlx_s_1` gets
`42P05: prepared statement "sqlx_s_1" already exists` — the same failure sqlx has against pgBouncer
in transaction-pooling mode. `max_conn=1` does **not** fix it (sqlx still opens a second connection
while pipelining). This blocks **nostr-rs-relay** (the Rust relay) entirely.

**The blocker generalizes beyond sqlx — it's ANY named-prepared-statement driver.** Confirmed against
**rsky-pds** (the Rust AT Proto PDS), which uses **Diesel** (not sqlx): Diesel also caches named
server-side prepared statements per connection (`PQprepare`/`PQexecPrepared`) with no
connection-string escape hatch, and is a long-standing pgBouncer-transaction-mode breaker
(diesel-rs/diesel#1028). So the real screen is "does the driver name its server-side prepares and
persist them across the pooled connection lifecycle," not "is it sqlx."

**Escape hatch for `pgx` (Go) — DSN-only, no app patch.** Go's **`jackc/pgx` v5** defaults to
`QueryExecModeCacheStatement`, which auto-prepares + caches with SHA-256-named statements → it WOULD
collide. But unlike sqlx/Diesel, pgx exposes the mode as a **connection-string parameter**:
`...?default_query_exec_mode=simple_protocol` makes pgx use the **simple protocol** (params sent as
text, no server-side prepare at all), which is the pgx/Go equivalent of node-postgres's unnamed-
statement path. As long as the app opens its pool from a DSN string (GORM's `postgres.Open(dsn)`,
`pgxpool.New(ctx, dsn)`, `sql.Open("pgx", dsn)`), this is a **zero-code-change** fix. **Verified end
to end with cocoon** (GORM+pgx AT Proto PDS): with `default_query_exec_mode=simple_protocol`, GORM
AutoMigrate created all 13 tables over the wire with no `42P05`, and a full createAccount →
createRecord → getRecord round-trip + the row/MST-blocks landing in the DB all worked, locally and on
live Cloud Run. No GORM query misbehaved under the simple protocol (no type-inference/text-encoding
edge cases observed across DDL, bytea/CBOR writes, composite-PK upserts, and indexed reads).

**CORRECTION (from webhookx): `simple_protocol` is NOT the right default — use `cache_describe`.**
simple_protocol sends every parameter as **text with no type info**, so it breaks any app that hands
pgx a `[]byte` for a typed column: webhookx's JSONB columns (its ORM's `Value()` returns
`json.Marshal(...)` → `[]byte`) were sent as a **bytea hex literal** and rejected with
`22P02 invalid input syntax for type json`. cocoon only escaped this because it never fed a JSONB
column raw bytes. The mode that works for **both** problems is
**`?default_query_exec_mode=cache_describe`**: pgx still does a server-side *Describe* (so it gets
correct per-column type OIDs → JSONB encodes right) but does **not** keep named prepared statements
across the connection lifecycle, so there is **no `42P05`** either (verified with 200 hammered
parameterized JSONB inserts, zero failures, on the live zeropg wire). So the refined rule is:
**`cache_describe` is the safe pgx default on zeropg**; reach for `simple_protocol` only for an app
with no typed-`[]byte` columns. (Also required for webhookx: a **connection pool > 1** — golang-migrate
holds its advisory-lock connection across migration while bootstrap needs a second; pool=1 deadlocks.
The wire accepts up to ~10 concurrent connections, serialized internally, so a small pool is safe.)
Same modes apply via `pgx`'s exec-mode config or GORM's driver config for apps that build it in code.

**Fix scope (assessed against `@electric-sql/pglite-socket@0.2.2` source):** it's a DEEP/architectural
change, not a small patch. The socket layer frames messages only by length prefix and forwards each
message as an opaque `Uint8Array` into `db.execProtocolRawStream` — it never decodes the message
type or the statement-name field, so it cannot rewrite/mangle statement names without adding a real
wire-protocol parser (a medium-to-large new component). The one "small patch" available — running
`DISCARD ALL` on connection close at the `detach()`/`handleClose()` seam — is unsafe because the
server tracks concurrent overlapping connections on the shared session, so clearing one connection's
statements would nuke a peer's. True per-connection catalog isolation needs one PGlite session per
connection (or a per-connection namespace), i.e. a change to the single-session model itself.
→ **Tooling action:** screen apps for named-prepared-statement drivers up front. Reject the ones with
no escape hatch (Rust **sqlx**, Rust **Diesel**) the same way non-bundled extensions are screened
(Limitation 1). For **`pgx`/Go** apps, don't reject — inject **`default_query_exec_mode=cache_describe`**
into the DSN and let them through (verified with cocoon AND webhookx; `cache_describe` is the safe
default — see the CORRECTION above on why `simple_protocol` breaks JSONB).

## nostream (Node nostr relay) — VERIFIED, including a Redis sidecar

nostream (`github.com/cameri/nostream` v3.0.0) runs on zeropg, verified by a real NIP-01 round-trip
both **locally** and on a **live Cloud Run** multi-container service
(`https://nostr-zeropg-71428757273.europe-west1.run.app`): publish a signed EVENT → `OK true`,
open a REQ subscription → the event streams back + EOSE. Durability proven by forcing a cold restart
(new revision `nostr-zeropg-00002-xlp`) that restored only from `gs://zeropg-experiments-euw1/cloudrun-nostr/`
— the event published to the prior instance still served back over wss.

- **DB**: knex + `pg`, UNNAMED statements → works (see Limitation 5). 29 knex `.js` migrations apply
  over the wire (a `knex migrate:latest` step, not the SQL-folder migrate sidecar). Needs contrib
  **`uuid_ossp`** (`CREATE EXTENSION "uuid-ossp" … version "1.1"`) and **`btree_gin`** (the
  kind/tags/created_at GIN index) — both bundled.
- **Redis: usable two ways.** It's only on the EVENT hot path (rate limiter + dedup cache via
  `messageHandlerFactory`→`getCache()`/`rateLimiterFactory`); cross-worker fan-out is Node **cluster
  IPC** (`worker.send`/`process.on('message')`), not Redis. So:
  - *With a Redis sidecar (clean):* run a small **valkey** (`valkey/valkey:8-alpine`,
    `--save "" --appendonly no`) that scales WITH the instance, so app + zeropg-db + valkey still
    scale to **zero as a unit** — not an always-on external Redis. This is the verified live config.
  - *Without Redis (works, but noisy):* `WORKER_COUNT=1` + a settings.yaml that empties EVERY
    `rateLimits` array (`limits.{connection,message,event,invoice,admissionCheck}.rateLimits: []`)
    makes the hot path never call the cache, and a real round-trip succeeds with no Redis present
    (verified locally). BUT nostream's `redis` client still auto-reconnects forever and the worker's
    `unhandledRejection` handler logs every `ECONNREFUSED` — functional but a continuous error spam.
    Making it *clean* needs a code patch (a `NO_REDIS` stub for `getCacheClient`), at which point you
    are no longer running the unmodified upstream. → If you want truly-no-Redis, prefer `znostr-relay`.
- **Boot gotcha**: nostream's settings watcher `fs.watch()`es `$NOSTR_CONFIG_DIR/settings.yaml` and
  crashes if it's missing (its `createSettings` never actually writes it on a fresh dir). The app
  image must seed `settings.yaml` from `resources/default-settings.yaml` before boot.

Example: `examples/cloudrun/nostr/` (nostream-app built from source + nostr-db sidecar + valkey).

## znostr-relay — our own minimal NIP-01 relay, zeropg-native, NO Redis (VERIFIED)

When "no Redis at all, scale-to-zero as a single unit" is the goal, a purpose-built relay beats
bending nostream. `examples/cloudrun/nostr/znostr-relay/` is ~330 lines: Node + `ws` +
**node-postgres** (UNNAMED statements → clears the sqlx wall by construction) + `@noble`-backed
`verifyEvent`, single process, the DB is the only state. It self-bootstraps its schema at boot (no
migration tool, **no contrib extensions** — only built-in types + a `gin (jsonb)` tag index), so it
rides the **basic** `zeropg-db-sidecar` (same image as PrivateBin/NocoDB).

Implements NIP-01 (EVENT/REQ/CLOSE + the standard filter set: ids/authors/kinds/since/until/limit/
`#<tag>`), live fan-out to open subscriptions, replaceable (0/3/10000–19999) and
parameterized-replaceable (30000–39999 by d-tag) semantics, ephemeral (20000–29999, served not
stored), NIP-09 deletion (kind 5), and basic NIP-45 COUNT. Verified with an 11-check local suite
(publish, every filter type, live broadcast, replaceable-keeps-newest, invalid-sig rejection, row +
tag projection read from the DB) and **live on Cloud Run**
(`wss://znostr-zeropg-71428757273.europe-west1.run.app`): publish → `OK true`, REQ streams it back +
EOSE, and the event **survived a forced cold restart** (revision `znostr-zeropg-00003-bp4`) that
restored only from `gs://zeropg-experiments-euw1/cloudrun-znostr/`. No Redis anywhere.

**Boot ordering gotcha (applies to any app on the basic sidecar):** the `zeropg-db` sidecar's
`/healthz` (control port) returns 200 before its Postgres wire has finished restoring, so a connect
in the first few seconds gets `ECONNREFUSED 127.0.0.1:5432`. An app that connects at boot (znostr
bootstraps its schema before listening) must **retry with backoff**, not crash, or Cloud Run fails
the startup probe. (The migrate sidecar avoids this by polling its own `/up` before touching the wire.)

## Limitation 6 — a verifier reaching the live wire

For the prior 5 apps the DB write was read back from the wire directly. For a relay the wire is
localhost-only inside the instance, so the write is verified two ways instead: (a) the protocol
round-trip (REQ returns the just-published event over wss), and (b) GCS durability — the WAL segment
timestamps advance past the publish time and a cold-restart instance restores and re-serves the event.

## Testability grades (how hard for an AI to verify, 1-10)

| App | Grade | Note |
|---|---|---|
| NocoDB | 9 | email+password admin, no email verify; only friction is canvas-rendered grid (coordinate clicks) |
| PrivateBin | 9 | no auth at all; paste round-trip; stored blob is opaque ciphertext (verify by row existence) |
| Cal.com | 8 | email+password signup writes the row before email verification; heavy boot |
| Documenso | 8 | email+password signup writes before verification; requires drawing/typing a signature pad |
| nostream | 9 | no auth gate; sign+publish an EVENT over ws (nostr-tools), assert REQ streams it back; wait for the AUTH challenge before the first publish or the relay drops the racing frame |
| znostr-relay | 10 | our own relay; no auth, no AUTH-challenge race; publish→OK→REQ→EVENT+EOSE; read row + tag projection straight from the DB |
| cocoon (PDS) | 7 | invite-gated (or `COCOON_REQUIRE_INVITE=false`) email+password createAccount → createRecord → getRecord, all over plain XRPC HTTP, no OAuth/emailed code. The one external dep: account creation POSTs the genesis op to the hardcoded `https://plc.directory` (needs outbound internet, registers a real `did:plc`); reads/writes of existing accounts are fully self-contained |

All four reached a real DB write with **no human-only step** (no OAuth, no emailed code). Apps
that gate the first DB write behind OAuth or an emailed verification code are the ones to skip
for automated proof.
