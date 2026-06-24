# httpbin + requestbin on zeropg (Cloud Run, scale-to-zero)

Our OWN minimal httpbin + requestbin, built from scratch and optimized for the
**fastest cold start of all the zeropg demos** (tiny app, tiny schema). We
rejected the off-the-shelf options: request-baskets is unmaintained (2yr no
commits), webhook-tester has no Postgres, webhookx needs Redis, go-httpbin is
stateless. This is ~600 lines of plain Node with one runtime dependency (`pg`).

Live:
- **UI**: https://httpbin-ui-scale-to-zero.0rs.org
- **Backend / capture + echo**: https://httpbin-scale-to-zero.0rs.org

## What it does

**(a) httpbin echo** — pure, stateless, never touches the DB:
`/get` `/post` `/put` `/anything` `/headers` `/ip` `/user-agent` `/json` `/uuid`
`/status/:code` `/delay/:n` (delay capped at 10s).

**(b) requestbin** — send ANY method to `https://<backend>/b/:binId[/any/path]` and
the full request (method, path, query, headers as JSONB, body, remote ip, ts) is
captured into the zeropg Postgres. Bin ids are client-generatable
(`[A-Za-z0-9_-]{1,64}`); `GET /api/bins/new` mints one. Inspect via:
- `GET /api/bins/:binId/requests?limit=N` (default 50, max 500)
- `GET /api/bins/:binId/requests/:id`

**(c) temporary history (TTL)** — bounded WITHOUT a background worker, so the
instance still scales to zero (see below).

**(d) pipedream-style forward** — `POST /api/bins/:binId/config {"forward_url":"https://..."}`.
When a request hits that bin, it's forwarded to the configured URL. The forward
is **awaited with a 1.5s timeout** inside the request (so Cloud Run's
request-scoped CPU is still allocated) rather than fired-and-forgotten after the
response, which would be unreliable when the instance freezes.

## Architecture

```
              httpbin-ui-zeropg                         httpbin-zeropg
          (static UI, no DB, its own        ┌──────────────────────────────────┐
           Cloud Run service)               │  app (Node, pg)  ──localhost:5432─▶ db sidecar
   browser ───────────────▶ renders         │  ingress :8080                    │  (zeropg: PGlite +
           │ on load: fire-and-forget        │                                   │   GCS persistence)
           └── wake ─────────────────────────▶ /healthz  (cold-starts backend    │  scales to zero with app
                                             │            in parallel)            │
                                             └──────────────────────────────────┘
                                                  minScale 0 / maxScale 1
```

**Split frontend.** The UI is its OWN Cloud Run service with no DB and no heavy
deps, so it renders instantly even when the backend is scaled to zero. On page
load it fires a client-side `fetch(BACKEND + '/healthz', {mode:'no-cors'})` —
a fire-and-forget WAKE — so the backend cold-starts in parallel while the user
reads/clicks. Bin views are bookmarkable (`?bin=<id>`).

**Why Node, not Go.** The zeropg `db` sidecar is already Node and `pg`
(node-postgres) is known-good over the single-session PGlite wire (no 42P05 —
`pg` only uses named prepared statements when you pass a `name`, and we never
do). A single dependency-light Node process boots in well under a second; the
language was not the cold-start lever here (the DB restore is). Go/pgx would add
prepared-statement-config risk for no measured benefit. The app uses
`Pool({ max: 1 })` because the wire is single-session — pretending to be
concurrent only invites query serialization surprises.

## TTL / auto-delete — and why it does NOT block scale-to-zero

There is **no cron, no setInterval, no background goroutine**. All cleanup rides
on real inbound requests (capture + read), so nothing holds an HTTP request open
and the instance scales to zero normally. Two mechanisms:

1. **Per-bin cap (every capture, cheap).** After insert we keep only the last
   `MAX_PER_BIN` (200) per bin via an index-backed id cutoff — `SELECT id ...
   ORDER BY id DESC OFFSET 200 LIMIT 1`, then `DELETE WHERE id <= cutoff`. No
   `NOT IN`, no full sort per row; backed by `(bin_id, id DESC)`.

2. **Global TTL sweep (opportunistic, rate-limited in the DB).** A
   `maintenance_state(key, last_run)` row gates a `DELETE FROM captures WHERE ts
   < now() - 24h`. The claim is atomic — `INSERT ... ON CONFLICT DO UPDATE SET
   last_run = now() WHERE last_run < now() - SWEEP_EVERY_MS` returning a row only
   to the one caller who wins the window — so the expensive delete runs at most
   once every 5 minutes no matter the traffic, and it's correct across instance
   restarts (the gate lives in Postgres, not in process memory).

Verified locally: a backdated 48h-old row is deleted the next time any request
triggers the sweep, and `last_run` advances so it won't re-sweep until the window
reopens. The per-bin cap was verified to keep exactly the last N.

Bounds against abuse: body capped at `MAX_BODY_BYTES` (256 KiB, oversized
uploads are truncated with `body_truncated=true`, binary stored base64 with
`body_encoding`), plus `requestTimeout`/`headersTimeout`/`keepAliveTimeout` on
the Node server.

## Schema (created lazily by the app, no extensions)

```sql
captures(id bigserial pk, bin_id text, method, path, query, headers jsonb,
         body text, body_encoding text, body_truncated bool, remote_ip text, ts timestamptz)
  index (bin_id, id DESC); index (ts)
bins(bin_id text pk, forward_url text, created_at timestamptz)
maintenance_state(key text pk, last_run timestamptz)
```

Stateless httpbin routes do NOT wait on schema init; only requestbin routes
lazily ensure it, so a cold boot answers `/get` the instant the process is up.

## CORS

The split frontend is a separate origin, so its browser calls to the API are
cross-origin. The backend returns `access-control-allow-*: *` and answers
preflight `OPTIONS` (this is already a public, send-from-anywhere service, so a
wildcard adds no exposure). A true browser preflight is answered and NOT captured.

## Build & deploy

```sh
# backend app image
cd app && docker buildx build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/blob-pglite/zeropg/httpbin-app:latest --push .
# frontend UI image
cd ../frontend && docker buildx build --platform linux/amd64 \
  -t europe-west1-docker.pkg.dev/blob-pglite/zeropg/httpbin-ui:latest --push .

gcloud run services replace service.yaml --project blob-pglite --region europe-west1
gcloud run services replace frontend/service.yaml --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding httpbin-zeropg    --member=allUsers --role=roles/run.invoker --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding httpbin-ui-zeropg --member=allUsers --role=roles/run.invoker --project blob-pglite --region europe-west1
```

## Local dev

```sh
# from the zeropg repo root
WIRE_PORT=5610 npx tsx examples/cloudrun/httpbin/local/wire.mjs   # zeropg wire (no GCS)
PGPORT=5610 node examples/cloudrun/httpbin/app/server.mjs          # backend on :8080
BACKEND_URL=http://127.0.0.1:8080 PORT=8090 node examples/cloudrun/httpbin/frontend/server.mjs  # UI on :8090
```

## Verify

```sh
BE=https://httpbin-scale-to-zero.0rs.org
curl -s $BE/get
curl -s -X POST "$BE/b/demo/webhook?src=stripe" -d '{"event":"payment.succeeded"}'
curl -s "$BE/api/bins/demo/requests"
```
