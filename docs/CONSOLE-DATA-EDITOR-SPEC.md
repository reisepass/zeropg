# zeropg Console: data-editor direction (spec + decision record, NOT built)

Status: DECIDED 2026-07-04 - the Console's own table browser and SQL editor are
**frozen at their current basic state** (kept, tested, but no further investment).
Console development focuses on the admin surfaces no generic SQL tool provides.
The Airtable-class data editor is specced below for when/if we build or embed one.

## 1. The decision

The P0 Console shipped a read-only table browser and a guarded SQL editor. Both
work and stay (94-assertion suite keeps them green), but making them best-in-class
is a race against entire products (Drizzle Studio, Outerbase, NocoDB, DBeaver).
That is not our differentiator. zeropg's thesis is "it is real Postgres over a
real wire" - which means **every existing Postgres data UI already works against
it**. The Console should not compete with them; it should do the things they
cannot:

- cold-start / wake observability (restore time, bucket size, wake latency)
- durability dial + flush/quiesce controls (POST /flush, sleep vs strict)
- lease/fencing status, takeover history
- GoTrue user + provider admin, API keys, JWT secrets
- RLS policy management (paired with auth, not with a grid)
- backup/GC/branching controls (scripts/branch.ts as a button)
- graduation runbook as a UI (pg_dump exit, GRADUATION.md operationalized)
- in-Postgres logs (studio.logs)

None of that exists in Drizzle Studio or NocoDB. All of it is zeropg-specific
value. That is the Console's lane.

## 2. Reuse-vs-build findings (the "just embed something" question)

| option | license | embed as component? | run as separate app? | notes |
|---|---|---|---|---|
| Drizzle Studio embeddable (`drizzle-studio-npm`) | proprietary, private npm | YES but **paid B2B** (custom pricing; what Neon/Turso embed) | Gateway variant is self-hosted but the frontend stays closed | The only true drop-in component on the market. A licensing conversation, not a build task. |
| NocoDB | AGPL-3.0 | NO (AGPL + huge codebase; copying code contaminates the MIT repo) | **YES - already VERIFIED on zeropg** (`examples/nocodb-on-zeropg`: self-migrates its 124 metadata tables over the wire, grid works) | The Airtable UX exists TODAY by pointing stock NocoDB at the zeropg wire. Own user model (not GoTrue/RLS); writes its metadata schema into the DB. |
| Outerbase Studio | AGPL-3.0 | NO (same AGPL reason; Next.js app, components not packaged for reuse) | YES (Docker; Postgres support marked beta) | Nice staged-commit data editor + no-SQL schema editor; a second run-don't-copy option. |
| Supabase Studio | Apache-2.0 | Technically copyable, practically NO (heavy Next.js SSR, mesh-coupled to Kong/meta; the original spec already rejected clone-and-run) | Partially (needs the full service mesh) | License-clean but extraction cost is a fork-level project. |
| Build our own grid (glide-data-grid / TanStack + PostgREST) | MIT ecosystem | n/a | n/a | The only path to the RLS-native editor in section 3. Weeks of UI work to reach NocoDB polish; only worth it for the RLS angle. |

**Conclusion:** nothing license-clean is embeddable as a component for free. The
pragmatic move is the zeropg-native one: **hand off to existing tools over the
wire** instead of rebuilding them. Concretely, the Console gets a "Open in..."
surface (connection string + one-click recipes: NocoDB docker-compose against
this wire, Outerbase Studio, psql, TablePlus/DBeaver) rather than a grid arms race.
If a first-party embedded grid ever becomes strategic, the two real options are:
license Drizzle Studio's component (fastest, costs money) or build on
glide-data-grid + PostgREST (slowest, unlocks section 3).

## 3. Spec: the Airtable-class editor for business users (future, not scheduled)

The requirement behind "I always want to give business people access to edit
data": one UI, two audiences. Admins get full access; business users get exactly
what their identity allows. The key architectural insight: **do not build a
second permission system, and do not build a second UI.** Postgres already has
the permission system (RLS + roles); the stack already has the identity provider
(GoTrue) and the enforcement gateway (PostgREST, RLS-safe on the shared session -
proven by the killswitch tests).

### Architecture: the grid is an RLS client, not an admin tool

```
                    ┌── who is logged in? ──────────────────────────┐
browser grid UI ──► │ admin (Console session) -> service-role JWT   │ ──► PostgREST ──► zeropg wire
                    │ business user           -> their GoTrue JWT   │      (RLS enforces per-row,
                    └───────────────────────────────────────────────┘       per-command access)
```

- ALL reads/writes from the grid go through PostgREST (`/rest/v1`), never the
  raw wire. PostgREST + RLS is the enforcement point; the UI never needs its own
  ACL model. An admin is just a client whose JWT carries the service role.
- A business user logs in with GoTrue (email/password or OAuth) and the SAME
  grid renders only the rows/columns/actions their policies allow. 403s from
  PostgREST render as read-only cells, not errors.
- Writes: PostgREST already does INSERT/UPDATE/DELETE with RLS + `WITH CHECK`.
  Optimistic UI, server echo as truth (PostgREST `Prefer: return=representation`).
- Schema operations (create table, add column) stay ADMIN-ONLY and go through
  postgres-meta - business users never get DDL.
- Audit for free: a `studio.audit` trigger-based table on edited tables
  (who/when/old/new), toggleable per table in the admin UI.

### Why this beats NocoDB for the business-user case (eventually)

NocoDB brings its own users, its own ACL, and its own metadata schema - a second
source of truth that graduates BADLY (pg_dump carries 124 nc_* tables and its
permission model into RDS, where it means nothing). RLS policies ARE Postgres:
they survive graduation verbatim, they protect every access path (app, API,
grid, psql), and writing them is a one-time cost that secures the actual product,
not just the admin tool. The editor becomes a thin, disposable view over durable
policies. That is the same "boring exit" principle as the rest of zeropg.

### Feature ladder when built (strictly ordered)

1. Cell editing on tables WITH a primary key (text/number/bool/date), staged
   changes + explicit commit (Outerbase-style), server echo re-render.
2. Insert row / delete row (RLS-gated; delete behind confirm + audit).
3. Column type-aware editors: enum dropdown from pg_enum, FK picker via
   PostgREST embedded resource lookup, timestamp picker, jsonb editor.
4. Views for business users: saved filter+sort+column-subset presets on a table,
   shareable by URL (this is 80% of the "Airtable" feel at 5% of the cost).
5. Admin-side DDL: create table / add column forms over postgres-meta.
6. Grid virtualization (glide-data-grid) only when tables > a few thousand rows
   demand it.

### Non-goals

Realtime multiplayer cursors, formula columns, automations/workflows, file/album
cell types, per-cell comments. That is NocoDB/Airtable's product, reachable
today by running NocoDB against the wire.

## 4. What the Console builds next instead (P1, admin-only lane)

1. **Auth admin**: GoTrue users list/create/ban, password reset links; provider
   config surface (boot-env constraint documented, spike pending).
2. **RLS policy editor**: list/create/edit policies via postgres-meta (verified
   working), with templates ("owner-only rows", "read-all write-own").
3. **zeropg ops panel**: restore/wake metrics, durability mode, flush button,
   lease status, bucket size + cost estimate, nightly-reset status.
4. **"Open in..." handoff**: full connection string + copy-paste recipes for
   NocoDB/Outerbase/psql/TablePlus against this instance's wire.
5. **Graduation panel**: the GRADUATION.md runbook as a guided UI (quiesce ->
   pg_dump command -> verify checksums -> point-your-app).

## 5. Decision addendum (2026-07-04): adopt-vs-build + language question

Settled after live-testing the survey candidates against both a local wire and a
remote instance snapshot (docs/LIGHT-PG-EDITORS-SURVEY.md):

- **Adopt for all generic SQL/grid work.** Adminer (fleet-wide editing, one
  container, URL-addressable connections) + pgweb (browse/query) become the
  "Open in..." data plane; NocoDB stays the Airtable tier. Our own grid stays
  frozen. The only build-worthy editor remains the future RLS-client grid
  (section 3), because no adoptable tool can execute as a GoTrue end-user
  identity - they all connect as a DB superuser.
- **Rust is disqualified for wire-facing tooling by our own compat evidence:**
  the mainstream Rust drivers (sqlx, Diesel, named-statement tokio-postgres)
  are exactly the clients blocked on the single-session wire. Go + pgx
  cache_describe is the proven-good path if a rewrite ever happens.
- **The footprint problem is postgres-meta (~200MB), not Node.** Next
  lightness move: drop postgres-meta from the console stack (the BFF already
  mostly forwards SQL; the introspection it uses is a handful of known catalog
  queries, and /indexes is bypassed already). That cuts ~2/3 of the RSS with
  no language change and is a prerequisite for any Go rewrite anyway.
- **Go becomes right** only if the inspector ships as a standalone binary or a
  per-instance sidecar where image size x fleet size bills. Neither is true
  today for a research repo.
