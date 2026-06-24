# Stripped Supabase on zeropg (scale-to-zero)

Self-hosted Supabase minus the heavy bits — **PostgREST** (REST API) + **GoTrue**
(auth) — on a Postgres that **scales to zero**. One Cloud Run
multi-container service: when no one is using it, everything (app + auth + db)
sleeps and costs nothing; the first request wakes it and PGlite restores the
database from a GCS bucket. Realtime subscriptions and edge functions are
intentionally excluded.

Live: **https://supabase-scale-to-zero.0rs.org**

```
                       ┌──────────────── one Cloud Run service (minScale=0) ───────────────┐
  browser ── HTTPS ──► │  app (ingress)            auth                  db (sidecar)        │
  supabase-js          │  Node proxy + shell  ──►  GoTrue  ──┐    ┌──►  PGlite + wire :5432  │
                       │  /rest/v1 ─► db /rest                ├─wire┤    + PostgREST (in-proc)│
                       │  /auth/v1 ─► auth                    │     │    (no extensions)      │
                       └─────────────────────────────────────┴─────┴── GCS bucket (durable) ─┘
```

## The hard part: one shared Postgres SESSION

zeropg is PGlite (Postgres-in-WASM) behind `pglite-socket`, which multiplexes
**every** wire connection onto **one** PGlite session. Supabase's services assume
a normal multi-connection Postgres, so three things had to be solved (each has a
kill-switch test under `test/`):

1. **42P05 (named prepared statements collide on the shared session).**
   - PostgREST: `PGRST_DB_PREPARED_STATEMENTS=false` + `PGRST_DB_POOL=1` (already
     built into `@zeropg/server`).
   - GoTrue (Go, gobuffalo/pop on pgx v4): DSN param `statement_cache_mode=describe`
     — pgx DESCRIBEs via the anonymous statement (correct types) but never persists
     a named server-side statement. (pgx-v4 equivalent of v5 `cache_describe`.)
   - `test/killswitch-postgrest.mjs`, `test/killswitch-gotrue.mjs`.

2. **search_path.** `ALTER ROLE/DATABASE SET search_path` does NOT take effect on
   the multiplexed session (it's opened once and reused). GoTrue issues unqualified
   runtime queries (`users`, `identities`) and needs `auth` on the path. Fix: the db
   sidecar runs `SET search_path TO public, auth` on the **live** session at boot —
   session-global, persists for all connections.

3. **RLS isolation.** Does PostgREST's per-request `SET LOCAL role` + JWT claims leak
   across the shared session? **No** — `pglite-socket`'s `QueryQueueManager` is
   transaction-aware: while a transaction is open it only runs statements from the
   handler that opened it, so each request's `BEGIN; SET LOCAL role; …; COMMIT` is
   atomic. Proven with a 2s held transaction + 100 concurrent cross-user reads =
   zero bleed. `test/killswitch-rls-isolation.mjs`.

## Layout

| path | what |
|---|---|
| `zeropg-db/` | the DB sidecar: GCS-backed PGlite + wire + in-process PostgREST (no Postgres extensions needed). `bootstrap.sql` = Supabase roles, `auth` schema + `auth.uid()/role()/jwt()` helpers, RLS demo table `todos`. |
| `auth/` | GoTrue (`supabase/gotrue`) + a thin entrypoint that waits for the wire + `auth` schema. |
| `frontend/` | tiny Node ingress: serves the shell instantly, mints the anon key, Kong-style reverse proxy so **stock supabase-js works unmodified**, `/api/wake` + `/api/ready`. `index.html` drives supabase-js: signup → login → RLS todos. |
| `service.yaml` | the multi-container Cloud Run service. |
| `test/` | kill-switch tests, `integration-local.mjs` (full stack over HTTP), `browser.spec.mjs` (real Playwright), `up-local.mjs` (bring the stack up locally). |

## Client (supabase-js, typed, RLS-enforcing)

supabase-js hardcodes `${url}/rest/v1` and `${url}/auth/v1`, so the frontend proxy
mounts those paths (Kong-style, path-stripped) and forwards the JWT to PostgREST.
```js
const { url, anonKey } = await (await fetch('/api/config')).json()
const supabase = createClient(url, anonKey)           // anonKey = HS256 role=anon, shared secret
await supabase.auth.signUp({ email, password })       // -> /auth/v1/signup (GoTrue)
const { data } = await supabase.from('todos').select() // -> /rest/v1 (PostgREST), RLS-scoped to the user
```
**Drizzle has no PostgREST HTTP driver** — it would talk the raw wire and bypass
RLS. supabase-js over PostgREST is the typed path that enforces RLS.

## Run it locally

```bash
# postgrest binary on PATH or PGRST_BIN; needs gcloud ADC for the GCS bucket + Docker for GoTrue
PGRST_BIN=$(which postgrest) node test/up-local.mjs        # -> http://127.0.0.1:8080
PGRST_BIN=$(which postgrest) node test/integration-local.mjs   # full-stack assertions
node test/browser.spec.mjs                                 # real browser (Playwright)
```

## Deploy

```bash
AR=europe-west1-docker.pkg.dev/blob-pglite/zeropg
gcloud builds submit zeropg-db --tag $AR/supabase-zeropg-db:latest
gcloud builds submit auth      --tag $AR/supabase-auth:latest
gcloud builds submit frontend  --tag $AR/supabase-frontend:latest
gcloud run services replace service.yaml --region europe-west1
```

> **NOTE — no Postgres extensions.** GoTrue + PostgREST + the demo schema were
> verified to work with zero extensions, so the `zeropg-db` image installs the
> PUBLISHED `@zeropg/*` packages from npm. (A `package.json` + `vendor/` with
> local-built tarballs is kept on disk for reference: the published
> `@zeropg/objectstore-fs@0.0.1` drops the PGlite `extensions` option, so if you
> ever DO need `CREATE EXTENSION`, switch the Dockerfile back to the vendored
> tarballs — see the `.dockerignore` note.)

Email: the demo uses `GOTRUE_MAILER_AUTOCONFIRM=true` (no mail server). For real
magic-link / email-confirm, set it false and configure the GoTrue SMTP-API / Resend
mailer env — no SMTP server needs to run.
