# Nostr relay on zeropg — STATUS: IN PROGRESS (paused 2026-06-23)

Goal: a Nostr relay that runs on zeropg (PGlite over the pglite-socket wire, DB in
GCS) and **scales to zero** — i.e. the Postgres-in-object-storage IS the only state,
no always-on second service. Three relays were evaluated. Work is **paused**, not
abandoned; this doc records exactly where each stands and what's left.

## Summary of the three approaches

| Relay | Stack | Runs on zeropg? | Scale-to-zero clean? | State |
|---|---|---|---|---|
| **nostr-rs-relay** | Rust / **sqlx** | ❌ no | n/a | **Blocked** — hard wall |
| **nostream** | Node / TypeScript | ✅ yes | ❌ **needs Redis** | Works, but not the clean story we wanted |
| **znostr-relay** (ours) | Node / `ws` / node-postgres | ✅ yes (by design) | ✅ yes (no Redis) | **Built, deploy + round-trip verification unfinished** |

## 1. nostr-rs-relay (Rust/sqlx) — BLOCKED

Crashes on boot at `src/repo/postgres_migration.rs` with
`42P05: prepared statement "sqlx_s_1" already exists`, with default pooling AND with
`max_conn = 1`. This is the **named-prepared-statement wall**: sqlx uses named
server-side prepared statements, pglite-socket multiplexes all connections onto one
PGlite session, and the names leak/collide across connection lifecycles (same failure
sqlx has against pgBouncer transaction-pooling mode).

Not fixable at the app level (sqlx doesn't expose statement-cache-disable via the
connection URL). Requires the pglite-socket patch tracked in
**`docs/TODO-pglite-socket-prepared-statements.md`** (per-connection statement-name
namespacing). Until that lands, all Rust/sqlx relays are out.

## 2. nostream (Node/TypeScript) — WORKS, but requires Redis

nostream runs against the zeropg wire (it uses a node/knex `pg` path = unnamed
prepared statements, so no `42P05`). **But nostream hard-depends on Redis** for its
worker IPC / rate-limit / pub-sub layer; it was brought up with a **valkey sidecar**
(`valkey/valkey:8-alpine`, Redis-compatible), and verified working in that config.

Issue: **Redis defeats the scale-to-zero premise.** Valkey is a second always-on
stateful service whose state is *not* in GCS — so the unit can't cleanly scale to
zero, and there's now state outside the object store. Acceptable as a "nostream runs
on zeropg" data point; **not** acceptable as the flagship scale-to-zero demo.

> Cleanup note: a `nostr-valkey` container (`valkey/valkey:8-alpine`, host port 6399)
> from this test was **left running** at pause time. Safe to stop/remove when
> convenient — it is not part of the recommended path.

## 3. znostr-relay (ours) — RECOMMENDED PATH, unfinished

Because both off-the-shelf options had a disqualifier, a **minimal purpose-built
relay** was written: `examples/cloudrun/nostr/znostr-relay/` (`relay.mjs`, ~320 lines).

- **Node + `ws` + node-postgres** — node-postgres uses **unnamed** prepared statements,
  so it sidesteps the sqlx wall entirely. **No Redis**: one process, the DB is the
  only state → scales to zero cleanly, which is the whole point.
- **NIP-01 complete**: `EVENT` / `REQ` / `CLOSE`, the standard filter set
  (`ids, authors, kinds, since, until, limit, #<single-letter-tag>`), plus event-class
  semantics — replaceable (kind 0, 3, 10000–19999), parameterized-replaceable
  (30000–39999 by d-tag), ephemeral (20000–29999, served-not-stored), deletion
  (kind 5, NIP-09). Signature verification via `nostr-tools/pure` (`verifyEvent`).
- **Self-bootstrapping schema** (`schema.sql`): an `events` table (raw JSONB + extracted
  filter columns, GIN index on tags) plus a flat `event_tags` projection for
  index-friendly `#e`/`#p`/`#<x>` filters. No external migration tool.
- **Cloud Run spec ready**: `znostr-service.yaml` — app (`znostr-relay`) + zeropg-db
  sidecar, `maxScale=1` / `minScale=0`, NO redis, container-dependency gate.

### What's left before this can be called "done"
1. **Local round-trip verification is unconfirmed.** No automated test/verify artifact
   exists yet. Need: connect a real Nostr client (or `nostr-tools`), publish a signed
   `EVENT`, open a `REQ` subscription with a filter, assert the event comes back, and
   read the row straight out of the zeropg DB. (This is the acceptance bar every other
   app cleared; the relay was built but this last step wasn't recorded.)
2. **Deploy to Cloud Run + GCS** is not done. The `znostr-service.yaml` + db sidecar
   exist but the image build/deploy and a live publish→subscribe over the public URL
   (plus a cold-restart durability check — event survives a forced fresh instance,
   restored from GCS) are pending.
3. **Known boot race (mitigated):** the zeropg-db sidecar reports `/healthz` before its
   Postgres wire is actually restored, so the relay's first DB connects can be refused.
   Handled with retry+backoff in `bootstrap()` (commit `1eeb6cd`); watch for it on the
   live deploy where restore-from-GCS takes longer.

## Recommendation when this resumes
Finish **znostr-relay** (steps 1–2 above) and make it the canonical Nostr-on-zeropg
demo — it is the only one of the three that is both unblocked AND genuinely
scale-to-zero. Treat nostream+valkey as a documented "also runs, but needs Redis"
footnote, and leave nostr-rs-relay parked behind the pglite-socket prepared-statement
patch.

## Related
- The Rust/sqlx blocker + ranked fixes: `docs/TODO-pglite-socket-prepared-statements.md`
- Driver compatibility boundary (unnamed vs named prepared statements):
  `docs/POSTGRES-APP-COMPAT.md`
