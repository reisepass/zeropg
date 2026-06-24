# airtable-on-zeropg — a minimal Airtable/NocoDB-style app, built tiny + fast

A self-hosted spreadsheet-database (a "base" with tables; each table has typed
columns and rows; a grid UI to create tables/columns and edit cells) running on
**zeropg** — real Postgres (PGlite over the pglite-socket wire), datadir shipped
to GCS, scale-to-zero on Cloud Run.

The point is the **opposite of NocoDB**. NocoDB self-bootstraps **124 metadata
tables** and cold-starts in **~28s**. This app is deliberately tiny: a **fixed
3-table schema**, **no runtime DDL**, a **single static Go binary** for the
backend and a **single static Go binary** serving a no-build vanilla-JS SPA for
the frontend.

Live: **https://airtable-scale-to-zero.0rs.org**

## What it does

- Create/delete tables in a base.
- Add typed columns: **text, number, checkbox (bool), date, single-select**
  (with a fixed choice list).
- Add/delete rows; edit cells inline in a grid. Values are validated and
  canonicalised server-side per column type before they hit the DB.
- Everything persists to the GCS-backed PGlite and survives a cold restart.

## Language: Go (and why)

Go gives a **single static binary** (distroless/scratch image) that boots in
**~130ms locally** — there is no runtime, no framework, no migration engine to
warm up. That is the whole game here: minimalism and fast boot are the priority,
and Go's cold-start floor is far below Node's. The frontend is *also* a tiny Go
static server (no Node, no bundler) so the frontend service boots near-instantly
too.

## The data model: rows-as-JSONB (NOT table-per-user-table)

Three fixed tables, created once with idempotent `CREATE TABLE IF NOT EXISTS`
(no migration framework, no advisory locks):

```
tbl(id, base_id, name, position, created_at)              -- a user "table"
col(id, tbl_id, name, type, position, opts jsonb)          -- a typed column
rec(id, tbl_id, data jsonb, created_at, updated_at, version) -- a row
```

Cell values live in `rec.data`, keyed by column id. A user creating a table or
adding a column is **pure metadata writes** — never DDL.

**Why JSONB-rows over a physical table per user-table:** on the single-session
zeropg wire, runtime DDL is operationally toxic even though it is technically
supported. Every user "add column" / "create table" would become catalog churn
on an already-serialized session, with awkward lock/atomicity behavior between
the app's metadata and the physical schema. The fixed-schema JSONB design keeps
boot **deterministic** and the migration **three statements**. The tradeoff
(no native per-column typing/constraints/typed indexes; filtering/sorting is a
JSONB expression) is fine for a grid demo, and we keep JSONB sortable by
**validating + canonicalising every cell value app-side** before storing it, so
a malformed value can never poison a typed query.

## The prepared-statement wall

The zeropg wire is a single PGlite session; drivers using **named** server-side
prepared statements collide with `42P05`. This app uses **pgx v5** with DSN
param **`default_query_exec_mode=cache_describe`** — the extended protocol with a
cached column-type DESCRIBE but **no persisted named statements**, so nothing
collides. (`simple_protocol` is avoided: it mis-infers JSONB column types.) The
pool is **4** (must be `>1`; a pool of 1 can deadlock); the wire serializes onto
one session regardless, so 4 is plenty. JSONB params are written with explicit
`$n::jsonb` casts and `jsonb_set(data, ARRAY[$k]::text[], $v::jsonb, true)`;
clearing a cell is `data - $key` so rows stay sparse.

**Write semantics:** interactive cell edits **wait for commit** and return the
persisted row + a bumped `version`. We never ACK a write before it commits, so
the grid never shows a value that later "snaps back" behind the single-session
commit queue.

## The split-frontend + wake trick

The frontend is its **own Cloud Run service**, separate from the backend, serving
a static SPA shell that renders **immediately** without the backend. Two wakes
fire the backend cold-start in parallel, behind user think-time:

1. **At the frontend container entrypoint** (`entrypoint.sh`), a server-side
   fire-and-forget `wget .../wake` the instant the frontend instance comes up —
   even before any browser loads.
2. **In the browser on load** (`app.js`), `fetch(API + '/wake')` as the very
   first action, result ignored, before any data call.

`/wake` is intentionally boring (a cheap `SELECT 1`/ping, no migrations, no
metadata load) so it never queues behind heavy work on the single session. Data
calls are deferred until the user opens a table. The wake's failure never blocks
the UI; if the backend is still cold, the app retries shortly.

## Cold start (the headline metric)

Measured on **real Cloud Run** with the clean-idle method (services left fully
untouched ~22 min so the scale-to-zero idle timer fully expires, then hit once,
timed):

| measurement                                              | time     |
|----------------------------------------------------------|----------|
| frontend `GET /` (tiny static Go binary, cold)           | _PENDING_ |
| backend `GET /wake` (app + zeropg-db sidecar + GCS restore), cold | _PENDING_ |
| backend `GET /wake`, warm (immediately after)            | _PENDING_ |
| backend binary boot-to-`/healthz`, local docker sanity   | ~0.13s   |

## Layout

- `backend/` — Go (`net/http` + pgx v5) backend. `main.go` is the whole app
  (~500 LOC): schema init, the JSONB CRUD API, per-type cell validation, `/wake`.
  `Dockerfile` builds a distroless static image. `service.yaml` is the
  multi-container Cloud Run service: `app` + the `zeropg-db-sidecar`, shared
  localhost, maxScale 1, scale-to-zero.
- `frontend/` — `index.html` + `app.js` (no build step) served by a tiny Go
  static server (`server.go`) that also synthesises `/config.js` from
  `AIRTABLE_API`. `entrypoint.sh` fires the server-side wake. Its own
  `service.yaml` is a separate, near-instant-boot Cloud Run service.

## API

```
GET    /api/tables                       list tables
POST   /api/tables            {name}      create table (seeds Name, Notes cols)
DELETE /api/tables/{id}                   delete table + its rows
GET    /api/tables/{id}/columns           list columns
POST   /api/tables/{id}/columns {name,type,opts}  add a typed column
DELETE /api/columns/{id}                  delete column (strips its cell data)
GET    /api/tables/{id}/rows[?limit]      list rows
POST   /api/tables/{id}/rows  {data}      create a row (validated)
PATCH  /api/rows/{id}         {col_id,value}  edit one cell (waits for commit)
DELETE /api/rows/{id}                     delete a row
GET    /wake                              cheap cold-start trigger
GET    /healthz                           liveness
```

## Deploy

```
# backend image + service (co-located with the zeropg-db sidecar)
docker buildx build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/blob-pglite/zeropg/airtable-backend:latest --push backend
gcloud run services replace backend/service.yaml --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding airtable-zeropg \
  --project blob-pglite --region europe-west1 --member=allUsers --role=roles/run.invoker

# frontend image + service (separate, near-instant-boot)
docker buildx build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/blob-pglite/zeropg/airtable-frontend:latest --push frontend
gcloud run services replace frontend/service.yaml --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding airtable-frontend \
  --project blob-pglite --region europe-west1 --member=allUsers --role=roles/run.invoker

# nice URL (free Cloud Run domain mapping on 0rs.org)
gcloud dns record-sets create airtable-scale-to-zero.0rs.org. --project peerbench \
  --zone zone-0rs-org --type CNAME --ttl 300 --rrdatas ghs.googlehosted.com.
gcloud beta run domain-mappings create --service airtable-frontend \
  --domain airtable-scale-to-zero.0rs.org --project blob-pglite --region europe-west1
```

## Local dev

Run a bare PGlite wire (the `zeropg-db` sidecar without GCS) and point the
backend at it:

```
# wire (maxConnections must be >1, matching the real sidecar's 100):
node -e "import('@electric-sql/pglite').then(async({PGlite})=>{const{PGLiteSocketServer}=await import('@electric-sql/pglite-socket');const db=await PGlite.create({dataDir:'./data'});await new PGLiteSocketServer({db,port:5432,host:'127.0.0.1',maxConnections:100}).start()})"
# backend:
cd backend && DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable&default_query_exec_mode=cache_describe' go run .
# frontend:
cd frontend && AIRTABLE_API=http://127.0.0.1:8080 STATIC_DIR=$PWD go run .
```

Live URL: https://airtable-scale-to-zero.0rs.org
