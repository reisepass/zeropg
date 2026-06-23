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

## Limitation 5 — client wire-protocol coverage (one untested edge)

Three different client stacks drove pglite-socket cleanly: node-postgres (Cal.com/Rallly/NocoDB),
Prisma native engine over libpq-style (Documenso), and PHP `pdo_pgsql`/libpq (PrivateBin —
SSL auto-fell-back to plaintext, no `sslmode` tweak needed). **One surface remains untested:**
server-side named prepared statements (extended-protocol PREPARE/Bind/Execute reuse) under
**persistent** connections — PrivateBin ran fresh-connection-per-request so never exercised it.
Worth a dedicated test before claiming full extended-protocol parity.

## Testability grades (how hard for an AI to verify, 1-10)

| App | Grade | Note |
|---|---|---|
| NocoDB | 9 | email+password admin, no email verify; only friction is canvas-rendered grid (coordinate clicks) |
| PrivateBin | 9 | no auth at all; paste round-trip; stored blob is opaque ciphertext (verify by row existence) |
| Cal.com | 8 | email+password signup writes the row before email verification; heavy boot |
| Documenso | 8 | email+password signup writes before verification; requires drawing/typing a signature pad |

All four reached a real DB write with **no human-only step** (no OAuth, no emailed code). Apps
that gate the first DB write behind OAuth or an emailed verification code are the ones to skip
for automated proof.
