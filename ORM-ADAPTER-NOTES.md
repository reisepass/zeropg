# ORM adapter + migration notes (Drizzle / Prisma)

Status: **notes / design thinking**, not implemented. Captures how Drizzle and
Prisma should work against zeropg across the connection ladder
(`memory://` / `file://` local → bucket-backed remote over HTTP →
graduated `postgres://`), and specifically how schema migrations work when the
remote instance is **HTTP-only** (no raw 5432 on Cloud Run / Code Engine).

Related: Track E in [TODO.md](TODO.md) (unified `connect()` client), DESIGN §5
(env-var graduation), `packages/server` (HTTP `/sql`, `/wake`, loopback 5432).

---

## NOTHING HERE IS CONCLUDED — decide empirically

The recommendations below are thinking-out-loud, not decisions. We do not yet
know which usage shapes actually dominate, and that is the input that should
settle every choice in this doc. The deciding questions:

- **Which topology do people actually run?** Embedded in-process (DB lives in
  the backend app's process; no network hop; ORM rides PGlite's existing driver
  on `ZeroPG.open().raw`; durability is a filesystem-layer concern so there is
  little/nothing to adapt) vs standalone HTTP server (separate scale-to-zero
  service; the wire/HTTP/proxy questions apply) vs raw-wire-on-Fly/VPS/k8s
  (native `postgres://`, no adapters). Guess: embedded is most likely, but it is
  a guess.
- **Which ORMs do users bring**, and does the lean toward direct-SQL / Drizzle
  (lighter, edge-friendly, SQL-first, native PGlite driver) over Prisma (heavier,
  server-shaped connection model, migration-engine friction) hold up in practice?
- **Do the env-var switch and prewarm need a maintained client at all**, or do
  they fall out of "wire protocol everywhere + one optional wire⇄HTTP proxy" /
  "embedded + a ~10-line URL→driver selector"? Both routes avoid per-ORM
  protocol adapters; which is right depends on the topology mix above.

**Path: release, dogfood in our own live apps, watch real usage, then decide**
adapter strategy, topology support, and the ORM stance. Do not lock any of the
choices below before there is usage data. Everything from here down is options
and reasoning to choose *from*, not a settled design.

---

## The two problems

1. **Prisma's connection-type fragility.** Prisma Migrate's schema-engine wants a
   *direct, privileged, single* wire connection. It creates a **shadow
   database**, takes a **`pg_advisory_lock`**, and runs DDL transactionally.
   That is exactly why Prisma fights PgBouncer/poolers and serverless, and why
   on Supabase you must point migrations at the **direct** 5432 URL
   (`directUrl`), not the pooler. Any HTTP/pooled/single-DB target trips this.

2. **HTTP-only remote.** zeropg's scale-to-zero instances expose only HTTP
   (`POST /sql`, `/rest`); raw 5432 stays loopback because Cloud Run / Code
   Engine can't accept raw Postgres TCP (Fly can — that path keeps wire). So an
   ORM that insists on a `postgres://` wire connection for migrations cannot
   reach a remote zeropg the normal way.

These compound: the ORM that is hardest about connections (Prisma) meets the
deployment that is least able to give it one.

---

## What each ORM actually needs

### Drizzle (the natural fit)

- `drizzle-kit generate` produces SQL migration files **from the schema alone —
  no DB connection**.
- Applying: the programmatic `migrate(db, { migrationsFolder })` just **runs the
  migration SQL sequentially through whatever `db`/driver you pass it**, tracking
  applied files in a simple `__drizzle_migrations` table. No shadow DB, no
  advisory lock, no `CREATE DATABASE`.
- Official local driver exists: `drizzle-orm/pglite`.
- Consequence: **Drizzle migrations can run over our HTTP `/sql`** because
  they are just sequential SQL statements. `drizzle-kit push` (diff-and-apply,
  no files) is the local-prototyping path and wants a connection config; the
  file-based `generate` + `migrate` flow is the production path and is
  transport-agnostic.

### Prisma (the hard one)

- **Query path is fine via driver adapters.** Prisma supports JS driver adapters
  (`@prisma/adapter-pg`, `-neon`, `-d1`, `-libsql`, …). A driver adapter is a
  small interface (`queryRaw` / `executeRaw` / `startTransaction`). We can write
  one backed by our HTTP `/sql` for remote, and use a PGlite adapter locally.
  *Verify:* maturity / existence of an official `@prisma/adapter-pglite` vs
  community; otherwise we ship our own adapter for both.
- **Migration path is the blocker.** `prisma migrate dev` needs the schema-engine
  + a **shadow database** + a direct wire connection. PGlite is effectively
  single-database (no usable `CREATE DATABASE` in the WASM build — *verify*), so
  the shadow DB must be a *second* local PGlite datadir, and the engine wants
  wire, not HTTP. `prisma migrate deploy` skips the shadow DB but still wants a
  wire connection + advisory lock. Neither runs cleanly against an HTTP-only
  remote today. (Prisma has been *adding* migrate-over-driver-adapter support —
  *verify current state*; do not design around it landing.)

---

## Governing principle (the resolution)

**Authoring schema is a local, wire-protocol activity. Applying schema to a
remote is done by the single-writer instance applying SQL to *itself* — never by
pushing DDL through an ORM's migration engine across HTTP.**

Why this is correct, not just convenient:

- Migrations are *writes*. zeropg has exactly one writer, holding the lease. The
  instance applying its own migrations under the lease **is** the right place —
  the lease is already the advisory lock the ORMs reach for, and there is no
  multi-connection / pooler problem because there is only ever one connection
  (in-process PGlite).
- Inside the instance, PGlite is fully wire-capable (the standalone server
  already exposes loopback 5432). The HTTP boundary only exists for *external*
  callers. So "apply DDL" never has to cross HTTP as an engine connection — it
  is either shipped as SQL files the instance runs at boot, or POSTed as plain
  SQL to `/sql` (DDL is just SQL).

This dissolves problem 2 entirely: we stop trying to make a remote instance look
like a `postgres://` host to a migration engine.

---

## Recommended design

### 1. Local dev = real wire (unlocks every tool, not just ORMs)

Default `file://` dev to a managed localhost **`pglite-socket`** server exposing
`postgres://localhost:5432` (Track E2). Then Prisma migrate (with a second local
PGlite as `shadowDatabaseUrl`), `drizzle-kit push`, `psql`, TablePlus — all
"just work" locally, byte-identical to prod-on-RDS. This is the single biggest
compatibility win and it is why local-wire matters.

### 2. Schema application to remote = instance self-applies

Two delivery mechanisms, pick per workflow:

- **Boot-time migrate (recommended default).** Ship the generated migration SQL
  (Drizzle `migrations/`, or Prisma `migration.sql`) *with the deploy* or into
  the bucket. On boot, after acquiring the lease and restoring, the instance runs
  a migrate runner against its own in-process PGlite, maintaining the migrations
  table. Rails-`db:migrate`-on-deploy shape. No DDL crosses HTTP from a laptop.
- **Control-endpoint migrate.** A `POST /migrate` (or just sequential `POST
  /sql`) that the unified client / CLI calls to apply pending files over HTTP.
  Drizzle's `migrate(httpDb, …)` works here directly; for Prisma, feed it the
  **SQL Prisma generated** (`prisma migrate diff --script` / the committed
  `migration.sql`), not the Prisma engine.

Either way: **exactly one applier.** Never let both the laptop and the instance
apply — the migrations table must have a single writer (which it does, by the
lease).

### 3. Query path via driver adapters

- Drizzle: `drizzle-orm/pglite` locally; a Drizzle driver over HTTP `/sql` (or
  the unified pg-shaped client) for remote.
- Prisma: driver adapter over HTTP `/sql` for remote; PGlite adapter locally.
- App code binds to the ORM, not the engine, so the `DATABASE_URL` switch
  (Track E2) carries the ORM along.

### 4. Use Prisma for *authoring*, our runner for *applying*

The robust-today Prisma flow that avoids the engine's connection demands:
`prisma migrate diff --script` (or the committed `migration.sql`) to **emit raw
SQL**, then apply via the self-apply mechanism above. Prisma stays the
schema-authoring tool; zeropg's single-writer applies it. Sidesteps shadow-DB /
advisory-lock / wire-connection requirements against remote completely.

---

## Future option: wire-over-WebSocket proxy (Neon-style)

Neon's `@neondatabase/serverless` speaks the Postgres protocol over WebSocket to
a wire proxy. We could front the instance's loopback 5432 with a WS (or HTTP/2)
wire proxy and provide a matching driver, so even *remote* presents a real
`postgres://` and Prisma/Drizzle/psql connect "normally," migrations included.
This is the only way to make Prisma's native migrate engine work against remote
unchanged. Heavy; a v2/v3 item, not v1. The self-apply path above is the v1
answer and is simpler and more aligned with the single-writer model.

---

## VERIFIED EMPIRICALLY (2026-06-21) — Prisma 7.8 over the pglite-socket wire

Spike: `experiments/prisma-spike/` (run `tsx experiments/prisma-spike/run.ts`), against
the new local-wire mode `serveWire()` in `@zeropg/client` (`packages/client/src/wire.ts`),
which stands up a real `postgres://` localhost endpoint over one PGlite via
`@electric-sql/pglite-socket`.

Connection URL prerequisites for the native engine to reach pglite-socket at all:
`?sslmode=disable` (the Rust engine defaults to `prefer` and sends an SSLRequest
the socket doesn't negotiate → P1001) and user `postgres` (else P1010).

**What each Prisma migration command does over the raw pglite-socket wire
(experiments: `run.ts`, `migrate-dev.ts`, `deploy.ts`):**

| Command | Result | Why |
|---|---|---|
| `prisma migrate diff --script` | ✅ works | offline, no DB connection |
| `prisma migrate deploy` | ✅ **works** | applies committed migration SQL; no shadow DB, single session |
| `prisma generate` + client via `@prisma/adapter-pg` | ✅ works | nested writes / relations / filters over the wire |
| `prisma migrate dev` | ❌ **P1017** | shadow-DB reset + multi-session/advisory-lock workflow hits pglite-socket's wire bugs (electric-sql/pglite #985 deadlock-on-disconnect-mid-tx, #958 premature ReadyForQuery) — **fails even with the maintainer's `connection_limit=1` + separate-PGlite-shadow fix** (prisma/prisma#29366), because that fix targets Prisma's own `prisma dev` proxy, not raw pglite-socket |

**Corrected conclusion (an earlier note here wrongly said "migrations don't work
at all"):** existing Prisma apps run on zeropg with their NORMAL workflow, and NO
Prisma-migration parser is needed (Prisma emits plain SQL; `migrate deploy`
applies it natively). The standard flow is unchanged:
1. **Author** migrations with `prisma migrate dev` against any local Postgres OR
   Prisma's own PGlite-backed `prisma dev` (which works because it ships a more
   complete wire gateway than pglite-socket). Commit the `migrations/` folder.
2. **Apply** to zeropg with `prisma migrate deploy` over the wire (verified), or
   have the zeropg instance apply the committed SQL at boot (single-applier — what
   `examples/poll/boot.ts` does). Either way, exactly one applier.
3. **Query** via `PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.

**pg-gateway TESTED (2026-06-21, `experiments/prisma-spike/pggw.ts`) — does NOT
fix `migrate dev`.** Fronting PGlite with supabase-community's `pg-gateway`
(startup/auth/SSL handshake, then raw bytes → PGlite's own `execProtocolRaw`,
serialized by PGlite's `runExclusive`) still fails `migrate dev` with **P1017**.
The debug shows PGlite never errors on any message — the schema engine itself
closes the connection. Root cause is structural, not a framing bug a gateway can
fix: Prisma's schema engine needs **multiple independent Postgres sessions**
(advisory-lock conn + work conn + shadow reset), and **PGlite is a single backend
session**. This is why `migrate dev` against PGlite is broken even in Prisma's
OWN `prisma dev` (the #29366 thread is full of P1017 against Prisma's own
PGlite-backed local server, even with `connection_limit=1` + a separate shadow).
So: treat `prisma migrate dev` against any single PGlite as unsupported; AUTHOR
migrations against a throwaway real Postgres (Docker/local) and `migrate deploy`
to zeropg.

**Silver lining — pg-gateway is the better wire layer for everything else.** A
plain `pg` client connected over pg-gateway with NO `sslmode=disable` and NO user
override (pg-gateway answers `SSLRequest` correctly and uses PGlite's faithful
`execProtocolRaw`), whereas pglite-socket needed both. Candidate follow-up: swap
`serveWire`'s backend from `@electric-sql/pglite-socket` to `pg-gateway` so
`migrate deploy`, `db push`, `drizzle-kit`, `psql`, TablePlus, and the client all
"just work" without connection-string hacks. Does not change the `migrate dev`
verdict.

**Prisma 7 specifics learned:** connection URLs moved OUT of `schema.prisma` into
`prisma.config.ts` (`datasource.url` / `shadowDatabaseUrl`, resolved at
config-load time so the CLI needs them set even for offline `diff`); the client
REQUIRES a driver adapter (or Accelerate) in the constructor; `migrate diff` flag
is `--to-schema` (not the removed `--to-schema-datamodel`); PGlite is single-
connection so any wire client must use `connection_limit=1`.

## Caveats / things to verify before building

- **PGlite `CREATE DATABASE` / multi-DB** support (decides whether a Prisma
  shadow DB can live in one instance or needs a second datadir). Expect: single
  DB, so shadow = second local PGlite.
- **`@prisma/adapter-pglite`**: official vs community, version, maturity.
- **Prisma migrate-over-driver-adapter**: current support level (evolving; don't
  depend on it).
- **`/sql` transaction semantics**: a single migration file with multiple
  statements must apply atomically. Ensure `/sql` (or `/migrate`) wraps a file in
  one transaction and reports failure cleanly, so a half-applied migration can't
  advance the migrations table.
- **Migrations table ownership**: confirm only one applier ever runs; document
  that mixing laptop-apply and instance-apply corrupts the tracking table.
- **`directUrl` analog**: in local-wire mode, document the Prisma `datasource`
  (`url` = socket 5432, `shadowDatabaseUrl` = second local PGlite) so users
  don't hit the Supabase-style "wrong connection type for migrations" wall.

## Candidate next steps (only after usage data — see the unconcluded banner up top)

1. Ship the local `pglite-socket` wire mode so local ORM/tooling is native.
2. Drizzle first-class: `drizzle-orm/pglite` local + HTTP driver + boot-time
   `migrate()` runner in the instance.
3. Prisma supported: HTTP driver adapter for queries + the "Prisma emits SQL,
   instance applies it" migration recipe, documented end to end.
4. A `zeropg migrate` CLI verb (apply pending files via boot hook or `/migrate`),
   single-applier-enforced.
5. Worked example repos for both ORMs showing the same code local → bucket →
   `postgres://` with migrations.
</content>
</invoke>
