# Connection security, authentication, and the wire layer

Status: **research + decisions in progress, 2026-07-28.** This file is the durable record of
a working session. Sections marked VERIFIED were tested on a real machine and the transcript
is reproduced. Sections marked OPEN are not yet decided.

Trigger: a Claude agent integrating an unrelated app against zeropg 0.1.0 failed on five
separate things and concluded the database did not work. Four of its five findings were
correct. That transcript is the specification for this work: **the default assumptions a
Postgres developer holds must either work or fail with an error that says what to do.**

---

## 1. VERIFIED: the current security posture is wrong by default

`packages/server/src/server.ts:252`:

```js
this.http.listen(this.opts.port, () => ...)
```

No host argument, so Node binds `0.0.0.0` - all interfaces. `scripts/deploy.sh:55` then
deploys that image with `--allow-unauthenticated`.

`ZeroPGServerOptions` (`packages/server/src/server.ts:35-68`) has **zero** authentication
fields. The routes at `server.ts:283-324` are all unauthenticated:

| route | effect if reachable |
|---|---|
| `POST /sql` | arbitrary SQL as superuser |
| `POST /flush` | force a durable commit |
| `POST /wake` | force a restore (each one is billable) |
| `GET /metrics` | label, timings, instance identity |
| `/rest/*` | PostgREST proxy, anon role |

So the shipped default deploy path publishes arbitrary superuser SQL on a public URL. This
is the MongoDB default-open mistake, and the fix is the same one Mongo shipped in 3.6: not a
firewall, but a default bind change plus auth required in order to expose.

Note the inconsistency this exposes. `wireHost` was carefully defaulted to loopback
(`server.ts:44-48`) while the HTTP face, which is the one that actually executes SQL, was
left open. That was not a considered tradeoff.

## 2. VERIFIED: PGlite has no authentication of any kind

Not a choice we made and declined to revisit - it does not exist below us.

PGlite has no `pg_hba.conf`, no SCRAM, no role check at connect time. And `pglite-socket`
accepts exactly these options (`node_modules/@electric-sql/pglite-socket/dist/index.d.ts:70-87`):

```
db, port, host, path, inspect, debug, idleTimeout, maxConnections
```

No password. No TLS. No auth callback. It never performs the startup auth exchange at all.

**Consequence: anyone who reaches the wire port is `postgres` superuser.** The loopback
default on `wireHost` is therefore not a preference, it is the entire access control
mechanism. Setting `wireHost: '0.0.0.0'` to "make it reachable" hands out unauthenticated
superuser, and unlike the HTTP face there is no token to fall back on.

Adding real auth means implementing the SCRAM-SHA-256 handshake ourselves. See section 6.

## 3. VERIFIED then FIXED: libpq at its default sslmode hung silently

pglite-socket never answers `SSLRequest` (protocol code 80877103). Not even `'N'` to decline.
A client at libpq's **default** `sslmode=prefer` sends the 8-byte SSLRequest, gets nothing
back, and hangs with no error. Reproduced locally and allowed to run 2 minutes with no
timeout and no error.

That is why every doc in this repo says `?sslmode=disable` - it was working around a silent
stall, not expressing a preference.

**Fixed on the `blob-pglite-dev` VM in commit `9da362e`** ("wire: answer
SSLRequest/GSSENCRequest so libpq at default sslmode stops hanging"). The approach:

- New `packages/server/src/wire-frontend.ts` (199 lines). A TCP front-end owning the public
  port. Peeks the first 8 bytes, replies `'N'` to SSLRequest (80877103) and GSSENCRequest
  (80877104), then proxies the same socket as plaintext to an inner `PGLiteSocketServer` on
  a private loopback port.
- `sslmode=prefer` now falls back to plaintext. `sslmode=require` gets a clean
  "server does not support SSL" error instead of hanging.
- Byte framing handled: buffers until 8 bytes are available before deciding, forwards any
  already-read remainder. Both a coalesced SSLRequest+StartupMessage and an SSLRequest split
  across segments work.
- Shared by both call sites: `serveWire()` in the client and `ZeroPGServer`.
- Tests in `packages/client/test/wire-sslmode.test.ts` drive **real libpq** (`/usr/bin/psql`)
  for prefer/disable/require plus byte-level framing cases.

The same commit also fixed inverted peer dependencies: `@electric-sql/pglite` was a mandatory
peer, so installing `@zeropg/client` pulled 28 MB (26 MB of it WASM) even for a project
pointing at a real `postgres://` host. Now optional and loaded on demand. A tarball into an
empty project is 1.2 MB with no `@electric-sql/*`, and `postgres://` works with just
`npm i pg`. `wire.ts` deep-imports via a new `@zeropg/server/wire-frontend` subpath rather
than the barrel, which would re-pull objectstore-fs and PGlite.

Behavior change to note in the changelog: `sslmode=require` now errors rather than hanging.
Correct, but visible.

## 4. VERIFIED: the wire is NOT broken, and the error that says it is comes from a raw string

An external agent reported `Connection terminated unexpectedly` from a single `pg.Client` on
loopback and concluded the wire protocol was broken. It is not.

Tested locally against `ZeroPGServer` with a bucket-backed store:

```
{"event":"wire-up","port":55432,"ms":5}
{"event":"ready","readyMs":1486,...}
SINGLE CLIENT CONNECTED
PARAM INSERT OK [ { id: 1, title: 'engineer' } ]
PARAM SELECT OK [ { id: 1, title: 'engineer' } ]
```

Bound parameters over the wire work. Single client works.

**The real cause** is in pglite-socket's `handleConnection`
(`node_modules/@electric-sql/pglite-socket/dist/chunk-TORNJX5U.js`):

```js
if (this.handlers.size >= this.maxConnections) {
  e.write(Buffer.from("Too many connections\n")); e.end(); return
}
```

That is not a Postgres `ErrorResponse`. It is a raw non-protocol string followed by a socket
close, so the client has nothing to parse and reports whatever the socket did:
`Connection terminated unexpectedly` on a clean FIN, `read ECONNRESET` on a race. Both were
reproduced.

Two things consume the slots:

- pglite-socket's own default is `maxConnections: 1`. `@zeropg/server` raises it to 10
  (`server.ts:166`).
- **PostgREST is default-ON** (`server.ts:114`) and holds wire connections the caller never
  opened.

So a `pg.Pool` at its default `max: 10` plus PostgREST exceeds the cap, and an "isolation
test" run against an already-running server can hit slots still held by a previous pooled run.

Diagnostic that settles it in one shot - raw socket, print what comes back:

```js
import net from 'node:net'
const s = net.connect(5432, '127.0.0.1', () => s.write(Buffer.from([0,0,0,8,4,210,22,47])))
s.on('data', d => console.log('GOT:', JSON.stringify(d.toString())))
```

Literal `"Too many connections\n"` confirms it.

**Fix required:** replace with a protocol-legal `ErrorResponse` (SQLSTATE `53300`,
`too_many_connections`). Owning the frontend makes this trivial.

## 5. VERIFIED then FIXED: the HTTP `/sql` face rejected what real apps send

**Fixed on the `blob-pglite-dev` VM in commit `d071f75`**, test-green with 11 assertions
(`packages/client/test/remote-sql.test.ts`, drives a real `ZeroPGServer` over HTTP through
the unified client). The shipped request shape:

```json
{ "sql": "insert into users (email) values ($1) returning id", "params": ["a@b.c"] }
{ "sql": "create table a (...); create table b (...);", "multi": true }
```

`multi` and `params` are mutually exclusive and the combination is rejected with an error
saying why, since the simple protocol cannot bind. A `multi` response carries `multi: true`
and `rows: null` rather than an empty array a caller would misread as "0 results". The test
covers a quote-laden value (`o'brien@x.com'; drop table users; --`) round-tripping verbatim
with the table surviving.

Neon's equivalent endpoint uses `{"query": ..., "params": [...]}`. Accepting `query` as an
alias for `sql` is queued, so that both likely guesses at the API work.

The same commit fixed a latent bug found on the way: **`shutdown()` never closed the public
HTTP listener**, so an embedding caller hung after `shutdown()` resolved. The signal handlers
only got away with it because they call `process.exit()`.

Original diagnosis follows, kept because it explains why these were not deep problems.

Three real gaps, all shallower than their error messages claim.

**No bound parameters.** `packages/server/src/server.ts`, the `sql()` handler does:

```js
const { sql } = JSON.parse(raw) as { sql: string }
const r = await this.db.query(sql)
```

It parses only `sql` and drops any params. But `ZeroPG.query(sql, params?)` at
`packages/objectstore-fs/src/zeropg.ts:1247` **already accepts params** and forwards them to
PGlite. The client-side error text in `packages/client/src/remote.ts` says parameters are
"a wire-protocol feature" - that overstates it. They are a thing nobody wired into `/sql`.
Roughly a five-line fix.

**No multi-statement.** `/sql` calls `db.query()`, which is extended protocol and therefore
single-statement, producing `cannot insert multiple commands into a prepared statement`.
`db.exec()` sits directly above it at `zeropg.ts:1242` and is simple-protocol multi-statement.
Migrations over HTTP are a real use case.

**No transactions.** Correctly documented as a stateless-HTTP consequence in `remote.ts`.

The deeper bug behind all three: one `Client` interface, two engines that accept different
things. An app developed against `file://` works completely and breaks on its first deployed
write. That divergence is the design defect, not any individual missing feature.

## 6. OPEN: replacing pglite-socket with a wire server we own

Decision pending. `WireFrontend` (section 3) is the first step and already exists - it owns
the public port and peeks the startup bytes. The question is how much further to go.

What owning the full frontend would unlock:

- **Real TLS.** Reply `'S'` and upgrade the socket instead of declining with `'N'`.
- **SCRAM-SHA-256.** The only route to a Postgres password, since PGlite enforces nothing.
- **Protocol-legal errors**, replacing the raw "Too many connections" write.
- **CancelRequest** (80877102) on a second connection.
- **Per-connection prepared-statement namespacing**, which is the assessed-as-deep fix for
  the 42P05 collisions that block Rust `sqlx` and Diesel. See `docs/LIMITATIONS.md` and
  `docs/POSTGRES-APP-COMPAT.md` Limitation 5.
- **Cold-start absorption.** See section 8.

The single most important unverified question, which must be settled by experiment before
committing to build:

> Can we terminate auth ourselves and then hand PGlite a byte stream, or does PGlite
> generate its own AuthenticationOk / BackendKeyData / ReadyForQuery such that doing our own
> SASL exchange produces a **double authentication sequence** that confuses clients?

Read the actual PGlite code under `node_modules/@electric-sql/pglite/dist/` rather than
speculating. Everything else in the build-vs-adopt decision depends on the answer.

Build-vs-adopt is also open. **`pg-gateway`** (supabase-community, TypeScript, a Postgres
wire server designed to front PGlite, believed to support TLS and SASL) may make this an
adoption rather than a build. Verify existence, license, and maturity before scoping a build.

## 7. OPEN: the credential model

The design sketched and provisionally agreed, subject to the research still running:

**Fail closed.** New `authToken` option plus `ZEROPG_AUTH_TOKEN`. At boot:

| bind host | credential set | behavior |
|---|---|---|
| `127.0.0.1` | no | run, no auth - the kernel is the perimeter |
| `0.0.0.0` | yes | run; mutating routes require the credential |
| `0.0.0.0` | no | **refuse to boot**, naming the env var and the opt-out in the error |

Escape hatch `insecure: true` / `ZEROPG_INSECURE_NO_AUTH=1`, logged loudly at **every** boot
so it cannot sit unnoticed.

Route classes:

- **Gated**: `/sql`, `/flush`, `/metrics`.
- **Open**: `/up`, `/livez`, `/ready`, `/wake`, `/`. `/wake` stays open because browser
  pre-warm depends on it. It is a billing-amplification surface (a wake loop is paid
  restores) and must be documented as one.
- **Not our layer**: `/rest`. PostgREST has its own JWT+RLS model. But anon-role plus no RLS
  is the same class of hole, so a boot warning is warranted.

Compare credentials by SHA-256 digest through `timingSafeEqual`, so neither content nor
length leaks.

Client side needs little: `connect(url, { headers })` already exists
(`packages/client/src/remote.ts:57-64`). A **static shared secret is exactly what static
headers are good at**. The thing that breaks with Cloud Run IAM is ID tokens expiring hourly;
a zeropg-native token does not expire. Add `ZEROPG_AUTH_TOKEN` pickup in `connectRemote` and
it is symmetric and zero-config.

### Provisioning - flexibility wanted, precedence to be fixed

Sources to support, precedence order OPEN:

1. `ZEROPG_AUTH_TOKEN` env var
2. a file on disk
3. auto-generated at first boot, stored in the object store next to the manifest, retrieved
   via `zeropg fleet token <service>`
4. platform secret manager

The argument for (3): anyone who can read the bucket already has the entire database, so the
credential is strictly weaker than the access needed to obtain it. **This argument must be
stress-tested** - read-only replica service accounts, the inspector snapshot flow, signed
URLs, cold backup exports, GCS uniform vs fine-grained ACLs, and buckets shared across
databases with different owners are all places it may fail.

**Never print the token to stdout or logs.** Cloud Run logs have a wider reader set than the
bucket, which inverts the argument above. Log
`auth token provisioned; retrieve with 'zeropg fleet token <service>'` and nothing more.

### The question that may delete this whole section

**Is the bearer token redundant if we implement SCRAM plus TLS properly?** If an instance has
a Postgres password, `POST /sql` could accept HTTP Basic with the same credential and the
token concept disappears. Research into how Neon and Supabase layer this is running.

Stated plainly either way: a token in front of a public `/sql` guards arbitrary superuser
SQL with a single shared secret. It converts wide-open into one-secret-away. The recommended
topology stays loopback-sidecar. **Auth is the backstop for when someone ignores that, not
permission to expose the face.**

## 8. OPEN: cold-start absorption at the wire

Today `boot()` runs `phase='restoring'` (`ZeroPG.open`) first and only reaches `phase='wire'`
at `server.ts:155-168`. **The wire port does not listen during cold start**, so clients get
`ECONNREFUSED`. `docs/LIMITATIONS.md` documents this as "apps must retry the initial DB
connection". pglite-socket cannot fix it because it is a byte-forwarder with no handshake of
its own.

Owning the frontend splits the sequence:

1. **Listen at process start**, before PGlite exists. Accept TCP, upgrade TLS, run SCRAM (the
   credential is ours, PGlite is not involved), send `ParameterStatus` + `BackendKeyData` +
   `ReadyForQuery`. The client is connected.
2. **Hold the first real query** until restore lands. Cold start becomes query latency
   instead of a connection error.

The timeout math favors this, and specifically rescues Prisma. The defaults that matter are
*connect* timeouts: libpq `connect_timeout` 0, node-postgres `connectionTimeoutMillis` 0,
JDBC `loginTimeout` 0. But **Prisma defaults `connect_timeout` to 5s**, and that 5s currently
races an 11s restore against a port that is not listening. Handshake-early satisfies it, and
the held query then runs under a query timeout that is unset in almost every stack.

Inverted risk worth checking: a pool that deliberately sets `connectionTimeoutMillis` is now
being *lied to* about readiness.

**The lease is the sharp edge.** `ZeroPG.open()` acquires the lease and can throw
`FencedError` if another instance took over. Completing handshakes before the lease is
settled means telling a client "connected" to a database we may not own. Held queries need a
protocol-legal `ErrorResponse` path for both "restore failed" and "we got fenced". The
handshake-early window must be understood as: TCP and auth are real, **writership is not yet
confirmed.**

Middle tier worth evaluating: answer queries needing no data immediately (`SELECT 1`, `SET`,
`SHOW`, pool validation queries, health checks) while holding the rest. Requires replaying
`SET` onto the real session once it boots - design that or drop the idea.

The schema-only variant (preload schema, answer arbitrary SQL) is rejected as stated: you
cannot answer data queries from a schema, and guessing is worse than waiting. A narrower
version - serving ORM catalog introspection from a cached schema snapshot - may be worth it
but carries a staleness correctness risk.

**Product decision OPEN: hold indefinitely, or hold with a ceiling?** Holding forever means a
broken restore looks like a hang, which is exactly the failure mode this whole effort exists
to eliminate. Current lean: a ceiling (roughly 30s) with an `ErrorResponse` naming the boot
phase it died in.

The deeper version of this idea already has a design doc:
[LAZY-PAGEFAULT-RESTORE-from-blob.md](LAZY-PAGEFAULT-RESTORE-from-blob.md).

## 9. VERIFIED: the connection ladder advertises a rung that throws

`connect()` with `gs://` / `r2://` / `s3://` / `cos://` throws at
`packages/client/src/index.ts:93`:

```
connect: bucket-scheme 'gs://' (embedded bucket-backed engine) is not wired yet.
```

The README's connection ladder advertises it. Either implement it or correct the README.
Leaving both in place is what sent an external agent down a dead end as its very first step.

## 10. The five real failures to regression-test against

From the external agent's transcript. Every future change should be checked against this list.

1. `gs://` in `DATABASE_URL` is not implemented while the README advertises it.
2. `POST /sql` rejects bound parameters, and every real repo layer uses `$1`. Inlining is an
   injection hazard, so there is no workaround.
3. Multi-statement DDL works on `file://` and fails over HTTP.
4. `Connection terminated unexpectedly` on the wire, wrongly diagnosed as a broken wire. Real
   cause: over-cap rejection via a raw non-protocol string, with PostgREST default-ON eating
   slots.
5. `/sql` has no auth, so a separate database service cannot be deployed safely. The agent
   correctly abandoned that topology on its own.

Its own summary of the pattern is the most useful sentence in the transcript:

> both engines share one `Client` interface but disagree on what it accepts, so an app
> developed on `file://` works completely and breaks on its first deployed write.

## 11. Repository state, 2026-07-28

- Local checkout `/Users/user/workspace/zeropg` is on `main` at `b6ffad2`.
- The `blob-pglite-dev` VM checkout `~/zeropg` is on `main` at `9da362e`, one commit ahead,
  carrying the SSLRequest fix and the peer-dependency slimming. Not pushed to any remote.
- Published packages are `@zeropg/{blobstore,lease,objectstore-fs,server,client}` at `0.1.0`.
  Next release is `0.1.1`; version increments stay slow.
