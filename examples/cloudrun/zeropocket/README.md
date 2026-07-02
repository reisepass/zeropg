# zeropocket — a PocketBase-style backend on zeropg (scale-to-zero Postgres)

> **zeropocket is NOT PocketBase.** It is an independent Go program that reproduces the
> PocketBase *pattern* (collections, records, typed fields, a record query API,
> email/password auth, an admin UI) on **zeropg** instead of SQLite. It shares no code
> with PocketBase. See "Why this is a re-implementation, not a PocketBase fork" below.

A fast-booting, [PocketBase](https://pocketbase.io)-**style** backend running on **zeropg**:
real Postgres (PGlite over the pglite-socket wire) with its datadir in a GCS bucket, on
Cloud Run, scaled to **zero** — in one static Go binary with an embedded admin SPA.

**Features**
- **Collections** = real Postgres tables, with **typed fields**: text, number, bool,
  email, url, date, **select** (allowed values), **relation** (FK to another collection),
  json. Per-type validation (required, email/url format, select membership, relation
  integrity).
- **Records REST API** with **list/search/filter + sort + pagination**
  (`?filter=votes > 10`, `?sort=-created,title`, `?page&perPage`).
- **Email/password auth + JWT** (HS256, bcrypt), a **user-management** view, and a basic
  **API access rule** per collection (`public` read vs `auth`-only).
- A **PocketBase-styled admin SPA** (dark sidebar, collections list, clean data-table,
  auth pages) — vanilla JS, no build step, **served from memory with zero DB on first
  paint** for an instant cold render.
- **Data retention on by default** (this is public with open registration): per-collection
  newest-N cap, age TTL, global cap, per-account cap, user/collection caps — all enforced
  **lazily/inline** (prune-on-insert + throttled sweep), never a background worker, so the
  instance still scales to zero.

**Live:** https://pocketbase-scale-to-zero.0rs.org  (run.app:
https://pocketbase-scale-to-zero-71428757273.europe-west1.run.app)

> The Cloud Run service/domain are still named `pocketbase-*` for infra continuity, but the
> app, module, and UI are all branded **zeropocket** — it is not affiliated with PocketBase.

## Why this is a re-implementation, not a PocketBase fork

The kill-switch question was: can PocketBase itself be pointed at Postgres/zeropg? The
answer is **no, not within a sane budget**, so this is path **(b) build-minimal**, not
**(a) fork**. PocketBase is hard-coupled to SQLite in exactly the code that *is* the
product:

- **The filter/query core emits SQLite JSON SQL.** `record_field_resolver_runner.go`
  (~850 lines), `tools/dbutils/json.go`, and `tools/search/simple_field_resolver.go`
  generate `json_extract([[col]], '$.path')`, `json_each(...)`, `json_valid`, `json_type`,
  `json_array`, `json_object`, and `iif()` — all SQLite dialect. Postgres uses entirely
  different operators (`->`, `->>`, `jsonb_array_elements`, `jsonb_array_length`, no
  `iif`). The `CASE WHEN json_valid(...)` wrappers exist *because* SQLite is dynamically
  typed; Postgres is not, so they don't translate, they have to be re-thought.
- **Schema sync is SQLite-shaped.** `core/collection_record_table_sync.go` reads
  `sqlite_master`, runs `PRAGMA optimize`, and relies on SQLite's loose typing and
  ALTER-via-table-rewrite semantics.
- It embeds `modernc.org/sqlite` and assumes a **local embedded DB file** with dual
  `data.db`/`auxiliary.db` WAL connection pools.
- The **upstream maintainer has stated there are no plans** to support other SQL dialects
  ([discussion #6540](https://github.com/pocketbase/pocketbase/discussions/6540)), so a
  fork is a permanent, unmaintained divergence that must be re-merged on every release.
  Community Postgres forks exist but target old versions and are partial.

Forking would be a semantic compiler rewrite of PocketBase's heart plus a forever
merge-debt — for a demo whose only goal is *"does this class of backend run on zeropg, and
does it cold-start fast?"*. A cross-model review (GPT-5.5 + Gemini) independently agreed
at 9/10. So instead this binary reproduces the **PocketBase pattern** directly on the
zeropg Postgres wire via `pgx`. A static Go binary boots fast either way — which is the
whole point of a scale-to-zero demo.

## The prepared-statement wall

zeropg is a single-session PGlite; **named** server-side prepared statements collide
(error `42P05`). The DSN uses `default_query_exec_mode=cache_describe`:

```
postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable&default_query_exec_mode=cache_describe&pool_max_conns=4
```

`cache_describe` makes `pgx` use the extended protocol with a cached DESCRIBE and **no
persisted named statements** — so no `42P05` — and, unlike `simple_protocol`, it encodes
JSONB correctly. `pool_max_conns>1` so concurrent requests don't serialize. **No driver
patching**; the compatibility is entirely in the DSN. (See `docs/POSTGRES-APP-COMPAT.md`.)

## Architecture: instant UI + background wake

Following the zeropg split-frontend pattern, *within one binary*:

- The **admin UI is embedded and served from memory with zero DB access**, so the page
  renders instantly on a cold Cloud Run wake (`GET /` → 13 KB HTML, no DB).
- On load the page fires a **fire-and-forget `POST /api/wake`** so the backend warms the
  DB pool during user think-time, and polls `GET /api/health` for a status pill. Data API
  calls block on DB readiness; the UI never does.
- The **DB pool opens lazily in a background goroutine** and ensures the system schema
  once; the app starts listening in ~4 ms regardless.

Two co-located containers in one Cloud Run service (`minScale=0`, `maxScale=1`,
container-dependencies so `app` waits for `db`):

- **`app`** — this Go binary (HTTP ingress, serves the Cloud Run port).
- **`db`** — the `zeropg-db-sidecar` (PGlite + Postgres wire on `127.0.0.1:5432` +
  GCS persistence). Shared localhost. Scales to zero together; the HTTP request is the wake.

## Data model

Each collection is a **real physical Postgres table** (`rec_<name>`) with one typed column
per declared field — `text`/`email`/`url`/`select`/`relation` → `text`, `number` →
`double precision`, `bool` → `boolean`, `date` → `timestamptz`, `json` → `jsonb` — plus
`id text PRIMARY KEY`, `owner text` (the creating account), `created`, `updated`, and a
`created DESC` index (used by the default sort and newest-N retention). Collection metadata
(fields + `list_rule`) lives in `_collections`; users in `_users` (bcrypt). So it exercises
real Postgres DDL, typed columns, `RETURNING`, and `pg_advisory_xact_lock` (used to
serialize schema mutations) over the zeropg wire — not an opaque jsonb blob.

## REST API (PocketBase-style routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | – | create user, returns JWT (subject to the user cap) |
| POST | `/api/auth/login` | – | returns JWT |
| GET | `/api/auth/me` | Bearer | current user |
| GET | `/api/users` | Bearer | list users (management view) |
| DELETE | `/api/users/{id}` | Bearer | delete a user (not yourself) |
| GET | `/api/collections` | Bearer | list collections (+ record counts) |
| POST | `/api/collections` | Bearer | create collection (+ its table) |
| PATCH | `/api/collections/{name}` | Bearer | set the `list_rule` (`public`/`auth`) |
| DELETE | `/api/collections/{name}` | Bearer | drop collection (blocked if relation-referenced) |
| GET | `/api/collections/{name}/records` | rule | list: `?filter` `?sort` `?page` `?perPage` |
| POST | `/api/collections/{name}/records` | Bearer | create record |
| GET | `/api/collections/{name}/records/{id}` | rule | get record |
| PATCH | `/api/collections/{name}/records/{id}` | Bearer | update record |
| DELETE | `/api/collections/{name}/records/{id}` | Bearer | delete record |
| GET | `/api/settings` | – | backend info + active retention policy |
| GET | `/livez` | – | liveness, no DB (NOT `/healthz` — Cloud Run's edge reserves that) |
| GET | `/api/health` | – | DB readiness: `warming` / `ready` / `error` |
| POST | `/api/wake` | – | fire-and-forget cold-start nudge |

"Auth = rule" means read access is governed by the collection's `list_rule`: `public`
collections are readable without a token, `auth` collections require one.

### Filter + sort

`filter` is a single safe expression `<field> <op> <value>`, op ∈ `= != > >= < <= ~ !~`
(`~`/`!~` = case-insensitive substring on text fields). Field names are **whitelisted
against the collection schema** and values are **always bound parameters** — no SQL
injection. `sort` is a comma list with `-` for DESC, e.g. `-created,title`.

### Quick curl

```bash
B=https://pocketbase-scale-to-zero.0rs.org
TOK=$(curl -s -X POST $B/api/auth/register -d '{"email":"me@example.com","password":"hunter2"}' | jq -r .token)
curl -s -X POST $B/api/collections -H "Authorization: Bearer $TOK" \
  -d '{"name":"tasks","list_rule":"public","fields":[
        {"name":"title","type":"text","required":true},
        {"name":"priority","type":"select","options":["low","high"]},
        {"name":"done","type":"bool"}]}'
curl -s -X POST $B/api/collections/tasks/records -H "Authorization: Bearer $TOK" \
  -d '{"title":"ship it","priority":"high","done":false}'
# filter + sort (public read — no token needed since list_rule=public)
curl -s "$B/api/collections/tasks/records?filter=priority%20=%20high&sort=-created"
```

## Data retention (on by default)

This runs on the public internet with open registration, so retention is **ON by default**
to keep the GCS-backed disk bounded. Every limit is env-configurable; all enforcement is
**lazy/inline** — there is **no background worker or cron**, so the instance still scales to
zero. Pruning happens prune-on-insert (the per-collection newest-N cap, applied immediately
after each insert) plus a cheap **throttled sweep** (≤ once / 60s, on a read request) for
the age TTL and global cap.

| Env var | Default | Meaning |
|---|---|---|
| `RETENTION_PER_COLLECTION_MAX` | `500` | keep only the newest N records per collection |
| `RETENTION_MAX_AGE_DAYS` | `30` | delete records older than this |
| `RETENTION_GLOBAL_MAX` | `20000` | hard cap on total records across all collections |
| `RETENTION_PER_ACCOUNT_MAX` | `1000` | max records a single account may own |
| `RETENTION_MAX_USERS` | `5000` | registration closes past this many users |
| `RETENTION_MAX_COLLECTIONS` | `100` | cap on number of collections |

Set any to `0` to disable that policy. The caps are abuse *guards* on a single-writer
(`maxScale=1`), single-session PGlite instance: a check-then-insert can overshoot by at most
the in-flight concurrency (≤ pool size), which is fine for bounding disk. Schema mutations
(collection create/delete) are serialized with a transaction advisory lock so relation
fields can't be left dangling.

## Build, deploy, test

```bash
# build + push the app image
gcloud builds submit --project blob-pglite --region europe-west1 \
  --tag europe-west1-docker.pkg.dev/blob-pglite/zeropg/pocketbase-zeropg:latest .

# deploy (service.yaml pins the app image by digest; db sidecar is zeropg-db-sidecar)
gcloud run services replace service.yaml --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding pocketbase-scale-to-zero \
  --project blob-pglite --region europe-west1 --member=allUsers --role=roles/run.invoker

# local end-to-end (needs a local zeropg wire on :5602 — see examples/cloudrun/pds/local/wire.mjs)
WIRE_PORT=5602 npx tsx ../pds/local/wire.mjs &
PORT=8087 DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5602/postgres?sslmode=disable&default_query_exec_mode=cache_describe&pool_max_conns=4" \
  go run ./app
# drive the UI headless (Playwright):
BASE=http://localhost:8087 node ui-smoke.mjs
```

## Cold start

`app` is a fully static, stripped, CGO-free Go binary on `distroless/static` (tiny image
→ fast pull). It listens in **~4 ms** and reaches DB-ready in tens of ms against a warm
wire. The real cold-start cost on Cloud Run is dominated by the **`db` sidecar restoring
the datadir from GCS**, not by this binary. See the parent demo notes for the measured
clean-idle cold-start number (hit once after ~20 min idle; <2 s means it was still warm
and is invalid).

## Files

- `app/main.go` — the whole backend: auth/JWT, collections + typed fields, records with
  filter/sort/pagination, users, settings, and all retention enforcement.
- `app/web/index.html` — the embedded admin SPA (vanilla JS, no build; instant paint,
  wake-on-load, hash-router so every view has a URL).
- `Dockerfile` — multi-stage; distroless static final image.
- `service.yaml` — two-container Cloud Run service (`app` + `db` sidecar), scale-to-zero.
- `ui-smoke.mjs` — Playwright end-to-end UI test (login → collection → records → filter →
  users → settings → deep-link).
- `reference/` — a **gitignored** clone of PocketBase, used only to study its UI/feature set.
