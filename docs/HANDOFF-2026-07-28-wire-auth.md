# Handoff: wire layer, TLS, auth. 2026-07-28

Written mid-session because the machine may go away. Read this first, then
[CONNECTION-SECURITY-AND-WIRE.md](CONNECTION-SECURITY-AND-WIRE.md) for decisions and
[WIRE-AUTH-RESEARCH-2026-07-28.md](WIRE-AUTH-RESEARCH-2026-07-28.md) for the evidence.

## The single most important result

**The named-prepared-statement wall is ~45 lines, not a deep rewrite.**

`docs/POSTGRES-APP-COMPAT.md:169-177` assessed per-connection prepared-statement namespacing
against pglite-socket source and concluded it is "a DEEP/architectural change, not a small
patch", because pglite-socket frames messages by length prefix only and forwards opaque
bytes, so rewriting statement names would require adding a real wire-protocol parser.

That is true **of pglite-socket**. It is not true of the problem. A research agent built the
rewriter on top of **pg-gateway**, which already parses the protocol, and verified it:

- Without it: connection B preparing `s1` fails with `42P05`.
- With Parse/Bind/Describe/Close/Execute names prefixed per connection: both connections
  prepare `s1`, and A's statement still resolves afterwards.
- Caveats found: SQL-level `PREPARE`/`DEALLOCATE` bypass the rewriter (`26000`), and
  `pg_prepared_statements` shows the prefixed name.

This is the blocker for Rust **sqlx** and **Diesel** (and therefore nostr-rs-relay and
rsky-pds). `docs/TODO-pglite-socket-prepared-statements.md` has written acceptance criteria already:
nostr-rs-relay boots with no 42P05 and completes a NIP-01 round trip, the 5 existing
unnamed-statement apps do not regress, and two concurrent connections each preparing `s1`
both succeed.

Reconcile the two docs. `POSTGRES-APP-COMPAT.md` should be amended to say the assessment was
scoped to pglite-socket and is superseded by the pg-gateway result.

## Build vs adopt: adopt pg-gateway, with eyes open

`pg-gateway` (supabase-community, Greg Richardson, MIT, npm `pg-gateway`) is a full
server-side Postgres v3 frontend that hands post-auth bytes to a hook. Its own examples front
PGlite. **It is already a devDependency here at `^0.3.0-beta.4` and already spiked at
`experiments/prisma-spike/pggw.ts`**, and `docs/ORM-ADAPTER-NOTES.md:255-262` already
recommends swapping `serveWire` onto it.

Verified live against real libpq (psql 18.4) with a self-signed CA, TLS, and scram-sha-256:

| case | result |
|---|---|
| `sslmode=require` | works |
| `sslmode=verify-full` | works |
| `sslmode=disable` | correctly rejected, `08P01` |
| wrong password | standard `FATAL password authentication failed` |
| `channel_binding=require` | fails - only SCRAM-SHA-256 advertised, never -PLUS. Harmless, libpq defaults to `prefer` |

### Maturity is split, and the web lies about it

`main` is frozen at v0.2.4 (July 2024) with only cleartext/md5/cert auth. That stale README
is what search returns, which is why every summary claims pg-gateway has no SCRAM. The real
code is on the unmerged branch `next` (PR #21, open since 2024-09-13, 139 commits), published
only as `0.3.0-beta.4` on 2024-12-23 and untouched for 19 months.

That beta **does** implement SCRAM-SHA-256, platform adapters, and SNI. It is not a toy:
firebase-tools 15.24.0 depends on `pg-gateway@^0.3.0-beta.4`, driving 7.2M npm downloads a
month. windmill, netlify/primitives, nocodb/sql-control and supabase-community/database-build
also use it.

So we would be adopting an unmerged beta from a stalled branch. Plan for vendoring or forking.

### Three real defects found by probing, fix before shipping

1. **Remote process kill.** A client that rejects the server cert (TLS alert `unknown_ca`)
   triggers an unhandled `ERR_INVALID_STATE` "WritableStream is locked" at
   `connection.ts:228` and **kills the whole Node process.** Reproducible, remote, trivially
   triggerable. This is a denial of service on any deployment.
2. **No protocol 3.2 negotiation.** A PG18 libpq startup with `max_protocol_version=latest`
   hits `Unexpected initial message`. There is no `NegotiateProtocolVersion`.
3. **No BackendKeyData**, and `CancelRequest` (80877102) falls into the same
   `Unexpected initial message` throw.

### The blocking regression risk

**pg-gateway has zero cross-connection serialization.** pglite-socket's transaction-aware
`QueryQueueManager` is what makes the Supabase RLS story safe today: while a transaction is
open it dispatches only that handler's statements, so PostgREST's per-request
`BEGIN; SET LOCAL role; ...; COMMIT` is atomic. Proven with a 2s held transaction plus 100
concurrent cross-user reads, zero claim bleed.

Swapping the wire layer loses that unless we port it. **This is a data-isolation correctness
issue and must be settled before any swap.** Re-run `test/killswitch-rls-isolation.mjs`.

## What Neon and Supabase actually do

**Neon.** TLS is hard-required, behaving like a `pg_hba.conf` with only `hostssl` records.
`sslmode=disable` gets `connection is insecure (try using sslmode=require)`. SCRAM-SHA-256 is
the default, and the proxy also speaks SCRAM-SHA-256-PLUS with `channel_binding`. No client
certs anywhere. They need SNI because the Postgres startup packet carries no hostname, so the
proxy cannot route to a compute before auth - a problem we do not have, since one instance is
one database.

Most relevant to us: **Neon's HTTP `/sql` endpoint is fully parameterized.**
Body is `{"query": "...", "params": [...]}`, or `{"queries": [...]}` for a batch. Params are
bound as text with server-side type inference, and responses carry per-column `dataTypeID` so
client-side type parsers still work. Credentials ride in a `Neon-Connection-String` header.
**We should copy this shape verbatim** rather than inventing one.

Their auth layering is worth stealing: layer 1 is Postgres role auth (SCRAM); layer 2 is Neon
Auth, which stores users in a `neon_auth` schema *inside your database*, issues a JWT, and
never becomes a Postgres login - the proxy validates the JWT and connects as a fixed
`authenticated` or `anonymous` role, exposing identity to RLS via `auth.user_id()`.

**Supabase.** TLS is **optional by default**, deliberately: "to maximize client
compatibility." Their `pg_hba.conf` is `host all all 0.0.0.0/0 scram-sha-256`, not `hostssl`.
None of the connection strings they ship contain an `sslmode` param. They do ship a CA cert
and document `verify-full`, but nothing forces you there.

Their naive-developer path is a cautionary tale worth reading in full in the dossier:
`new Pool({connectionString: DATABASE_URL})` gets you a **silent plaintext connection across
the public internet carrying a superuser password**, because `pg` defaults to `ssl: false`
and their hba permits it. Appending `?sslmode=require` then fails with
`SELF_SIGNED_CERT_IN_CHAIN` against their private CA, and the internet's answer is
`rejectUnauthorized: false`, which lands you back at unverified.

**Design lesson for us: Neon's posture is the right one.** Require TLS, use a publicly
trusted or explicitly distributed CA, and never ship a connection string whose happy path is
plaintext.

## Prior art in this repo: mostly settled, do not redo

The repo has months of design work on this. Established and not to be re-litigated:

- **zeropg has no built-in auth anywhere, by stated design**
  (`docs/EDITOR-AUTH-SECURITY.md:18-21`). The wire accepts any username and password. Every
  security property comes from network placement plus gates in front.
  `packages/server/src/postgrest.ts:79` says it outright: "No password: pglite-socket accepts
  any startup."
- The console is loopback-only and refuses to widen. The one wide-bound mode (`--inspector`)
  uses a 192-bit bearer token to a `zpt` cookie, with read-only detached replicas. A
  three-rung hardening ladder is already specced with `ConsoleAuth` shaped for rung three.
- The load-bearing rule: read-write access sits behind your machine plus GCS IAM; the
  wide-bound cloud surface holds only disposable read-only snapshots. Inverting that is
  named as "the line not to cross."
- `DISCARD ALL` at connection close is **unsafe** as a general fix - it nukes a concurrent
  peer's statements on the shared session.
- True session-per-connection is **impossible**. PGlite is single-instance, single-session.
- Verified driver escape hatches, all DSN-only: pgx v5 `cache_describe` (**not**
  `simple_protocol`, which breaks JSONB with `22P02`), pgx v4/pop `statement_cache_mode=describe`,
  PostgREST `db-prepared-statements=false` + pool=1.

### Doc contradictions found, worth fixing

- `docs/TODO-pglite-socket-prepared-statements.md` calls the namespacing fix "bounded,
  localized" and recommends it; `POSTGRES-APP-COMPAT.md` calls it deep and architectural.
  Both are now partly wrong - see the top of this file. Reconcile.
- That same TODO still prescribes pgx `simple_protocol`, which was corrected to
  `cache_describe`.
- `docs/STATUS-nostr-relay.md` says the nostr work is unfinished; README and
  POSTGRES-APP-COMPAT record it verified live. Mark it superseded.
- `docs/ORM-ADAPTER-NOTES.md` header says "nothing here is concluded" while its second half
  contains verified conclusions, and the file has a corrupted tail: stray `</content>` and
  `</invoke>` XML artifacts after line 299.
- `docs/FLEET.md` gives two different homes for `contexts.json`.
- **Known unfixed deviation:** `examples/cloudrun/supabase/test/up-local.mjs:48` sets
  `ZEROPG_WIRE_HOST: '0.0.0.0'`, so while that harness runs, an unauthenticated superuser
  wire is on the LAN.

## In flight right now

**On the `blob-pglite-dev` VM, session `sslfix`, `~/zeropg` on `main`, unpushed.** That
checkout is AHEAD of the laptop. It carries commit `9da362e` (WireFrontend answering
SSLRequest/GSSENCRequest, plus the peer-dep fix taking an install from 28 MB to 1.2 MB).

Four fixes dispatched, in priority order if context runs short (the agent was at 89%):

1. **DONE, commit `d071f75`, test-green.** `POST /sql` accepts bound params, forwarding to
   `ZeroPG.query(sql, params)` which already took them
   (`packages/objectstore-fs/src/zeropg.ts:1247`). The now-false throw in
   `packages/client/src/remote.ts` is gone.
2. **DONE, same commit.** `POST /sql` accepts multi-statement SQL via `db.exec()`
   (`zeropg.ts:1242`) behind an explicit `multi: true` flag, not SQL sniffing.
3. Connection-cap rejection becomes a real `ErrorResponse` (SQLSTATE `53300`) emitted from
   WireFrontend, replacing pglite-socket's raw `"Too many connections\n"` write. Plus
   `maxConnections` as an option accounting for PostgREST's pool.
4. README connection ladder corrected so `gs://` is not advertised as working.

Commit `d071f75` is verified by `packages/client/test/remote-sql.test.ts`, 11 assertions
against a real `ZeroPGServer` over HTTP: multi-statement migration, parameterized
INSERT/SELECT/UPDATE with a real `rowCount`, an injection attempt round-tripping as data with
the table intact, and the `multi` + `params` rejection. It also fixed a latent bug where
`shutdown()` left the public HTTP listener open, hanging any embedding caller.

Queued but not yet done: accept `query` as an alias for `sql` in the `/sql` body, so callers
reaching for Neon's shape also work.

Also told the agent: pglite-socket 0.2.3 already added `handleSslRequest()` replying `'N'`,
and the root `package.json` pins `^0.2.2`. Bump to `>=0.2.3`, re-run the sslmode tests, keep
WireFrontend for GSSENC (still unhandled even in 0.2.4), the cap, and owning the port. Fix
the stale comment at `packages/server/src/postgrest.ts:80-86`.

**Not dispatched, deliberately:** the auth fail-closed change. The credential model is still
open, and may collapse the HTTP bearer token into a real Postgres password once SCRAM exists.

## Open decisions for the owner

1. **Does the HTTP bearer token survive?** If an instance has a Postgres password, `/sql`
   could take HTTP Basic with the same credential and the token concept disappears. Neon
   keeps them separate (connection string in a header). Supabase keeps them very separate
   (API keys that become role switches, never passwords).
2. **Credential provisioning precedence** across env var, file, auto-generated-into-bucket,
   and secret manager. The bucket argument ("bucket readers already have the whole database")
   needs stress-testing against read-only replicas, the inspector snapshot flow, signed URLs,
   and shared buckets.
3. **Hold indefinitely or with a ceiling** on cold-start connection holding. Current lean: a
   ceiling with an `ErrorResponse` naming the boot phase, because a silent hang is the exact
   failure this whole effort exists to remove.
4. **TLS on loopback**: likely theater for the sidecar topology, real for Fly.io where a
   public TCP port is forwarded. Decide whether to require it anyway for uniformity.
5. **Adopt-and-vendor or fork pg-gateway**, given `next` has been stalled 19 months.

## Still running when this was written

- Workflow `wf_b11c25b5-063`: the pglite-socket-internals research track, then design and
  adversarial critique phases, then synthesis. Transcripts under
  `~/.claude/projects/-Users-user-workspace-blob-pglite/b9b81f00-ad6e-41ca-bbf4-71186ef30832/subagents/workflows/wf_b11c25b5-063/`.
  Completed results are already captured in the dossier.
- A separate agent designing cold-start absorption at the wire, cross-referencing
  `docs/LAZY-PAGEFAULT-RESTORE-from-blob.md`.

**That question is now ANSWERED and no longer gates anything.** PGlite does emit its own
handshake, so the double sequence is real, and handling it is ~20 lines: frame and discard
the backend's handshake up to its `ReadyForQuery`, then forward the rest. Prototyped against
real psql. The in-process path avoids it entirely.

Better still, PGlite's handshake is a **hardcoded constant** - independently reproduced twice,
byte-identical at 429 bytes with the same SHA-256 across a fresh instance, a second instance,
a datadir carrying `ALTER DATABASE ... SET`, that datadir reopened, and a client sending
`user=alice database=nope application_name=myapp`, down to `BackendKeyData pid=42
secret=2875488`. So synthesizing it before the database exists loses nothing already lost.

See [COLDSTART-ABSORPTION.md](COLDSTART-ABSORPTION.md). Its two consequences for this plan:

- The `maxConnections` raw-string fix (item 3 above) is promoted from nice-to-have to
  **prerequisite**. Handshake-early would tell a client "connected", hold it for seconds,
  then kill it with a non-protocol string.
- pg-gateway does not send `BackendKeyData` today, which the handshake-early design needs.
