# TODO: fix named-prepared-statement collisions in pglite-socket

**Status:** open. **Impact:** unblocks every driver that uses *named* server-side
prepared statements over the zeropg wire — most importantly **sqlx** (all Rust
apps, e.g. nostr-rs-relay), and anything else that breaks under pgBouncer
transaction-pooling mode. This is the single highest-value pglite-socket
enhancement surfaced by the "real apps on zeropg" exercise.

> **The blocker is not sqlx-specific — it's any named-prepared-statement driver.**
> Confirmed against **Diesel** too (Rust **rsky-pds** AT Proto PDS): Diesel caches
> named prepares per connection with no URL escape hatch, same `42P05`, same
> pgBouncer-txn-mode breakage. So this fix would unblock sqlx **and** Diesel (and
> any future driver in that class).
>
> **`pgx` (Go) does NOT need this fix — it has a DSN-only escape hatch.** Set
> `?default_query_exec_mode=simple_protocol` on the connection string and pgx uses
> the simple protocol (no server-side prepares), the pgx equivalent of node-postgres's
> unnamed path. **Verified end to end with cocoon** (GORM+pgx PDS) locally and on
> Cloud Run. So the screen is: **Go/pgx apps → set `default_query_exec_mode=simple_protocol`,
> let them through; Rust sqlx/Diesel → no URL escape hatch → still blocked until this
> fix lands.** See `docs/POSTGRES-APP-COMPAT.md` Limitation 5.

## The problem

zeropg exposes PGlite over the Postgres wire via `@electric-sql/pglite-socket`'s
`PGLiteSocketServer`. It accepts many TCP client connections and **multiplexes
them onto ONE PGlite instance = one Postgres session**. Prepared statements in
Postgres are **session-scoped**, and pglite-socket does not isolate or reset them
per client connection. So:

1. Client connection A prepares `sqlx_s_1` (sqlx names + caches statements).
2. A's connection ends (or sqlx's pool hands out a "fresh" connection).
3. Client connection B — believing it has a clean session — prepares `sqlx_s_1`.
4. The shared PGlite session still holds A's `sqlx_s_1` → **`42P05: prepared
   statement "sqlx_s_1" already exists`**.

This is the **same incompatibility sqlx has with pgBouncer in transaction-pooling
mode**: the client assumes one-session-per-connection; the pooler/multiplexer
collapses many connections onto one backend session.

### Evidence (verified 2026-06-23)
- nostr-rs-relay (sqlx) crashes at `src/repo/postgres_migration.rs` on boot with
  `42P05 ... "sqlx_s_1" already exists`, both with default pooling and with
  `max_conn = 1` (so it's a connection-*lifecycle* issue, not concurrency).
- **Why the 5 deployed apps work and this doesn't:** node-postgres (Cal.com,
  Rallly, NocoDB), Prisma's engine, and PHP `pdo_pgsql` (PrivateBin) use
  **unnamed** prepared statements (the empty-name slot, overwritten each use), so
  there is no name to collide. The existing transaction-granularity serialization
  in pglite-socket already protects the single unnamed slot from concurrent
  clobber. Named statements *persist across transactions* by design, so they leak
  across connections — that's the gap.

### The compatibility boundary this imposes
- **Works over the wire:** drivers using unnamed/simple statements — node-postgres,
  pdo_pgsql, Prisma query engine.
- **Blocked:** drivers using named server-side prepared statements with connection
  pooling — **sqlx** (Rust), and any driver incompatible with pgBouncer txn mode.

## Solutions (ranked)

### 1. (RECOMMENDED) Per-connection prepared-statement namespacing in pglite-socket
Give each client connection its own statement/portal namespace on the shared
session by **rewriting the names in the extended-query protocol messages** as they
pass through the handler. Each `PGLiteSocketHandler` gets a unique id; prefix every
**non-empty** statement/portal name with it (e.g. `z<connId>_sqlx_s_1`). Two
clients' `sqlx_s_1` become `z1_sqlx_s_1` and `z2_sqlx_s_1` on the one session — no
collision, and it is correct under **concurrent** connections (unlike option 2).

Messages to rewrite (client→server only; server responses don't echo these names,
so no return-path rewrite):
- `Parse ('P')`: statement name (first field).
- `Bind ('B')`: portal name **and** source statement name.
- `Describe ('D')` / `Close ('C')`: the name (after the `'S'`/`'P'` kind byte).
- `Execute ('E')`: portal name.
- **Leave the empty name `""` untouched** — the unnamed statement/portal is already
  protected by transaction-level serialization, and PGlite has a single unnamed
  slot.

Lifecycle: track the prefixed names a connection creates and `DEALLOCATE` them when
that connection closes, so churned connections don't leak prepared statements on
the long-lived session.

pglite-socket already parses/forwards the wire protocol (it hands raw protocol
bytes to PGlite via `execProtocolRaw`), so this is a bounded, localized change in
the handler — **a fork/patch of pglite-socket, not a deep rewrite.** This is the
preferred path.

### 2. (INTERIM) `DEALLOCATE ALL` / `DISCARD ALL` on connection open or close
Reset the session's prepared statements when a client connection ends (or starts).
- Pro: trivial — one `exec` hook in the handler's connect/disconnect path.
- Con: **only correct for non-overlapping connections.** If two clients are
  connected at once, clearing on one's disconnect clobbers the other's statements,
  and two concurrently-active named statements still collide. Good enough to get
  sqlx *migrations* through (sequential), likely not enough for a live relay with
  several subscriber connections. Use only as a stopgap behind a flag.

### 3. (NOT VIABLE) True session-per-connection
Give each TCP client its own PGlite session. PGlite is single-instance/single-
session and two instances can't share a datadir, so this is impossible without
multiple writers (the corruption we prevent). Rejected.

### 4. (PER-APP, NOT GENERAL) Force the client to unnamed/simple statements
e.g. `statement_cache_capacity = 0` in sqlx. sqlx does **not** expose this via the
connection URL, so it requires patching each app — not a zeropg-level fix. Noted
for completeness only.

## Where to implement
- Patch/fork `@electric-sql/pglite-socket` (the handler) and have zeropg's wire
  layer (`serveWire` / `ZeroPGServer`) depend on the patched build — same way the
  datadir lock lives in the `pglite-kill-dash-9` fork. Consider upstreaming: this
  is generally useful for anyone exposing PGlite to pooled/named-statement clients.

## Acceptance criteria
- nostr-rs-relay (sqlx) boots against the zeropg wire: its `postgres_migration`
  schema applies with no `42P05`, and a real NIP-01 publish + `REQ` subscription
  round-trip works, with the event row read back from the DB.
- The 5 existing node-postgres/Prisma/pdo apps still pass (no regression for the
  unnamed-statement path).
- A focused test: two concurrent connections each prepare a statement named
  `s1`, both execute it, neither errors (proves per-connection isolation, not just
  sequential reset).

## Related
- Compatibility findings + the unnamed-vs-named boundary: `docs/POSTGRES-APP-COMPAT.md`.
- Current Nostr-on-zeropg pivot (nostream / node-postgres, which sidesteps this):
  tracked by the background `nostr-agent`.
- AT Proto PDS on zeropg: **cocoon** (Go/pgx) sidesteps this via
  `default_query_exec_mode=simple_protocol` and is deployed
  (`examples/cloudrun/pds/`); **rsky-pds** (Rust/Diesel) is blocked by exactly this
  issue and waits on the fix above.
