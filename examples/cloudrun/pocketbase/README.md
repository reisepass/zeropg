# zeropocket — a PocketBase-style backend on zeropg (scale-to-zero Postgres)

A minimal, fast-booting [PocketBase](https://pocketbase.io)-**style** backend running on
**zeropg**: real Postgres (PGlite over the pglite-socket wire) with its datadir in a GCS
bucket, on Cloud Run, scaled to **zero**. Collections/records CRUD + REST API +
email/password auth + JWT + a small embedded admin UI, in one static Go binary.

**Live:** https://pocketbase-scale-to-zero.0rs.org  (run.app:
https://pocketbase-scale-to-zero-71428757273.europe-west1.run.app)

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

Each collection gets a **real physical Postgres table** (`rec_<name>`) with one typed
column per declared field (`text` | `number` → `double precision` | `bool` → `boolean`),
plus `id text PRIMARY KEY`, `created`, `updated`. Collection metadata lives in
`_collections`; users in `_users` (bcrypt). So the demo exercises real Postgres DDL,
typed columns, and `RETURNING` over the zeropg wire — not an opaque jsonb blob.

## REST API (PocketBase-style routes)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | – | create user, returns JWT |
| POST | `/api/auth/login` | – | returns JWT |
| GET | `/api/auth/me` | Bearer | current user |
| GET | `/api/collections` | Bearer | list collections |
| POST | `/api/collections` | Bearer | create collection (+ its table) |
| DELETE | `/api/collections/{name}` | Bearer | drop collection (+ its table) |
| GET | `/api/collections/{name}/records` | Bearer | list records (page/perPage) |
| POST | `/api/collections/{name}/records` | Bearer | create record |
| GET | `/api/collections/{name}/records/{id}` | Bearer | get record |
| PATCH | `/api/collections/{name}/records/{id}` | Bearer | update record |
| DELETE | `/api/collections/{name}/records/{id}` | Bearer | delete record |
| GET | `/livez` | – | liveness, no DB (NOT `/healthz` — Cloud Run's edge reserves that path) |
| GET | `/api/health` | – | DB readiness: `warming` / `ready` / `error` |
| POST | `/api/wake` | – | fire-and-forget cold-start nudge |

### Quick curl

```bash
B=https://pocketbase-scale-to-zero.0rs.org
TOK=$(curl -s -X POST $B/api/auth/register -d '{"email":"me@example.com","password":"hunter2"}' | jq -r .token)
curl -s -X POST $B/api/collections -H "Authorization: Bearer $TOK" \
  -d '{"name":"tasks","fields":[{"name":"title","type":"text"},{"name":"done","type":"bool"}]}'
curl -s -X POST $B/api/collections/tasks/records -H "Authorization: Bearer $TOK" \
  -d '{"title":"ship it","done":false}'
curl -s $B/api/collections/tasks/records -H "Authorization: Bearer $TOK"
```

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

- `app/main.go` — the whole backend (~700 lines): auth/JWT, collections, records, UI serve.
- `app/web/index.html` — embedded admin UI (instant render, wake-on-load).
- `Dockerfile` — multi-stage; distroless static final image.
- `service.yaml` — two-container Cloud Run service (`app` + `db` sidecar), scale-to-zero.
- `ui-smoke.mjs` — Playwright end-to-end UI test.
