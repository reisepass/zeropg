# postgres-meta on zeropg - compatibility matrix + SQL-editor design notes

Gate spike for `docs/DIY-zeroSupabaseStudioFrontend.md`: does `supabase/postgres-meta`
(the introspection + run-SQL engine behind Supabase Studio) work against zeropg's
**one shared PGlite session**? This is the single new backend dependency the Studio
plan rests on.

**VERDICT: GO-WITH-CONFIG.** All P0 endpoints (schemas, tables+columns, columns,
run-SQL) and all P1 endpoints work over the multiplexed single session with **zero
app patches** - postgres-meta needs no special config to *connect* (its default
pool `max: 1` and unnamed node-postgres statements sidestep the 42P05 class
entirely). The "config" in GO-WITH-CONFIG is not about making it run; it is about
two behaviors the **SQL editor** must design around: server-side `statement_timeout`
is a no-op on PGlite, and `SET`/session state leaks across requests on the shared
session.

Tested against `supabase/postgres-meta:v0.96.6` (npm `@supabase/postgres-meta@0.96.6`),
PGlite behind `@electric-sql/pglite-socket@0.2.2` via `serveWire` (the same
single-session multiplexer the Cloud Run `zeropg-db` uses; GCS persistence is
irrelevant to this spike, so the killswitch boots a local no-GCS wire server).
Repeatable: `examples/cloudrun/supabase/test/killswitch-pgmeta.mjs`.

## How postgres-meta talks to Postgres (why it "just works")

Read from the shipped source (`dist/lib/db.js`, `dist/server/constants.js`,
`dist/server/routes/query.js`):

- **node-postgres `pool.query(sql, params)` with NO statement name.** node-postgres
  only creates a *named* server-side prepared statement when a query is given a
  `name`; postgres-meta never does. So the whole 42P05 "prepared statement already
  exists" class that bit PostgREST and GoTrue **does not arise here.** No
  `PGRST_DB_PREPARED_STATEMENTS=false` / `statement_cache_mode=describe` equivalent
  is needed.
- **Default pool `max: 1`** (`DEFAULT_POOL_CONFIG`). Each server keeps a single
  connection; each `POST /query` request builds a *fresh* `PostgresMeta` (its own
  `max:1` pool), runs one query, then `pool.end()`s. Under concurrency you get
  several short-lived TCP connections, all multiplexed onto the one PGlite session.
- **`POST /query` does NOT wrap statements in a transaction.** It sends the raw SQL
  as one simple/extended query. When a `statementTimeoutSecs` query param is passed
  it *prefixes* `SET statement_timeout='Ns'; SET idle_session_timeout='Ns';` and
  runs the whole thing as a multi-statement simple query, returning the last
  non-empty result set. With no param (the default), it is just the user's SQL,
  autocommit. **Implication for Studio: a single statement in the SQL editor
  autocommits; there is no implicit BEGIN/COMMIT wrap to reason about.**
- **`query_timeout: 55000`** is node-postgres *client-side* (`PG_QUERY_TIMEOUT_SECS`,
  default 55s). It aborts the client's wait and destroys the connection; it does
  **not** cancel the query inside PGlite (see timeout findings).

## Required config to run postgres-meta on zeropg

Docker (what the killswitch uses by default):

```
docker run --rm -d --name pgmeta \
  -p 8080:8080 \
  -e PG_META_PORT=8080 \
  -e PG_META_DB_URL=postgresql://postgres:postgres@host.docker.internal:5432/postgres?sslmode=disable \
  supabase/postgres-meta:v0.96.6
```

- `PG_META_DB_URL` (or the `PG_META_DB_HOST/PORT/NAME/USER/PASSWORD` parts) -> point
  at the zeropg wire port. `sslmode=disable` (pglite-socket speaks plaintext wire).
- The wire server must bind an address the container can reach. In the killswitch we
  bind `serveWire({ host: '0.0.0.0' })` and the container uses `host.docker.internal`
  (Docker Desktop). In Cloud Run multi-container, postgres-meta and the db sidecar
  share `127.0.0.1`, so `PG_META_DB_HOST=127.0.0.1`.
- **No** `statement_cache_mode`, **no** `prepareThreshold`, **no** pool tuning is
  required. Leave the pool at its default `max:1`.
- Recommended override for the SQL editor: set `PG_QUERY_TIMEOUT_SECS` **low** (e.g.
  15-30). Since server-side `statement_timeout` is a no-op (below), this client-side
  timeout is your only automatic guard against a hung wait.

## Compatibility matrix

"Works" here means postgres-meta can **introspect and return the expected metadata**
for the fixture objects (and, for `POST /query`, run the SQL) over the single shared
session - it is not a full semantic validation of every PostgreSQL feature.

`endpoint | required for P0? | works? | notes`

| endpoint | P0? | works | notes |
|---|---|---|---|
| `GET /schemas` | **P0** | YES | lists user + system schemas |
| `GET /tables` (with `columns`) | **P0** | YES | `?included_schemas=` filters; each table carries its `columns[]` |
| `GET /columns` | **P0** | YES | types, defaults, nullability correct |
| `POST /query` (run arbitrary SQL) | **P0** | YES | single + multi-statement; returns last non-empty result set; errors surfaced with pg code + `formattedError` |
| `GET /roles` | P1 | YES | includes custom `NOLOGIN` roles |
| `GET /policies` | P1 | YES | RLS policies listed (name, table, cmd, using/check) |
| `GET /functions` | P1 | YES | plpgsql function bodies + args |
| `GET /triggers` | P1 | YES | trigger name, table, timing, function |
| `GET /indexes` | P1 | **PARTIAL** | returns the primary-key index; **omits secondary indexes on non-first columns** (see gap below). Underlying data is fine via `pg_indexes`. |
| `GET /extensions` | P1 | YES (lists) | lists available/installed extensions. `CREATE EXTENSION` still needs the JS contrib module preloaded into PGlite - unchanged from the existing extension findings; not a postgres-meta concern. |

Not exercised (out of P0/P1 scope, expected fine as they are plain catalog reads):
`/views`, `/materialized-views`, `/foreign-tables`, `/publications`,
`/table-privileges`, `/column-privileges`, `/types`, `/config`, `/generators`.

### The one real gap: `GET /indexes` is partial

postgres-meta's index query joins `pg_attribute` on the **index** oid with
`a.attnum = ANY(idx.indkey)`. An index relation numbers its own attributes `1..N`,
while `indkey` holds the **table** column ordinals. Under PGlite's catalog these
only match when the index's leading column is the table's first column - so a
primary key on column 1 shows, but `CREATE INDEX x ON t(second_column)` is silently
dropped from the result. The data itself is correct: `SELECT * FROM pg_indexes`
returns every index. This is either a latent postgres-meta catalog-query bug that
PGlite's catalog semantics expose, or a PGlite catalog difference; a stock-Postgres
control was not run to attribute root cause. Either way the Studio mitigation is the
same.

**Mitigation:** the Studio "Database -> Indexes" view should read `pg_indexes`
directly through `POST /query` rather than trust `GET /indexes`. The killswitch
asserts both halves (meta omits it, `pg_indexes` returns it) so the workaround stays
valid.

## Adversarial findings (the point of the spike)

### 1. Concurrency / prepared-statement collision - CLEAN

20 concurrent mixed requests (`/tables` + `/columns` + `POST /query`) and 50x the
identical query: **all 200, no 42P05, no 26000, no interleave corruption.** Confirmed
by construction (unnamed statements) and by the hammer test. Separately, 200
concurrent autocommit `UPDATE ... SET n = n+1` increments produced exactly 200 - so
simple concurrent autocommit writes are **not losing updates** through the
pglite-socket multiplexer. (This is empirical evidence for that workload, not a proof
of general serializability - see the interleaving note under finding 4.)

### 2. Session poisoning after a bad query - SAFE (outside explicit transactions)

`POST /query` with invalid SQL returns HTTP 4xx carrying the real pg error (e.g.
`42P01`, with `formattedError`). The **very next** `POST /query` and `GET /tables`
both succeed - **no "current transaction is aborted" state.** Because `POST /query`
is autocommit (no wrapping BEGIN), a failed statement leaves nothing open to abort.
Caveat: a user *can* still reach the aborted state by submitting a bad statement
*inside* an explicit `BEGIN ...` block in one editor submission; that block errors as
it would on stock Postgres. postgres-meta closing its per-request pool rolls the
transaction back, but the failure is within that submission.

### 3. Session-state contamination - LEAKS, but bounded and reversible

Everything runs on **one** PGlite backend session, so `SET`s persist across
*requests and across connections*:

- `SET search_path TO demo` issued by one request makes a **later, separate** request
  resolve an unqualified `demo` table - proving the leak crosses postgres-meta's
  per-request pools onto the single shared session.
- **Introspection endpoints are immune:** postgres-meta's `/tables`, `/columns`, etc.
  are fully schema-qualified against `pg_catalog`, so they stay correct even under a
  polluted `search_path`.
- The leak is **reversible:** `SET search_path TO public` (or `RESET ALL`) restores
  the session.

**Implication for Studio:** a user's `SET`, `SET ROLE`, `SET search_path`,
`SET TIME ZONE`, etc. in the SQL editor persist for **everyone** on the backend until
reset. The BFF/SQL-editor path should defensively restore a known baseline at the
**start of each SQL-editor submission**. Two correctness details (both verified on
PGlite):

- **`RESET ALL` does NOT clear `SET ROLE`.** After `SET search_path TO x; SET ROLE r;`,
  a `RESET ALL` restored `search_path` but left `current_user = r`. Role state needs an
  explicit `RESET ROLE` (and `RESET SESSION AUTHORIZATION` if `SET SESSION
  AUTHORIZATION` is reachable). Use `RESET ROLE; RESET ALL; SET search_path TO public`
  as the baseline, not `RESET ALL` alone.
- Start-of-submission reset contains **editor-to-editor** leakage. It does not retro-fix
  any *other* consumer that reads the session between submissions - though PostgREST /
  GoTrue do their own per-request `SET LOCAL role` inside a transaction, and
  postgres-meta introspection is schema-qualified, so those specific consumers are
  already insulated.

This is a single-shared-session property of zeropg, not a postgres-meta bug.

### 4. statement_timeout + long-query blast radius - THE decision-driver

- **Server-side `statement_timeout` is ineffective in the tested PGlite paths - do
  not rely on it.** `SET statement_timeout='500ms'; select pg_sleep(2)` ran the
  **full 2s** and returned 200; the timeout never fired. `idle_session_timeout` was
  likewise accepted and inert. The likely reason is that single-threaded PGlite does
  not deliver/check the timeout interrupt for these executor paths (stock Postgres
  checks a flag at interrupt-safe points; PGlite apparently does not here). Treat
  postgres-meta's `?statementTimeoutSecs=` as advisory/ineffective on zeropg unless a
  specific PGlite version proves otherwise.
- **Long AUTOCOMMIT queries did NOT head-of-line block other clients in these
  tests.** With one client running a 3-5s statement, a second client fired 8 probe
  queries at 250ms cadence and every probe returned in **1-5ms** - across all four
  combinations: long-query = `pg_sleep` vs CPU-bound `count(*)` over a 20M-row
  `generate_series`, and probe = read (`SELECT 1`) vs write (`INSERT`). So a slow
  admin query in the SQL editor does **not** stall PostgREST/GoTrue traffic. This is
  the observed behavior; treat it as strong empirical evidence, not a formal
  scheduling guarantee - a pathological non-yielding operation (a huge in-memory sort
  or a tight WASM loop) could still monopolize the single thread. Statement *outcomes*
  stayed consistent (the 200-increment no-lost-updates test); this is not a proof of
  general serial execution for arbitrary DDL/DML/session-state interactions.
- **An idle-open EXPLICIT transaction DOES freeze every other client.**
  `QueryQueueManager` is transaction-aware: once a `BEGIN` is open on a handler and
  no further statement from that handler is queued, it **stops dispatching anyone
  else's queries** until that handler COMMITs/ROLLBACKs. Verified: with one client
  holding `BEGIN; SELECT 1;` open, a second client's `SELECT 42` blocked until the
  first committed, then unblocked instantly. This is exactly the serialization that
  makes RLS `BEGIN; SET LOCAL role; ...; COMMIT` atomic (existing
  `killswitch-rls-isolation.mjs`), but it is a footgun for the SQL editor: a user who
  runs a **long** `BEGIN; ...; COMMIT` - or pastes a bare `BEGIN;` and forgets to
  commit - **freezes the whole backend** (PostgREST/GoTrue included) for the duration.

**SQL-editor timeout + safety strategy (what this dictates for Studio):**

1. **Do not rely on `statement_timeout` / `?statementTimeoutSecs`.** Do not rely on it
   to cancel a running PGlite query. Treat every submitted query as uninterruptible
   once started.
2. **Guard the *wait* client-side, and label it accurately:** keep
   `PG_QUERY_TIMEOUT_SECS` low (15-30s) so a hung request returns to the user. A
   client-side timeout is **not a rollback or cancel signal** - the underlying query
   keeps running in PGlite until it finishes on its own. The UI must report it as
   "client stopped waiting; the query may still finish and commit," and should
   discourage blind retry of mutating statements (a retry can duplicate a write whose
   original still commits).
3. **Reject (or hard-gate) transaction-control statements in the editor.** A long or
   idle-open `BEGIN...COMMIT` freezes the **entire backend** (PostgREST/GoTrue
   included). "Run autocommit" is not enough by itself - autocommit does not stop a
   user pasting `BEGIN;`. For a shared/multi-user Studio, block bare
   `BEGIN`/`START TRANSACTION` in the editor by default (escape hatch only if truly
   needed); for a single-admin/dev tool a parse-and-warn may suffice. A dangling
   `BEGIN` is eventually rolled back when postgres-meta closes its per-request pool
   (`pglite-socket` handler `detach -> clearTransactionIfNeeded` issues `ROLLBACK`),
   but do not treat a client timeout as an immediate unlock: the backend stays blocked
   until the socket actually detaches, and a long statement *inside* the transaction
   runs to completion first.
4. **Reset session state per submission** (`RESET ROLE; RESET ALL; SET search_path TO
   public` - note `RESET ALL` alone does not clear `SET ROLE`) to contain leak #3.

## What this changes in the Studio plan

- postgres-meta is a **GO** as the introspection + run-SQL engine. No app patch, no
  exotic pool config. Add it as a Cloud Run sidecar pointed at `127.0.0.1:<wire>`.
- The SQL editor's timeout model must be **client-side + advisory**, not
  `statement_timeout`. Write this into the editor now; do not build UI that promises a
  server-enforced query timeout.
- The "Indexes" view should query `pg_indexes` via `POST /query`, not `GET /indexes`.
- The BFF should reset session GUCs (`RESET ROLE; RESET ALL; SET search_path TO
  public`) around SQL-editor submissions.
- Blast radius appears better than feared in the tested paths: long autocommit
  queries (read *and* write) did not freeze concurrent clients. The demonstrated
  global-freeze hazard is **explicit transactions** (idle-open or long-running), so
  the editor should reject or hard-gate transaction-control statements rather than
  merely warn.

## Reproduce

```bash
# Docker running:
node examples/cloudrun/supabase/test/killswitch-pgmeta.mjs
# or against an already-running postgres-meta (skips Docker):
PG_META_URL=http://127.0.0.1:8080 node examples/cloudrun/supabase/test/killswitch-pgmeta.mjs
```
