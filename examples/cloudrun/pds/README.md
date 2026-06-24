# cocoon (AT Protocol PDS) on zeropg, Cloud Run

A scale-to-zero AT Protocol Personal Data Server: [cocoon](https://github.com/haileyok/cocoon)
(Go) backed by zeropg (PGlite + Postgres wire, datadir shipped to GCS).

## Why cocoon (and why not rsky)

Both candidates use Postgres, but the zeropg wire multiplexes every TCP
connection onto ONE PGlite session, so a driver that uses **named** server-side
prepared statements collides on `42P05 "prepared statement already exists"`
(the pgBouncer-transaction-mode problem; see
`../../../docs/TODO-pglite-socket-prepared-statements.md`).

- **rsky-pds (Rust)**: Postgres via **Diesel**, which uses named prepared
  statements with a per-connection cache and exposes no way to disable it via the
  URL. BLOCKED, same class as sqlx. Not built.
- **cocoon (Go)**: Postgres via GORM + **jackc/pgx v5**. pgx's default
  `cache_statement` mode would collide too, but pgx honors `default_query_exec_mode`
  as a **DSN parameter**, and cocoon opens GORM with the plain DSN
  (`postgres.Open(databaseURL)`). Setting
  `?default_query_exec_mode=simple_protocol` makes pgx use the simple protocol
  (no named prepared statements) with **no app patch**. VIABLE, built here.

## Data durability

cocoon stores everything that matters in the DB when on Postgres:

- `records` table: the AT Proto records.
- `blocks` table: the repo MST/CAR blocks (cocoon's `sqlite_blockstore` is a
  misnomer; it writes to the GORM DB, so on Postgres the repo blocks live in
  Postgres). So the full repo state is in zeropg = shipped to GCS.
- Uploaded media blobs default to the DB too; cocoon also supports S3-interop
  blob storage (`COCOON_S3_BLOBSTORE_ENABLED`) which can point at GCS/R2.

cocoon's own SQLite-to-S3 backup path (`COCOON_S3_BACKUPS_ENABLED`) is unused;
zeropg replaces it by shipping the Postgres datadir to GCS.

## Firehose on scale-to-zero

cocoon does NOT hold an outbound firehose connection. On boot it fires ONE
best-effort `requestCrawl` goroutine (an outbound "come crawl me" POST per
configured relay), logs any error, and moves on. With `COCOON_RELAYS=""` that one
attempt is a harmless no-op. Its `subscribeRepos` firehose is a server endpoint
that relays connect TO, so nothing keeps a scaled-to-zero instance warm.

## Account-creation caveat

cocoon hardcodes `https://plc.directory` (server.go) and POSTs the genesis op
there, so creating an account needs outbound internet and registers a real
`did:plc`. Record write/read and reads of existing accounts need no external
infra, so cold-start of an existing PDS is fully self-contained.

## Signups are invite-gated (public PDSs get spammed)

`COCOON_REQUIRE_INVITE=true`, so `com.atproto.server.createAccount` rejects an
empty/invalid `inviteCode` with `InvalidInviteCode` (verified live: no code -> 400,
bogus code -> 400, valid minted code -> 200 with a real `did:plc` + `accessJwt`).

The admin password and session secret are **not** in this repo - they live in
Google Secret Manager (`cocoon-admin-password`, `cocoon-session-secret`) and the
service references them via `valueFrom.secretKeyRef`; the Cloud Run runtime SA has
`roles/secretmanager.secretAccessor` on them. Mint an invite code (admin Basic auth):

```
PW=$(gcloud secrets versions access latest --secret cocoon-admin-password --project blob-pglite)
curl -s -u "admin:$PW" -X POST -H 'content-type: application/json' \
  https://cocoon-pds-zeropg-71428757273.europe-west1.run.app/xrpc/com.atproto.server.createInviteCode \
  -d '{"useCount":5}'
```

The returned code is written to `INVITE-CODE.local.txt` (gitignored) for live
testing - it is never committed. To verify the gate yourself, hit
`com.atproto.server.describeServer` and check `inviteCodeRequired: true`.

## Cold start (the headline metric)

Measured from the Cloud Run boot timeline of a fresh instance that restored the
DB from GCS (snapshot 4.92MiB + WAL):

| phase                                   | cumulative |
|-----------------------------------------|------------|
| instance start -> zeropg restore + wire up | 0.90s   |
| -> db /healthz startup probe ok          | 3.41s     |
| -> cocoon connected to Postgres          | 3.81s     |
| -> cocoon SERVING (app port 8080 up)     | **~5.0s** |

So end-to-end cold boot to serving is **~5 seconds**, of which the zeropg
restore-from-GCS is under 1s and cocoon's own boot ~1.6s. This is faster than
PrivateBin (~7s) and far faster than NocoDB (~28s).

## Layout

- `Dockerfile` — thin overlay on `cocoon-pds:latest` (built from cocoon by Cloud
  Build) that bakes in throwaway rotation/JWK keys -> `cocoon-pds-keyed:latest`.
- `keys/` — throwaway demo keys (do NOT reuse; they only control this demo's did:plc).
- `service.yaml` — multi-container Cloud Run service: `app` (cocoon) + `db`
  (`zeropg-db-sidecar`), shared localhost, maxScale 1, scale-to-zero.
- `local/wire.mjs` — local `serveWire` for testing cocoon against zeropg without GCS.

## Deploy

```
# base image (cocoon) via Cloud Build, then the keyed overlay:
gcloud builds submit --project blob-pglite --region europe-west1 \
  --config /tmp/cocoon-cloudbuild.yaml <cocoon-source>
docker build --platform linux/amd64 \
  --build-arg BASE=europe-west1-docker.pkg.dev/blob-pglite/zeropg/cocoon-pds:latest \
  -t europe-west1-docker.pkg.dev/blob-pglite/zeropg/cocoon-pds-keyed:latest .
docker push europe-west1-docker.pkg.dev/blob-pglite/zeropg/cocoon-pds-keyed:latest
gcloud run services replace service.yaml --project blob-pglite --region europe-west1
gcloud run services add-iam-policy-binding cocoon-pds-zeropg \
  --project blob-pglite --region europe-west1 --member=allUsers --role=roles/run.invoker
```

Live URL: https://cocoon-pds-zeropg-71428757273.europe-west1.run.app
