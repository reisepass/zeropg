# DIY zeroSupabaseStudio — spec v1 (frontend + the backend it needs)

## The convergence
zeropocket (our PocketBase-pattern app) and zubase (our stripped Supabase) are the
same thing: a **scale-to-zero, self-hostable Supabase-lite** = a Postgres backend
(zeropg) + a **Studio-style admin frontend**. We unify them. The PocketBase work was
the warm-up; the target is this.

## Hard architecture rules
- **Frontend is SEPARATE from the backend and scales to zero by itself.** It's a
  fast-loading, lazy-loading SPA: an instant shell (login) paints immediately, the
  heavy views (table editor, SQL editor, logs) are lazy-loaded chunks. Hosted on
  **Google Cloud Run functions now, Cloudflare Workers later**.
- **Frontend's first action wakes the backend** (fire-and-forget), so the backend's
  cold start (the ~5 s GCS restore) happens *during* the user's login/think-time.
- **No Next.js. No Kong. No Logflare/Vector. No realtime / edge functions / advisors
  / integrations.** (Those are the heavy/irrelevant parts of Supabase for us.)

## Backend (multi-container, one scale-to-zero unit on zeropg)
| component | role | status |
|---|---|---|
| **zeropg-db** | PGlite + Postgres wire + GCS persistence | done |
| **PostgREST** | auto REST data API (`db-prepared-statements=false`) | verified |
| **GoTrue** | auth, OAuth providers, JWT | verified |
| **postgres-meta** | DB introspection/management API (tables, columns, roles, policies, **run-SQL**) | **ADD — the engine for most Studio features** |
| **storage-api** | S3/GCS file storage + Postgres metadata | add (S3 layer was already in zubase scope) |
| **BFF / gateway** | our frontend's server side — routes to the above, holds the secret/anon-key, does the wake | replaces Kong |
| **DIY logging** | a `_studio_logs` table in zeropg that the BFF + services write to | **replaces Logflare/Vector** |

## Feature spec (prioritized — P0 = the four that matter most)

### P0 — the four you said matter most
1. **Connection-string button** (header + everywhere). Show backend + frontend
   connection strings / API keys with one click. Trivial — the BFF already knows them.
2. **Table editor / data explorer** (`/editor`). Visual rows with **basic filters +
   sort + pagination**. Built over **postgres-meta** (schema introspection) + PostgREST
   (rows). Evaluate embedding **Drizzle Studio** vs building our own grid (Drizzle
   Studio is its own app; a custom grid over meta+REST is likely lighter + on-brand).
3. **Logs** (`logs/edge-logs`). The thing you go to to answer "was this an **auth
   failure** or some other failure." **Streamed INTO our zeropg Postgres** (a
   `_studio_logs` table the BFF + GoTrue + PostgREST write to), filterable by source
   (auth/rest/db) + level. NOT Supabase's external Logflare pipeline (see findings).
4. **SQL Editor** (`sql/new`). Run arbitrary SQL as the logged-in admin via
   postgres-meta's query endpoint. **Save + remember by default** — auto-persist
   executed history AND named saved queries in a `_studio_queries` table.

### P1
5. **Database** section (`database/*`): schema explorer, functions, triggers, indexes,
   **roles** — all postgres-meta introspection.
6. **auth/policies** (RLS): list/edit policies via postgres-meta; RLS round-trip
   already verified in zubase.
7. **auth/providers** (OAuth config): configure GoTrue providers. **HARD PART** —
   GoTrue reads provider config from **env at boot**, so a runtime UI config needs
   either GoTrue's admin/config API (if it supports live reload) or a config-write +
   GoTrue restart. Flag as the riskiest feature; spike it early.
8. **auth/rate-limits** settings (GoTrue rate-limit config).
9. **storage/files**: upload/list/download UI over **storage-api** (S3/GCS backend +
   Postgres metadata). You flagged this as important and under-discussed — it's a real
   service to add.
10. **settings**: `settings/general` (custom domain), `settings/api-keys`
    (publishable/secret — check OSS GoTrue support), `settings/jwt`.

### P2 — our differentiator
11. **`/observability`**: compute info + **our own cold-start metrics** (restore time,
    last cold start, datadir size in GCS, wake latency). This is zeropg-specific value
    Supabase doesn't have — lean into it.

### Explicitly SKIP
Edge functions, realtime subscriptions, Performance Advisor, Security Advisor,
Integrations tab.

## Frontend tech
- **Lightweight SPA** — vanilla or a tiny framework, **not** Next.js/React-heavy.
  Instant shell + lazy-loaded route chunks. Hash/clientside router (URL per view).
- **Studio-styled**: clone the Supabase Studio repo into a **gitignored `reference/`**
  to READ + translate the UI components/CSS — **do not run it** (see findings).
- Served from Cloud Run function (static/edge) now → Cloudflare Worker later. Scales
  to zero; wakes the backend on load.

## Architecture research findings (the "go find out")
1. **postgres-meta is THE engine.** It's a Node service exposing "a RESTful API for
   managing Postgres (fetch tables, add roles, run queries)" and encrypts the
   connection string (`PG_META_CRYPTO_KEY`). Table editor, SQL editor, schema,
   functions, triggers, indexes, roles, policies ALL go through it. It just queries
   Postgres → runs fine as a zeropg sidecar. **This is the one new backend dependency.**
2. **Supabase logs are NOT in Postgres.** Logging is an *optional, off-by-default*
   add-on = **Logflare** (analytics, BigQuery-backed) + **Vector** (collector). It's
   heavy and external. **We reject it** and do DIY in-Postgres logging (the
   `_studio_logs` table) — simpler, in-Postgres (what you wanted), scale-to-zero-friendly.
3. **Kong is replaceable.** Supabase routes everything through Kong (gateway). Our
   frontend BFF already does that routing → **we don't deploy Kong.**
4. **You can't cleanly clone-and-run Studio.** It's a heavy **Next.js SSR** app (~90
   prod deps, `next build`/`next start`, no edge runtime, mesh-coupled to Kong+meta).
   It won't run on Workers/functions without a fork-level port, and it'd be slow-boot
   anyway. **Path = clone to read/translate the UI + design, rebuild as a light SPA.**
5. **The OAuth-providers + new-API-key config is the trickiest** (GoTrue config is
   largely boot-time env). Spike it before committing to a live config UI.

## What PocketBase has that's worth borrowing
PocketBase's **per-collection API rules** (a simple filter-expression access model) are
a friendlier UX than raw RLS for simple cases — consider offering it as a layer over
RLS. Also its clean collection/record grid, typed-field forms, and built-in file
fields map directly onto features above. (Our zeropocket already implements the typed
collections + retention; that code is reusable.)

## Open questions / next steps
- Drizzle Studio (embed) vs custom grid for the table editor — evaluate.
- GoTrue live config for OAuth providers — admin API vs reload? (spike)
- New Supabase API-key model (publishable/secret) — OSS GoTrue or cloud-only?
- A deep clone-and-read pass of the Studio frontend (translate components/CSS) — agent task.
- Decide: does storage-api need S3-interop creds (GCS HMAC / R2) wired now or P1?
