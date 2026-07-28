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

## 5.5. CRITICAL, found 2026-07-28: forwarding the wrong packet to PGlite is a one-packet DoS

**Do not let these message types reach `execProtocolRaw`.** Verified by probing a live PGlite:

| packet | effect on the WASM instance |
|---|---|
| `SSLRequest` (80877103) | throws `ExitStatus: exit(1)` and **permanently corrupts the instance**. The next startup packet throws `RuntimeError: null function or function signature mismatch` and the response stream desynchronizes |
| `GSSENCRequest` (80877104) | identical |
| `CancelRequest` (80877102) | throws `Cannot process startup packet` |
| `PasswordMessage` (`'p'`) | **infinite synchronous spin** inside `_PostgresMainLoopOnce`, blocking the entire Node event loop. A 20-second `setTimeout` never fired; the process had to be killed |
| unknown type (`'q'`) | same infinite spin |

The last two are a **remote, unauthenticated, single-packet denial of service** against any
zeropg instance whose wire port is reachable.

**Why we are not currently vulnerable, and why that is luck rather than design:**
pglite-socket's framer mis-sizes those packets and buffers forever instead of forwarding
them. We survive because the shim is sloppy, not because anything checks.

**This constrains every design in this document.** Any frontend we own, or adopt, must treat
the set of message types it forwards as an **allowlist**, never a passthrough. Getting more
faithful at framing without adding that allowlist would convert a latent bug into a live
remote DoS. `WireFrontend` (commit `9da362e`) already intercepts SSLRequest and GSSENCRequest,
which is exactly right and now has a much stronger justification than "libpq hangs".

Add a regression test that fires each of these packets at the wire and asserts the process
stays alive and the instance stays usable.

## 6. RESOLVED: replacing pglite-socket with a wire server we own

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

### ANSWERED 2026-07-28: we can own auth entirely. The question is closed.

The question was: can we terminate auth ourselves and hand PGlite a byte stream, or does
PGlite generate its own AuthenticationOk / BackendKeyData / ReadyForQuery such that our own
SASL exchange produces a **double authentication sequence** that confuses clients?

**There is no double-auth sequence, because there is no auth.** A brand-new PGlite answers
`Query "SELECT 1"` correctly with **no startup packet ever sent** - it is already a logged-in
single-user backend. The handshake only appears if you choose to forward a startup packet.

Where it comes from when you do: PGlite runs the real Postgres C path.
`execProtocolRawSync` (`pglite/src/pglite.ts:876`) branches on `message[0] === 0` into
`#processStartupPacket` (line 1308), calling the genuine `ProcessStartupPacket()` with
`ssl_done=true, gss_done=true`, then `_pgl_sendConnData()`. That emits the 429-byte block:
`AuthenticationOk`, 16 `ParameterStatus` messages, `BackendKeyData(pid=42, key=2875488)`,
`ReadyForQuery('I')`. **The WASM Postgres does 100% of the handshake; the shim does 0%.**

Two clean implementations, and the second is better:

- **(a) Never forward the startup packet** and synthesize `ParameterStatus` yourself. This is
  what the existing pg-gateway spike does at `experiments/prisma-spike/pggw.ts`, faking
  `serverVersion: '16.3'` - note the fake drifts from the real `18.3`.
- **(b) Forward one startup packet at boot, cache the real 429-byte block, strip `R` and `K`,
  rewrite the trailing `Z` to `'I'`, and replay it per connection.** Clients then see PGlite's
  actual GUCs rather than our guesses.

**And PGlite enforces nothing.** `{user: nosuchuser, database: nosuchdb, password: hunter2}`
returns `AuthenticationOk` immediately, with `current_user` = `postgres`. `options=-c
search_path=...`, `application_name`, and `client_encoding=LATIN1` are all silently discarded:
a following `SHOW` returns `public`, empty, and `UTF8`. So any user/role story we want is
ours to build on top, and any client-supplied startup option we care about must be replayed
by us as explicit SQL.

**The stronger result, independently reproduced twice:** PGlite's startup handshake is a
hardcoded constant. It does not depend on the datadir and does not depend on anything the
client sends. Probed across a fresh instance, a second instance, a datadir carrying
`ALTER DATABASE ... SET`, that datadir reopened, and a client sending
`user=alice database=nope application_name=myapp` - all byte-identical, 429 bytes, same
SHA-256, down to `BackendKeyData pid=42 secret=2875488`.

So synthesizing the handshake before the database exists loses nothing that was not already
lost. Fourteen of fifteen ParameterStatus keys are constants, `server_version` is pinned by
`package.json`, and only `TimeZone` tracks the process `TZ`, which we control.

Full evidence and design: [COLDSTART-ABSORPTION.md](COLDSTART-ABSORPTION.md).

Build-vs-adopt is also open. **`pg-gateway`** (supabase-community, TypeScript, a Postgres
wire server designed to front PGlite, believed to support TLS and SASL) may make this an
adoption rather than a build. Verify existence, license, and maturity before scoping a build.

## 7. DECIDED 2026-07-28: one credential per instance, and store the verifier not the password

> Full design in [WIRE-AUTH-RESEARCH-2026-07-28.md](WIRE-AUTH-RESEARCH-2026-07-28.md),
> section "DESIGN: CREDENTIAL AND AUTHENTICATION MODEL". Summary of the decisions:

**The bearer token is redundant. Delete it as a per-instance concept.** A zeropg instance is
one database, one role, one writer. The wire, `POST /sql` and `POST /flush` all confer
*exactly the same authority*: arbitrary superuser SQL. Two secrets guarding one authority is
not defence in depth, it is two things to leak and two to rotate. Collapse to the Postgres
role password: the wire verifies it with SCRAM-SHA-256, HTTP verifies the same password via
`Authorization: Basic postgres:<pw>` (also accept `Bearer <pw>`, because agents reach for it).
Neon is the precedent and it is decisive - their HTTP `/sql` takes a `Neon-Connection-String`
header carrying the same role password as the wire.

**The token survives only at fleet scope**, in the console and inspector, where the principal
is a human in a browser spanning N databases and there is no per-database credential to
present. Rename `INSPECTOR_TOKEN` so nobody confuses it with instance auth.

### The correction that rescues the bucket idea: store the SCRAM verifier

My "anyone with bucket read already has the whole database" argument **fails four ways if you
store cleartext**:

1. Bucket read gives you the database *as of the last commit*, offline, with no lease. A live
   password gives you **write** to the primary. Storing cleartext escalates read into write.
2. The inspector service account holds bucket read on **every** fleet prefix. Cleartext there
   converts a deliberate asymmetry into fleet-wide write compromise - literally the line
   `docs/EDITOR-AUTH-SECURITY.md` says not to cross.
3. `fleet export`, `gsutil cp -r`, archives and backups are designed to carry data, not
   credentials, and have different retention. A dump handed to a contractor would contain the
   production password.
4. GCS uniform bucket-level access has no per-prefix IAM, and `scripts/deploy.sh` puts every
   service in **one bucket** under a per-service prefix. A single `objectViewer` grant is
   every instance's password.

**So store the SCRAM verifier, never the password.** `SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`
is a one-way image, so bucket read grants nothing new against a 192-bit random secret, and the
original argument is restored. One stored artifact serves both faces: given cleartext from
Basic you recompute SaltedPassword to ClientKey to H(ClientKey) and constant-time compare
against StoredKey. User-supplied passwords are never written at all.

### Provisioning precedence

1. `ZeroPGServerOptions.password` (code wins)
2. `ZEROPG_PASSWORD_FILE` (K8s / Docker / Cloud Run secret-as-file)
3. `ZEROPG_PASSWORD` env
4. bucket-managed `auth.json` at the prefix root
5. `ZEROPG_AUTH=trust`, explicit only

If 1-3 resolve, compute the verifier and CAS it into `auth.json` so env and bucket cannot
drift. If none resolve and the store is writable, mint 192 bits, PUT `auth.json` with
if-none-match (create-only CAS, the same primitive as the manifest), and write the cleartext
to a **single-read claim object** that `zeropg fleet credential <name>` GETs-then-DELETEs,
expiring after 24h. **Never print the password to stdout** - Cloud Logging is readable by
`roles/logging.viewer` for 30 days. Note `collectGarbage` only walks `generations/`, so
root-level `auth.json` is safe from GC.

Rejected outright: platform secret-manager SDKs inside the server (every platform is a
dependency plus an IAM surface, and Cloud Run and K8s already project secrets into env or
files), and derivation from bucket credentials (the remote client has none, and on Cloud Run
the bucket credential is a rotating metadata OAuth token with no stable long-lived key).

### Fail-closed matrix

| bind | credential | behavior |
|---|---|---|
| loopback | none | start in trust mode, one WARN. Preserves every current example and the PostgREST sidecar |
| loopback | set | enforced everywhere except the always-open health tier |
| non-loopback | none | **refuse to start, exit 78**, naming the env var and the escape |
| non-loopback, HTTP | set | start (the platform terminates TLS); reject credentialed requests arriving over cleartext |
| non-loopback wire | set, no TLS | **DISPUTED - see section 7c. The credential designer said refuse; the wire designer ran an experiment showing that breaks the north star. Do not implement this row yet.** |
| any non-loopback | `ZEROPG_AUTH=trust` | refuse |

`wireHost=0.0.0.0` with no credential is the worst case in the system and becomes a hard
refusal. The single escape is `ZEROPG_ALLOW_INSECURE_BIND=i-understand` - **a value, not a
boolean**, so it cannot be set by typo and it greps. When it fires, `/ready` and the landing
page carry `"insecure": true` and the fleet CLI renders it red.

**Always unauthenticated:** `/up`, `/healthz`, `/livez`, `/ready`, `/wake`. They are the
scale-to-zero primitive - a cold client must reach them before it has anything. `bootError` is
redacted to a code when unauthenticated. `/metrics` and `/flush` require the credential.

`--allow-unauthenticated` stays in `deploy.sh`: public one-click URLs are the product, and the
fix is the app-level credential, not IAM.

### Rotation

`auth.json` carries `{current, previous, previousExpiresAt, epoch}`; both verifiers
authenticate during a 1h overlap. Instances re-read at boot, and they die constantly so most
pick it up for free. Writing `auth.json` needs bucket **write** IAM, which the operator has
and the read-only inspector does not, so the existing IAM boundary does the authorization -
no new trust boundary, no control plane. Rotation must never roll a sleep-durability instance
without `POST /flush` first. Recovery of a lost password is a reset, never a reveal.

### The regression net

`zeropg fleet doctor` actively probes every service for an unauthenticated `POST /sql` and a
wrong-password wire accept. That is what proves the MongoDB default is actually gone, rather
than believed gone.

## 7c. THE ONE REAL DISAGREEMENT: is TLS required or merely offered?

Two designers reached opposite conclusions. The disagreement is worth more than either answer,
so it is recorded rather than smoothed away.

**The credential designer said: require TLS on any non-loopback wire.** SCRAM protects the
password but not the data, and without channel binding it does not authenticate the server.
Neon's posture, not Supabase's.

**The wire designer ran the experiment and it breaks the north star.** Against a
TLS-configured pg-gateway fronting PGlite:

| client | result |
|---|---|
| `psql`, no sslmode param | works |
| `psql sslmode=prefer` | works |
| `psql sslmode=require` | works |
| `psql sslmode=verify-full`, pinned CA | works |
| `psql sslmode=disable` | rejected, `FATAL: SSL connection is required` |
| **`new pg.Client({connectionString})`, no ssl option** | **FAILS, `08P01`** |

The last row is the whole argument. node-postgres defaults `ssl: false` and sends the
StartupMessage with **no SSLRequest at all**, so a TLS-required server rejects the single most
common way a Node app connects. Neon only survives this by shipping `?sslmode=require` inside
every connection string they hand out.

**Recommendation: Supabase's posture here, not Neon's. TLS offered, never required.** Tri-state
`off | optional | required`, defaulting to `optional`. That also means every currently-verified
app - Cal.com, Documenso, NocoDB, cocoon, webhookx, PostgREST, GoTrue, nostream - keeps working
byte-identically with its existing `sslmode=disable`, which is the entire migration story.

Note this reverses the "Neon's posture is the right one" line elsewhere in these docs, which
was written before the experiment existed. **The experiment wins.**

**TLS by topology, which is what actually decides it:**

- Cloud Run loopback sidecar, the recommended and only real cloud topology: the raw wire port
  is not exposed at all. TLS is theater - an attacker on that loopback already has code
  execution in the container. Same for local `serveWire`, console, and fleet.
- **Fly.io is the genuine exception.** It forwards a real public TCP port, so TLS plus SCRAM
  there are load-bearing.

Build TLS anyway, for two non-security reasons: `sslmode=require` appears hardcoded in config
templates in the wild, and one code path beats two.

**Certificate handling has a scale-to-zero-specific trap.** Self-signed, generated once and
**persisted in the object store next to the manifest under the lease**. A cert regenerated per
boot would break pinning on a database that boots constantly. Overridable by PEM file or env.
`verify-full` works only against a pinned CA or a user-supplied real cert. No ACME.

## 7d. Two more experimental results that change the wire plan

**pg-gateway must be vendored, not depended on.** One `psql sslmode=verify-full` with a
mismatched CA - unauthenticated, one packet - raised a TLS `unknown_ca` alert that surfaced as
an uncaught `ERR_INVALID_STATE: WritableStream is locked` at `connection.ts:228` and **killed
the entire Node process.** It escapes a `try/catch` around `fromNodeSocket` because it is
thrown from an unawaited continuation inside `init()`. Reproduced a second time from an
unrelated cert-loading error. Unfixable from outside the library, and the library is a beta on
a branch unmerged for 19 months. Vendor a subset: connection, message buffers, `auth/sasl/*`,
crypto, the node TLS adapter. Drop deno, web, md5, cert.

**The naive adoption shape silently corrupts transactions.** Two clients each running
`BEGIN; SET LOCAL myapp.uid='X'; pg_sleep; SELECT current_setting; COMMIT`:

- under pglite-socket: `AAA saw AAA | BBB saw BBB`
- under pg-gateway + `db.runExclusive(execProtocolRaw)`: `AAA saw AAA | BBB saw <empty>`

**A's COMMIT terminated B's transaction and discarded B's `SET LOCAL`.** `runExclusive`
serializes per message, not per transaction. This is exactly the failure PostgREST's
per-request `BEGIN; SET LOCAL ROLE; ...; COMMIT` depends on not happening, so it is the RLS
isolation risk made concrete. **The transaction-affinity queue is a correctness prerequisite,
not polish.**

Port it from pglite-socket's `QueryQueueManager`, but improve it: batch to the **Sync/Query
boundary** rather than pglite-socket's per-message granularity, which still lets un-synced
Parse/Bind/Execute sequences interleave on the shared unnamed portal. Verified that three
Query messages in one `execProtocolRaw` call return three complete result sets.

**Handshake replay beats synthesis.** Never forward the startup packet. Harvest PGlite's real
429-byte block once at boot, strip `R` and `K`, force the trailing `Z` to `'I'`, and emit all
16 real `ParameterStatus` messages per connection. pg-gateway sends only `server_version`;
replaying the real block is strictly safer for pgjdbc and anything reading
`standard_conforming_strings`, `DateStyle` or `TimeZone`.

**Roles: map everything to `postgres`.** PGlite discards the startup `user` field entirely.
Accept any username, verify the password, stay `postgres`. Zero regression risk, and it
preserves the working Supabase story where PostgREST connects as `postgres` and does its own
`SET LOCAL ROLE`.

---

Original open framing follows, superseded by the above.

## 7b. Superseded: the credential model as it stood before the design landed

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

## 8. DESIGNED, not yet built: cold-start absorption at the wire

> **Assessed 2026-07-28 with a working prototype. See
> [COLDSTART-ABSORPTION.md](COLDSTART-ABSORPTION.md) for the full design.** Headline results,
> which supersede the speculation kept below:
>
> - **It works.** Prototype frontend, real clients, deliberately slow restore. node-postgres
>   at library defaults against an 11s restore: connect resolved at **4ms**, first query
>   returned correct rows at **10880ms**. Real psql at default `sslmode=prefer` against a 6s
>   restore: connect at 989ms, rows at 6.7s.
> - **No blocking timeout finding.** No mainstream stack breaks on defaults at 5s or 11s. The
>   one hazard is an *explicitly set* query timeout (verified: `pg` with
>   `query_timeout=5000` dies at 5005ms). That is a documentation obligation, not a blocker.
> - **Why the seam exists**, verified in library source: node-postgres arms
>   `connectionTimeoutMillis` at `node_modules/pg/lib/client.js:160` and clears it in
>   `_handleReadyForQuery` at `client.js:366`. Connect-phase budgets stop at `ReadyForQuery`;
>   query-phase budgets start there. Sending `ReadyForQuery` early moves the wait out of a
>   budget that is often 5-10s into one that is unbounded by default.
> - **Recommendation: build the cheap version, drop the deep version, drop BOTH middle
>   tiers, drop schema-only.** Roughly 4-6 person-days remaining.
> - **Cap the hold, do not hold forever.** 30s, with the leasing and restoring phases capped
>   separately so the error names the phase it died in.
> - **The `maxConnections` raw-string bug becomes a PREREQUISITE, not a nice-to-have.**
>   Handshake-early would tell a client "connected", hold it for seconds, then kill it with a
>   non-protocol string. The frontend must own the cap and emit `53300` first.
> - Note for the pg-gateway adoption: it does **not** send `BackendKeyData` today.

Original speculation follows.

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
