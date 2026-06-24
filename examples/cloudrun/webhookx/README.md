# webhookx on zeropg + Dragonfly (Cloud Run, scale-to-zero)

[webhookx](https://github.com/webhookx-io/webhookx) is a Go webhook gateway that
requires **PostgreSQL (>=13)** and **Redis (>=6.2)**. This example runs it on
Cloud Run with:

- **app** — webhookx v1.1.0 (ingress = the proxy / webhook receiver on the Cloud Run port)
- **db** — the GCS-backed, scale-to-zero zeropg Postgres sidecar (`localhost:5432`)
- **dragonfly** — a Redis-compatible sidecar (`localhost:6379`) for the delivery/ingest queues

`minScale:0 / maxScale:1`. All three containers scale to zero together; the next
inbound webhook HTTP request wakes the instance (the wake is what makes a
"needs-Redis" app viable on scale-to-zero — the Redis sidecar boots with the app).

## Why it works on the single-session zeropg wire

| Concern | Resolution |
| --- | --- |
| Driver / `42P05` named-prepared-statement wall | webhookx uses `sql.Open("pgx", …)` (pgx **stdlib**, database/sql) wrapped by Go `jmoiron/sqlx`. Setting `default_query_exec_mode=cache_describe` in the DSN avoids persisted named prepared statements (no `42P05`) **and** keeps correct JSONB encoding. **Do not use `simple_protocol`** — it can't infer column types, so JSONB columns fed a `[]byte` (`entity.Value() => json.Marshal`) are sent as a bytea hex literal and rejected with `22P02 invalid input syntax for type json`. |
| Connection pool | `WEBHOOKX_DATABASE_MAX_POOL_SIZE=4`. Must be **> 1**: webhookx's migrator holds the advisory-lock connection across `client.Up()` while `initDefaultWorkspace()` needs a second connection from the same pool — pool=1 deadlocks. The zeropg wire accepts up to 10 concurrent connections. |
| Migrations | `webhookx db up` (golang-migrate). Uses `pg_advisory_lock` + `FOR UPDATE SKIP LOCKED`, both supported by PGlite. No `CREATE EXTENSION` needed (core types only). The entrypoint runs it, idempotently, before `webhookx start`. |
| Worker / scale-to-zero | The delivery worker is a background goroutine (1s non-blocking Redis poll + 60s Postgres `loadPending`). It holds no inbound HTTP request, so it does **not** prevent Cloud Run scale-to-zero. |
| Redis durability | **Ephemeral Dragonfly** (no snapshot). Event + Attempt rows are written to zeropg (durable in GCS) **before** tasks hit Redis; on a cold boot the worker's `loadPending` rebuilds the queue from `attempts.status='INIT'`. The queue is a derived cache. |
| LISTEN/NOTIFY | webhookx's eventbus uses Postgres `LISTEN/NOTIFY` for **cross-instance** fanout. PGlite does not propagate NOTIFY across wire connections, but at `maxScale:1` delivery uses the in-process channel + the 1s ticker, so this is irrelevant. |

## Delivery semantics under scale-to-zero

Delivery is **at-least-once / eventually-consistent**. An ingested event is
persisted (Event + Attempt rows) synchronously and a task is queued; the actual
outbound HTTP delivery happens in the background worker. If the instance scales
to zero before the worker drains, the attempt stays `INIT` in Postgres and is
re-delivered by `loadPending` on the next wake. For latency-sensitive delivery,
set `minScale:1`.

## Build & deploy

```sh
# app image (builds webhookx from source at v1.1.0)
docker buildx build --platform linux/amd64 --build-arg WEBHOOKX_REF=v1.1.0 \
  -t europe-west1-docker.pkg.dev/blob-pglite/zeropg/webhookx-app:latest --push .

# Dragonfly is mirrored into Artifact Registry as .../zeropg/dragonfly:latest
# (upstream ghcr.io/dragonflydb/dragonfly:latest is not on Docker Hub).

gcloud run services replace service.yaml --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding webhookx-zeropg \
  --project blob-pglite --region europe-west1 \
  --member=allUsers --role=roles/run.invoker
```

The `allUsers` invoker makes the webhook ingress public. For a real deployment,
configure webhookx source authentication / signature validation (and consider rate
limiting) on the source — the unauthenticated demo `/ingest` source here is only
for a disposable example. The admin API stays on loopback (`127.0.0.1:9601`) and is
never routed by Cloud Run.

On boot, **if `WEBHOOKX_DEMO_ENDPOINT_URL` is set**, the entrypoint self-configures
a demo: a source at `POST /ingest` and an endpoint forwarding `demo.ping` events to
that URL (a request-capture service). It is opt-in via that env var — remove it and
use the admin API for a real setup.

## Verify end-to-end

```sh
URL=https://<service-host>
curl -X POST "$URL/ingest" -H 'Content-Type: application/json' \
  -d '{"event_type":"demo.ping","data":{"hello":"zeropg"}}'
# -> 200 {"message":"accepted"} with an X-Webhookx-Event-Id header.
# The event fans out to the endpoint; the Attempt row in zeropg flips to
# SUCCESSFUL (http 200) once the worker delivers.
```
