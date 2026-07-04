# zeropg Console

A lightweight, Supabase-Studio-style admin console for **zeropg** (scale-to-zero
Postgres = PGlite behind `pglite-socket`, with **one shared wire session**). It is
a plain-Node BFF + a vanilla-JS SPA - no Next.js, no React, no Kong, no Logflare.
The whole data/introspection engine is stock **`supabase/postgres-meta`** running
as a sidecar against the zeropg wire (zero patches - see
`../../../docs/STUDIO-PGMETA-COMPAT.md`).

```
browser ──► studio BFF (node:http)  ──►  postgres-meta  ──►  zeropg wire (PGlite, ONE session)
            - admin login (bcrypt)          POST /query          serialized by pglite-socket's
            - HMAC session cookie + CSRF     GET  /tables/...     transaction-aware QueryQueueManager
            - strict route allowlist
            - SQL editor / table browser / logs / status
            - studio schema (history + saved queries + logs)
```

## What it does (P0)

- **Admin auth** - single admin, bcrypt password (`STUDIO_ADMIN_PASSWORD` or a
  precomputed `STUDIO_ADMIN_PASSWORD_HASH`), stateless HMAC-signed HttpOnly session
  cookie, session-bound CSRF token on every mutating route, per-IP + global login
  rate limiting, strict upstream route allowlist (no generic proxy), CSP +
  `frame-ancestors none` + nosniff. Unauthenticated API calls 401; unauthenticated
  views redirect to `/studio/login`.
- **Connection & API keys** (modal + settings) - REST/auth URLs and anon key shown
  in full; service key, JWT secret, DB connection string redacted until an explicit
  per-item reveal (a CSRF-protected POST). Nothing is ever ellipsis-truncated.
- **SQL editor** (`/studio/sql`) - run arbitrary SQL (Cmd/Ctrl+Enter), results grid,
  real Postgres error message + code + exec time. Every submission is auto-saved to
  `studio.queries` (history) with duration/success; named saved queries round-trip.
- **Table browser** (`/studio/editor`) - read-only grid over postgres-meta
  introspection; sidebar of schemas/tables (internal schemas hidden by default with
  a toggle); pagination, header-click sort, one filter (eq/neq/like/ilike/is-null);
  type-aware cells (NULL distinct from empty string, jsonb, arrays, timestamps,
  booleans). Identifiers are validated against live introspection then quoted; filter
  values are bind parameters.
- **Logs** (`/studio/logs`) - DIY in-Postgres logging (`studio.logs`); the BFF writes
  its own request/auth/SQL events with secret redaction; filter by source + level;
  red styling only on error rows.
- **Status** (`/studio` home) - backend awake?, PGlite version, DB size, BFF uptime.

Every view has a real URL (History-API routing) and lazy-loads its own JS chunk;
deep links and back/forward work.

## The single-session rules (binding - these are correctness constraints)

zeropg multiplexes every wire connection onto ONE serialized PGlite session, so the
SQL editor is built around four rules (all verified in the compat spike and by the
tests here):

1. **`statement_timeout` is inert on PGlite.** The editor timeout is client-side only
   (`STUDIO_QUERY_TIMEOUT_SECS`, default 25s) and is reported as "the client stopped
   waiting; the query may still be running and could still commit" - never "cancelled".
2. **Transaction-control statements are rejected** (`BEGIN`/`START TRANSACTION`/
   `COMMIT`/`ROLLBACK`/`END`/`ABORT`/`SAVEPOINT`/`RELEASE`/`SET TRANSACTION`), including
   inside multi-statement submissions and after comment/string/dollar-quote stripping.
   An open transaction on the shared session freezes every other backend consumer.
3. **`COPY ... FROM STDIN` is rejected.** It puts the wire into copy-in mode waiting
   for data the console never sends, which desyncs the protocol (verified: FATAL
   08P01) and tears down the shared session. (`COPY ... TO STDOUT` is allowed.)
4. **The session is reset after every submission** with `DISCARD ALL` (then
   `SET search_path TO public`). `DISCARD ALL` clears role, SESSION AUTHORIZATION, all
   GUCs, prepared statements, temp objects, LISTEN channels, and session advisory
   locks - everything that would otherwise leak to the next consumer on the shared
   session. It is sent as its own single-statement query (combining it with another
   statement triggers 25001 "cannot run inside a transaction block").

Index metadata, when surfaced, must come from `pg_indexes` via `POST /query`, not
postgres-meta `GET /indexes` (which drops non-first-column indexes on PGlite).

## Run it locally (one command)

Requires Docker running and Playwright's chromium (installed at the repo root).

```bash
node examples/cloudrun/supabase/studio/up-local.mjs
#  -> http://127.0.0.1:4321/studio     (admin password: studio-admin-pw-123)
```

This boots a local zeropg wire (`serveWire`, no GCS), `supabase/postgres-meta:v0.96.6`
in Docker pointed at it (`sslmode=disable`, pool stays `max:1`, low
`PG_QUERY_TIMEOUT_SECS`), and the studio BFF, and seeds a small demo schema. Ports
default to 5499 (wire) / 4322 (pg-meta) / 4321 (BFF), all env-overridable, chosen to
avoid the local dev-stack ranges.

## Test (one command)

```bash
node examples/cloudrun/supabase/studio/test/run.mjs
```

Boots the stack once and runs every `test/*.spec.mjs` headless (auth, connection,
SQL editor, table browser, logs, routing, concurrency). Core principle: **every test
seeds known data over the Postgres wire first, then asserts the UI shows EXACTLY that
data** (exact cell values vs seeded rows, count vs `count(*)`, pagination
disjoint+exhaustive, sort vs `ORDER BY` incl. nulls, filter vs `WHERE`, null-vs-empty
distinction, jsonb/array/timestamp rendering, no ellipsis truncation, etc.). Run one
spec with `SPEC=table-browser node .../test/run.mjs`.

The postgres-meta compatibility kill-switch stays green too:
`node examples/cloudrun/supabase/test/killswitch-pgmeta.mjs`.

## Environment variables

| var | purpose | default |
|---|---|---|
| `STUDIO_PORT` | BFF listen port | `4321` |
| `PG_META_URL` | postgres-meta base URL | `http://127.0.0.1:4322` |
| `STUDIO_SESSION_SECRET` | HMAC secret for session cookie + CSRF (required, >=16 chars) | - |
| `STUDIO_ADMIN_PASSWORD` | plaintext admin password (hashed at boot) | - |
| `STUDIO_ADMIN_PASSWORD_HASH` | precomputed bcrypt hash (wins over the plaintext) | - |
| `STUDIO_QUERY_TIMEOUT_SECS` | client-side SQL-editor wait cap | `25` |
| `STUDIO_REST_URL` / `STUDIO_AUTH_URL` / `STUDIO_ANON_KEY` | public connection values | empty |
| `STUDIO_SERVICE_KEY` / `STUDIO_JWT_SECRET` / `STUDIO_DB_URL` | privileged values (reveal-gated) | empty |

One of `STUDIO_ADMIN_PASSWORD` / `STUDIO_ADMIN_PASSWORD_HASH` and
`STUDIO_SESSION_SECRET` must be set (the harness sets test values automatically).

## Layout

| path | what |
|---|---|
| `server.mjs` | the BFF: auth, CSRF, rate limit, route allowlist, SQL editor, table reads, logs, status |
| `lib/auth.mjs` | bcrypt check, session cookie, CSRF, rate limiter |
| `lib/meta.mjs` | postgres-meta client + `DISCARD ALL` reset baseline |
| `lib/sqlsafe.mjs` | transaction-control + COPY-FROM-STDIN rejection, identifier quoting |
| `lib/bootstrap.mjs` | idempotent `studio` schema (queries + logs) |
| `lib/logs.mjs` | in-Postgres logging + redaction |
| `lib/harness.mjs` | one-call local bring-up (wire + pg-meta + BFF) |
| `public/` | the vanilla-JS SPA (instant shell + lazy view chunks) |
| `test/` | Playwright specs + the one-command runner |

## Deployment note

The BFF trusts `X-Forwarded-For` / `X-Forwarded-Proto` (for client IP and cookie
`Secure`), so it must run behind a proxy that sets/overwrites those (Cloud Run does).
Do not expose the BFF directly to untrusted clients.
