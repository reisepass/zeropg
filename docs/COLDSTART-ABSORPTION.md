# Absorbing cold start at the wire: handshake-early, hold-query

**Status:** design assessment. Planning only, no code changed.
**Date:** 2026-07-28.

## How to read the evidence markers

- **VERIFIED** means I ran it or read the actual code, in this repo or in `node_modules`, today.
  Versions: PGlite 0.5.2, `@electric-sql/pglite-socket` 0.2.2, `pg` 8.21.0, `pg-gateway`
  0.3.0-beta.4, real `psql` 18.4, Node 24, macOS.
- **INFERRED** means I reasoned from documentation, from third-party source I fetched but did
  not run, or from architecture. Treat these as claims to be checked, not facts.

Probe and prototype scripts backing the VERIFIED claims are throwaway files under
`/private/tmp/claude-501/-Users-user-workspace-blob-pglite/b9b81f00-ad6e-41ca-bbf4-71186ef30832/scratchpad/`:
`probe-startup.mjs`, `probe2.mjs`, `probe3.mjs`, `probe4.mjs`, `proto.mjs`, `client-test.mjs`.
Copy anything worth keeping into `experiments/` before the temp directory is reaped.

**Checkout caveat:** all VERIFIED work was done on the local checkout
`/Users/user/workspace/zeropg` at `main` = `b6ffad2`. Per
[`CONNECTION-SECURITY-AND-WIRE.md`](CONNECTION-SECURITY-AND-WIRE.md) section 11, the
`blob-pglite-dev` VM is one commit ahead at `9da362e` and carries
`packages/server/src/wire-frontend.ts`, which **does not exist on this checkout**. Section 0.5
below reconciles against it; anything I say about that file is INFERRED from that doc, not read.

---

## 0.5 Reconciliation with `CONNECTION-SECURITY-AND-WIRE.md`

That doc landed while this assessment was in progress. Four points of contact, one of which is
an answer to its own stated blocker.

**(a) I answered its "single most important unverified question."** Its section 6 says, of the
decision to own the frontend:

> Can we terminate auth ourselves and then hand PGlite a byte stream, or does PGlite generate
> its own AuthenticationOk / BackendKeyData / ReadyForQuery such that doing our own SASL
> exchange produces a **double authentication sequence** that confuses clients?

**VERIFIED answer: PGlite does generate its own full handshake, and the double sequence is real,
and it is trivially solvable.** On receiving a `StartupMessage`, PGlite emits
`AuthenticationOk` plus fifteen `ParameterStatus` plus `BackendKeyData` plus `ReadyForQuery`
(section 2.1). If you also send your own, the client sees two handshakes and pipelining
desynchronizes on the duplicate `ReadyForQuery`.

The fix is to **frame the backend's handshake on splice and discard it up to and including its
`ReadyForQuery`**, forwarding only what follows. I implemented exactly that in the prototype and
VERIFIED it end to end against real `psql` 18.4 and real `node-postgres` 8.21: correct rows, no
desync, no client complaint. It is roughly 20 lines. **This should not block the build-vs-adopt
decision any longer.**

Better still, the in-process path avoids the problem entirely: if the frontend calls PGlite's
`execProtocolRawStream` directly rather than proxying to an inner `PGLiteSocketServer`, PGlite
never sees a second `StartupMessage` and never emits a second handshake. Prefer that.

**(b) `SSLRequest` is already fixed, so my "Stage 1" is done.** Its section 3 records commit
`9da362e`, `packages/server/src/wire-frontend.ts` (199 lines), replying `'N'` to `SSLRequest`
(80877103) and `GSSENCRequest` (80877104), with real-libpq tests at
`packages/client/test/wire-sslmode.test.ts`. My independent prototype VERIFIED the same
behavior from scratch (plain `psql` at default `sslmode=prefer` works with no
`PGSSLMODE=disable`), so this is corroboration rather than a new recommendation. Stage 1 in
section 10 is marked DONE accordingly.

**(c) `WireFrontend` already is the Stage 0 scaffolding, which makes Stage 0 much cheaper.**
Its section 3 describes a TCP front-end that **owns the public port**, peeks the first 8 bytes,
and proxies the socket to an inner `PGLiteSocketServer` on a private loopback port, shared by
both `serveWire()` and `ZeroPGServer`. That is structurally the thing Stage 0 needed to build.
What remains is: bind it **before** `boot()` instead of after, and hold sockets until ready.
Estimate drops from 1-2 days to **about 1 day** (INFERRED, since I have not read the file).

**(d) The `maxConnections` cap becomes a new correctness requirement under handshake-early.**
Its section 4 VERIFIED that pglite-socket rejects over-cap connections by writing the raw
non-protocol string `"Too many connections\n"` and closing, which clients report as
`Connection terminated unexpectedly`, and that `@zeropg/server` raises the cap to 10
(`packages/server/src/server.ts:166`) while PostgREST is default-ON
(`packages/server/src/server.ts:114`) and silently eats slots.

**Under handshake-early this gets worse in a specific way:** the frontend would tell a client
"connected, authenticated, ready for query", hold its query for seconds, and only then hit the
inner cap at splice time and kill it with a non-protocol string. That converts a fast, clearly
wrong error into a slow, clearly wrong error.

**Requirement: the frontend must own the connection cap and enforce it at accept time**, before
emitting the synthetic handshake, and reject with a protocol-legal `ErrorResponse` carrying
SQLSTATE `53300` `too_many_connections`. That is the same fix its section 4 already calls for,
but handshake-early promotes it from "should fix" to **prerequisite**.

---

## 0. The decisive finding

**VERIFIED: PGlite's Postgres startup handshake is already a hardcoded constant. It does not
depend on the datadir, and it does not depend on anything the client sends.**

I connected a raw TCP socket to a live `PGLiteSocketServer`, decoded every backend byte up to
`ReadyForQuery`, and re-ran the same probe against five different backend configurations:

1. a fresh in-memory PGlite,
2. a second fresh instance in the same process,
3. a persisted `dataDir` carrying `ALTER DATABASE postgres SET search_path / timezone / datestyle / statement_timeout`,
4. that same `dataDir` closed and reopened so those settings were live,
5. a client sending `user=alice database=nope application_name=myapp`.

All five produced a **byte-identical** handshake, down to `BackendKeyData pid=42 secret=2875488`.

That collapses the hardest-looking part of this design. The standard objection to answering a
Postgres handshake before the database exists is "you would have to guess the `ParameterStatus`
values and you will guess wrong." Here there is almost nothing to guess: fourteen of the fifteen
keys are constants, `server_version` is pinned by `package.json`, and only `TimeZone` varies,
with the process `TZ` env, which we control and can additionally force after boot.

Two supporting measurements make it concrete.

**VERIFIED: the timing seam is real and it lives in the client library.** In `node-postgres`
8.21.0 the `connectionTimeoutMillis` timer is armed at `node_modules/pg/lib/client.js:160` and
cleared inside `_handleReadyForQuery` at `node_modules/pg/lib/client.js:366`. Connect-phase
timeouts stop at `ReadyForQuery`; query-phase timeouts start there. Sending `ReadyForQuery`
early genuinely moves the wait out of a budget that is often 5-10s and into a budget that is,
by default, unbounded.

**VERIFIED: it works end to end.** I built a working prototype frontend and drove it with real
`psql` and real `node-postgres` against a deliberately slow restore. With `node-postgres` at
library defaults and an 11s restore: connect resolved at **4ms**, the first query returned
correct rows at **10880ms**. With `psql` at default `sslmode=prefer` and a 6s restore: connect
at 989ms, correct rows at 6.7s.

The recommendation follows: **build the cheap version, do not build the deep version, and do not
build either middle tier.**

---

## 1. What `docs/LAZY-PAGEFAULT-RESTORE-from-blob.md` already concluded

`docs/LAZY-PAGEFAULT-RESTORE-from-blob.md` is a **handoff brief, not a result.** It proposes
booting PGlite on a sparse datadir and faulting 8KB heap and index blocks on demand from the
bucket, via a custom `BaseFilesystem` subclass intercepting `stream_ops.read`, an Atomics plus
SharedArrayBuffer bridge so the synchronous WASM read can block on an async range-GET, roughly
1MB page-group coalescing, and query-plan frontrunning plus a learned hot-page set
(lines 3-13).

### Was it implemented? No, not end to end

VERIFIED by reading the doc:

- Lines 71-78: all spike work is on branch `feat/lazy-page-restore`, which "currently exists
  **only in a local git worktree on the laptop** ... It was never pushed." `main` has only the
  design doc.
- Line 91: `LazyFS` "**Currently faults from a LOCAL file via `node:fs`, NOT through the bucket
  or the SAB bridge.**"
- Line 96: the SAB bridge is "**Standalone only - NOT yet wired into `LazyFS.read`.**"
- Line 106: `calibrate.mjs` has a "Known bug: hits PGlite `XLogBeginInsert was already called`
  on the very large single INSERT for the 500MB/1GB tiers", so those tiers were never built.

The two halves of the mechanism were each demonstrated in isolation and never joined.

### Proven versus modeled

The doc is scrupulous about this (lines 114-126):

- **Proven, on real PGlite:** read interception boot-to-query; results byte-identical to a full
  restore; per-query fault counts (a point lookup faults 1 block of 319, a full scan faults all
  319); the SAB bridge mechanism in isolation at about 21us p50 for 8KB; real working-set
  footprints at 10/50/100MB.
- **Only modeled, never measured:** "**every cold-start TIME number, including the '5-6x faster
  at 500MB'.**" No end-to-end wall clock (container boot plus restore/fault plus first query)
  was ever measured for lazy at any size. The 500MB and 1GB footprints "were never even
  generated."

Modeled crossover (lines 128-134): lazy wins only when the DB is large **and** the first query's
working set is small **and** the query is not scan-heavy. Roughly 100MB on S3-standard latency,
50MB on GCS, 10MB on S3-Express. Full-table-scan first queries "always favor eager." The
sensitivity is severe: the crossover "swings from 10MB at 5ms first-byte to **'never' at
120ms**."

### How handshake-early relates

Orthogonal, and handshake-early is the better first move.

| | lazy page-fault restore | handshake-early / hold-query |
|---|---|---|
| attacks | the actual restore duration | the perceived failure at t=0 |
| helps | large DBs with small hot sets | every DB size, every workload |
| helps when first query is a seq scan | no, it loses to eager | yes, identically |
| risk surface | undocumented PGlite FS internals pinned to 0.5.2 (line 197); crash matrix must be re-run (line 170) | Postgres wire protocol only, zero PGlite internals |
| status | never measured; branch stranded on a laptop; harness has a known blocker | prototyped and measured today |
| cost | the doc's own plan is 6 ordered steps including rebuilding the 500MB and 1GB tiers | 5-8 person-days total |

The relationship that matters:

**Lazy restore does not remove the connection-refused window, and cannot.** `pgliteCreateMs`,
the WASM Postgres boot, is a floor paid before any wire can serve anything. VERIFIED at
675-687ms in my probes; 1174ms in the boot log quoted by the team. Add the roughly 2s Cloud Run
platform floor (`docs/COLDSTART-MODEL.md:9`) and even a perfect lazy restore leaves seconds in
which a connecting client gets `ECONNREFUSED` today. **Handshake-early is a prerequisite for the
deep version paying off, not an alternative to it.**

On sizing: `docs/COLDSTART-MODEL.md:7-11` gives the budget as
`platform_floor (~2s) + zeropg_restore (~1.3s @10MB to ~9.1s @500MB) + app_boot`, and states
that the zeropg part is "a near-constant **~3.5-5s for small databases**, mostly the platform's
container floor." Lazy restore attacks only the middle term, only its download half, and only
above the modeled 50-100MB crossover. For the common case it does nothing.

**Recommendation: leave the lazy page-fault project parked.** Revisit only if a real user shows
up with a database well over 500MB and a demonstrably small hot set, and if so, start by taking
the eager baseline that the doc's own step 3 (lines 156-158) says was never taken on the VM.

---

## 2. The handshake-early / hold-query design

### 2.1 What PGlite actually sends

VERIFIED, decoded from a raw socket against `PGLiteSocketServer`:

```
AuthenticationOk   (type 'R', code 0)
ParameterStatus    in_hot_standby                = "off"
ParameterStatus    integer_datetimes             = "on"
ParameterStatus    TimeZone                      = "Etc/GMT-1"    <- varies with process TZ
ParameterStatus    IntervalStyle                 = "postgres"
ParameterStatus    search_path                   = "public"
ParameterStatus    is_superuser                  = "on"
ParameterStatus    application_name              = ""             <- client's value DISCARDED
ParameterStatus    default_transaction_read_only = "off"
ParameterStatus    scram_iterations              = "4096"
ParameterStatus    DateStyle                     = "ISO, MDY"
ParameterStatus    standard_conforming_strings   = "on"
ParameterStatus    session_authorization         = ""             <- empty, not the username
ParameterStatus    client_encoding               = "UTF8"
ParameterStatus    server_version                = "18.3"         <- pinned by package.json
ParameterStatus    server_encoding               = "UTF8"
BackendKeyData     pid=42  secret=2875488                         <- literally always these
ReadyForQuery      status='I'
```

`version()` reports `PostgreSQL 18.3 (PGlite 0.5.2) on wasm32-unknown-linux-gnu`. Fifteen
`ParameterStatus` keys; 428 bytes for the whole block.

Two things are **already wrong today**, before any of this design exists: `application_name`
comes back `""` even when the client sends `myapp` in its startup packet, and
`session_authorization` is `""` rather than the username. PGlite is not honoring the startup
packet at all.

### 2.2 Which values are knowable a priori

| key | knowable a priori? | source of truth | what breaks on a wrong guess |
|---|---|---|---|
| `in_hot_standby` | yes, constant `off` | PGlite never runs standby | nothing plausible |
| `integer_datetimes` | yes, constant `on` | PG >= 10 always on | binary timestamp decoding would corrupt, but it cannot be wrong |
| `IntervalStyle` | yes, constant `postgres` | PGlite default | interval text parsing in some drivers |
| `search_path` | yes, constant `public` | PGlite passes `-c search_path=public`, `pg_settings.source` = `command line` | see the note below, this is the one to watch |
| `is_superuser` | yes, constant `on` | PGlite always connects as superuser | `psql` prompt character; some tools gate DDL UI on it |
| `default_transaction_read_only` | yes, constant `off` | PGlite default | drivers that route reads and writes by this |
| `scram_iterations` | yes, constant `4096` | PGlite default | nothing, informational |
| `DateStyle` | yes, constant `ISO, MDY` | `pg_settings.source` = `configuration file` | **date ambiguity**: MDY versus DMY silently swaps day and month |
| `standard_conforming_strings` | yes, constant `on` | PGlite default | an injection-class bug if a client believed backslash escapes were active; cannot be wrong here |
| `client_encoding`, `server_encoding` | yes, constant `UTF8` | PGlite is UTF8-only | mojibake |
| `session_authorization` | **improve on PGlite**: set to the authenticated username | the frontend knows it after auth | currently `""`, already wrong |
| `application_name` | **improve on PGlite**: echo the client's startup value | the frontend has the startup packet | currently `""`, already wrong |
| `server_version` | yes, from the pinned `@electric-sql/pglite@^0.5.2` in `package.json:33` | build time | real risk, see below |
| `TimeZone` | **the only genuine variable** | process `TZ` at PGlite boot | real risk, demonstrated below |
| `BackendKeyData` | constant `pid=42 secret=2875488`, but **do not copy it** | see 2.6 | see 2.6 |

**`search_path`.** VERIFIED constant, and VERIFIED to stay constant even when the datadir carries
`ALTER DATABASE postgres SET search_path TO myapp, public`. I closed and reopened that datadir
and the live session still reported `search_path = public`, `statement_timeout = 0`. PGlite's
command-line `-c` wins and per-database GUC defaults never reach the session. This matches the
existing finding that login-GUCs do not fire on the multiplexed session (the Supabase work) and
that `statement_timeout` is inert on PGlite (the postgres-meta work).

So announcing `public` is safe **only as long as nothing in the boot path issues a
`SET search_path` before the first client query** - and something might, since the Supabase
wiring does exactly that on the live session. **Requirement: if boot sets `search_path`, the
frontend must announce that value, and must emit a `ParameterStatus` update on splice if the
announced value and the real value differ.**

**`server_version`.** Read it from the pinned package at build time and **assert it at boot**:
compare the announced value against the real backend's `ParameterStatus` on first splice and log
loudly on mismatch. If wrong (INFERRED consequences): clients gate feature support on this
string; `pg_dump` and `psql` refuse or degrade across a major mismatch, which is already
documented at `docs/LIMITATIONS.md:82-83`; JDBC and Npgsql switch protocol behaviors by version.
If you ever must guess, guess lower. But do not guess, assert.

**`TimeZone`, the one that bites.** VERIFIED: PGlite derives it from the process `TZ` at boot and
flattens it to a fixed offset. `TZ=UTC` gives `Etc/GMT0`; `TZ=America/New_York` gives `Etc/GMT+5`
(a fixed offset, so PGlite discards DST entirely - a pre-existing PGlite bug, not ours); unset on
this Mac gave `Etc/GMT-1`.

VERIFIED divergence, demonstrated in the prototype: I announced `Etc/GMT0` while the backend
booted at `Etc/GMT-1`. `psql` then showed

```
 TimeZone
-----------
 Etc/GMT-1     <- SHOW, i.e. the truth from the backend
```

while the client's cached `ParameterStatus` said `Etc/GMT0`. **Silent one-hour skew, no error
anywhere**, in any client that renders timestamps from `PQparameterStatus("TimeZone")`. INFERRED:
pgjdbc does exactly that to build its calendar, so JDBC is the client most exposed.

**The fix is not a better guess.** Pin `TZ=UTC` in the container image **and** issue an explicit
`SET TimeZone TO 'Etc/GMT0'` on the real session at boot, so the announcement is made true rather
than hoped true. Belt and braces, because the failure mode is silent.

### 2.3 Exact protocol messages with no backend available

Everything the frontend must emit to bring a client to `ReadyForQuery` with nothing behind it:

1. **Pre-startup negotiation.** Frame the first 8 bytes and switch on the request code:
   - `80877103` `SSLRequest` -> reply a single byte `S` (proceed to TLS) or `N` (plaintext).
     **Today the wire answers neither, so libpq and pgx at default `sslmode=prefer` hang
     silently.** VERIFIED: replying `N` in the prototype makes plain
     `psql "postgres://postgres@host:port/db"` work with no `PGSSLMODE=disable`.
   - `80877104` `GSSENCRequest` -> reply `N`.
   - `80877102` `CancelRequest` -> 16-byte message, no response, close. See 2.6.
   - `196608` (3.0) -> the real `StartupMessage`. Protocol `196659` (3.2) should get a
     `NegotiateProtocolVersion`; pg-gateway does not send one (section 8).
2. **Authentication.** `AuthenticationSASL` -> `AuthenticationSASLContinue` ->
   `AuthenticationSASLFinal` -> `AuthenticationOk`, or a bare `AuthenticationOk` for trust mode.
   **This is the hard dependency on owning the frontend:** the credential check must be against a
   config-supplied SCRAM verifier, because `pg_authid` does not exist yet.
3. **Fifteen `ParameterStatus` messages**, per 2.1 and 2.2.
4. **`BackendKeyData`**, per 2.6.
5. **`ReadyForQuery` with status `'I'`.**

Total 428 bytes, emitted in one write.

### 2.4 Where the boundary sits

**The `ReadyForQuery` byte is the boundary.** Everything before it is "connecting" in the eyes of
every client library; everything after it is "connected, query in flight." That is not a design
choice, it is where `node-postgres` clears its connect timer
(`node_modules/pg/lib/client.js:366`, VERIFIED) and, INFERRED from the docs, where libpq's
`PQconnectPoll` reaches `CONNECTION_OK`.

VERIFIED trace from the prototype driving real `psql`:

```
     4ms front: LISTENING on 127.0.0.1:15600
   988ms front: SSLRequest -> N (plaintext)
   989ms front: sent CANNED handshake (428 bytes) -> client believes it is connected
   989ms front: HOLDING 28 client bytes (first query queued)
  6681ms restore complete (pgliteCreateMs=677)
  6684ms front: SPLICED to real backend, replaying 28 held bytes (client waited 5696ms)
```

and `psql` printed correct rows.

The state machine:

1. **t=0**: bind and listen. Accepting connections becomes the first thing the process does, not
   the last.
2. Negotiate and authenticate (2.3 steps 1-2).
3. Emit the handshake block. The client is now "connected."
4. **Hold.** In the prototype this was free: VERIFIED that a Node `net.Socket` with no `'data'`
   listener and no `resume()` never enters flowing mode, so bytes accumulate in the readable
   buffer and then apply TCP backpressure to the client. In the real design the held messages go
   into the shared query queue instead, which is better and is the answer to the serialization
   question (section 8.2).
5. **On ready**, drain. If splicing to a separate backend socket you must **frame the backend's
   own handshake and discard it** up to its `ReadyForQuery`, because you already sent yours.
   Roughly 20 lines, easy to forget; miss it and the client sees a duplicate `Z` and pipelining
   desynchronizes. The in-process path (calling PGlite directly rather than proxying to
   `PGLiteSocketServer`) avoids this entirely and is preferable.

### 2.5 Hold indefinitely, or cap it? Recommendation: cap it.

This was raised as an open product question, and the framing in the question is the right one:
**a silent hang is the exact failure mode this whole effort exists to remove.** Converting
`ECONNREFUSED` into an unbounded hang would be a lateral move, not an improvement. `ECONNREFUSED`
at least tells the operator something.

**Recommendation: hold with a ceiling, then a clear error that names the boot phase.** This
agrees with the current lean recorded in
[`CONNECTION-SECURITY-AND-WIRE.md`](CONNECTION-SECURITY-AND-WIRE.md) section 8 ("a ceiling
(roughly 30s) with an `ErrorResponse` naming the boot phase it died in").

- Add `ZEROPG_HOLD_MAX_MS`, default **30000**, applied to the `restoring` phase.
- **30s, not 60s.** 30s sits comfortably above the 11s worst case
  (`docs/LIMITATIONS.md:26`, `docs/COLDSTART-MODEL.md:28`) with roughly 3x headroom, and a
  restore that has not landed in 30s is not going to land. I originally leaned 60s to stay under
  `acquireTimeoutMs`, which VERIFIED defaults to `90_000` at
  `packages/server/src/server.ts:145`. The better resolution is to **cap the two phases
  separately** rather than pick one number that has to clear both:
  - `leasing` phase: bounded by `acquireTimeoutMs`, but **fail fast on `FencedError`** (section
    7), so the 90s only applies to genuine contention. Consider lowering it; 90s of silence is
    a long time to hold a client.
  - `restoring` phase: bounded by `ZEROPG_HOLD_MAX_MS` = 30s.
- On expiry, send an `ErrorResponse` whose message **names the phase and the elapsed time**, for
  example `the database system is starting up (phase=restoring, 30s elapsed, 412MB/500MB
  downloaded)`. `phase` is already tracked as `BootPhase` at `packages/server/src/server.ts:33`
  (VERIFIED) and `/ready` already exposes progress, so the string costs nothing to produce.
- Make the ceiling configurable to `0` meaning "hold forever" for operators who prefer it, but do
  not default to it.

The reason to prefer a ceiling over an unbounded hold is not client behavior - most clients would
tolerate an unbounded hold (section 3) - it is **operator diagnosability**. A stuck bucket, a
contended lease, or a fenced instance should surface as a specific Postgres error in the
application log within half a minute, not as a connection that never answers.

### 2.5.1 The inverted risk: are we lying to a pool that set a connect timeout?

`CONNECTION-SECURITY-AND-WIRE.md` section 8 raises this and it deserves a direct answer:

> a pool that deliberately sets `connectionTimeoutMillis` is now being *lied to* about readiness.

**Yes, and it is the intended trade, but the honesty question has a real answer.** What
`connectionTimeoutMillis` actually asks is "did the TCP connect, TLS, and auth exchange complete
in time?" Under this design all three genuinely did. What the pool *infers* from that - "the
database can now answer promptly" - was never something the protocol promised, and is already
false on any loaded Postgres.

Three things keep it from being a real deception:

1. **The lease gate (section 7)** means "connected" is not asserted until we actually own the
   database. Before that we stay silent. So the claim behind the handshake is true when made.
2. **The ceiling above** means the lie, if you want to call it that, has a bounded life and
   terminates in a specific Postgres error rather than a hang.
3. **The pool's real question is answerable elsewhere.** `/ready` reports the phase and has done
   since before this design. Operators who need "is it warm" should ask that, not infer it from
   a TCP handshake.

The alternative - stalling before `ReadyForQuery`, which is what Neon does (section 9) - is more
literally truthful and **measurably worse for users**, because it puts the whole restore inside
Prisma's 5s `connect_timeout` and reproduces `P1001`. Given a choice between a protocol-accurate
failure and a protocol-loose success, take the success and bound it.

### 2.6 `BackendKeyData` and cancellation

PGlite always sends `pid=42, secret=2875488` (VERIFIED across all five configurations).
**Do not copy the constant. Generate per-connection random values.**

Cancellation is meaningless on PGlite today: there is no cancel path, and `statement_timeout` is
inert (existing postgres-meta finding: the client-side timeout is not a cancel). Announcing our
own key material costs nothing, removes a dependency on an undocumented PGlite constant, and
unlocks something the current architecture cannot do at all: **`CancelRequest` becomes
implementable at the frontend** - look up the connection by pid and secret and drop its *queued*
message before it ever reaches PGlite. During a cold-start hold that is genuinely useful, because
the query has not started executing. Until that is built, answer `CancelRequest` by closing the
connection, which is protocol-legal.

**pg-gateway constraint.** VERIFIED by grep against
`node_modules/pg-gateway/dist/chunk-PGRRI4HM.js`: pg-gateway 0.3.0-beta.4 contains
`BackendKeyData` only as a message-code constant in its vendored `pg-protocol` parser (code 75)
and never emits one. **This design requires adding `BackendKeyData` emission to pg-gateway.** It
is a small self-contained patch (one message writer plus a per-connection random pair) and it is
a prerequisite: omitting `BackendKeyData` is legal in the letter of the protocol, but VERIFIED
that `node-postgres` reads `processID` and `secretKey` unconditionally at
`node_modules/pg/lib/client.js:355-358`. Send it.

---

## 3. Client timeouts

The structural point, VERIFIED in installed source rather than assumed: **connect-phase timers
stop at `ReadyForQuery`; query-phase timers start there.** `node_modules/pg/lib/client.js:160`
arms `connectionTimeoutHandle`; `node_modules/pg/lib/client.js:366` clears it inside
`_handleReadyForQuery`. That seam is why synthesizing the handshake beats stalling before it.

| stack | connect-phase timeout (default) | query-phase timeout (default) | survives 5s hold? | survives 11s hold? |
|---|---|---|---|---|
| **libpq / psql** | `connect_timeout` **unset = wait indefinitely** | none exists in libpq | yes | **yes** (VERIFIED: correct rows after a 5.7s hold) |
| **node-postgres 8.21** | `connectionTimeoutMillis` **0 = off** (`lib/client.js:112`, VERIFIED) | `query_timeout` **false = off** (`lib/defaults.js:73`); `statement_timeout` **false** (`lib/defaults.js:62`) | yes | **yes** (VERIFIED: connect 4ms, query returned 10880ms) |
| **node-postgres with `query_timeout` set** | n/a | operator-set | **breaks if < hold** | **breaks if < hold** (VERIFIED: `query_timeout: 5000` failed at 5005ms, `Query read timeout`) |
| **pgx v5 / Go** | `connect_timeout` unset = none; pool defers to `context` (INFERRED) | none unless a `context` deadline is set | yes | yes, unless the app sets a request-scoped context deadline |
| **pgjdbc** | `connectTimeout` **10s**, TCP connect only; `loginTimeout` **0 = off** (INFERRED from docs) | `socketTimeout` **0 = off** | yes | yes |
| **Prisma (native engine)** | `connect_timeout` **5s** (INFERRED from docs) | no engine-level query timeout; `pool_timeout` **10s** guards pool *acquisition*, not execution | yes | **yes under hold-query; would BREAK under a pre-`ReadyForQuery` stall** |
| **PostgREST** | `db-pool-acquisition-timeout` 10s (INFERRED) | none | yes | marginal |
| **Cloud Run** | request timeout **300s** default, max 3600s (INFERRED) | n/a | yes | yes |

Sources for the INFERRED rows:
[libpq connection parameters](https://www.postgresql.org/docs/current/libpq-connect.html),
[pgJDBC connection properties](https://jdbc.postgresql.org/documentation/use/),
[Prisma PostgreSQL connector](https://www.prisma.io/docs/orm/overview/databases/postgresql).

### The findings that matter

**1. No mainstream stack breaks on library defaults, at 5s or at 11s, under hold-query.** The
design is safe out of the box. This is the most important row-by-row conclusion, and it means
there is **no blocking finding of the "this stack makes hold-query useless" kind.**

**2. The one genuine hazard is an explicitly configured query timeout.** VERIFIED failure:
`node-postgres` with `query_timeout: 5000` against an 11s hold fails at exactly 5005ms with
`Query read timeout`. This is not a blocker for defaults, but it is a documentation obligation.
`docs/LIMITATIONS.md:73-75` currently reads:

> Apps must retry the initial DB connection: the sidecar's control-port health check can return
> 200 a few seconds before the Postgres wire is up (`ECONNREFUSED` window).

That caveat gets **replaced**, not deleted, by:

> A client-side **query** timeout must exceed your cold start (roughly 5s for small databases,
> 11s at 500MB), because zeropg absorbs cold start as first-query latency rather than a
> connection failure. `node-postgres` `query_timeout`, a Go `context` deadline, and pgjdbc
> `socketTimeout` are all off by default; if you set one, set it above your cold start.

**3. Prisma is the decisive argument for synthesizing the handshake rather than copying Neon's
stall.** Prisma's `connect_timeout` defaults to 5 seconds. An 11s stall before `ReadyForQuery`
produces exactly the `P1001 Can't reach database server` that Neon's own docs attribute to this
cause: "it most likely means that the Prisma query engine timed out before your Neon compute was
activated" ([Neon connection errors](https://neon.com/docs/connect/connection-errors)).
Hold-query completes the connect in about 4ms and sidesteps it entirely.

**4. Second-order Prisma hazard (INFERRED).** Under hold-query the first connection is occupied
for the whole restore. On a `connection_limit=1` pool a concurrent second request will blow
`pool_timeout` (10s) at an 11s restore. Recommend pool size >= 2 in the docs.

**5. Scoping caveat that must not be lost.** VERIFIED: on Cloud Run the wire binds loopback-only
by default (`wireHost` default `127.0.0.1`, `packages/server/src/server.ts:111`), because Cloud
Run is HTTP-only and never exposes raw 5432. External clients therefore never touch the wire;
they use the HTTP face, which **already listens at t=0** (`packages/server/src/server.ts:125`,
`srv.listen()` runs before `void srv.boot()`). The real beneficiaries of this work are:

- multi-container Cloud Run services where the app container races the sidecar, which is the
  documented `ECONNREFUSED` window at `docs/LIMITATIONS.md:73-75`;
- Fly.io and anywhere `wireHost=0.0.0.0`;
- `serveWire` local dev and the fleet console (`packages/client/src/wire.ts:91`).

Do not market this as "fixes Cloud Run cold start." It fixes the wire's cold-start failure mode,
which is a narrower and more defensible claim.

**6. A free second-order win worth measuring.** VERIFIED that PostgREST is started *after* the
wire (`packages/server/src/server.ts:170-186`), serializing its boot behind the restore. With an
early wire, PostgREST can spawn in parallel with the restore and have its held schema-cache query
answered on splice, removing `postgrestMs` from the critical path. `bootTimings` already tracks
it separately (`packages/server/src/server.ts:70-75`), so the win is directly measurable once
this lands.

---

## 4. What held clients get when restore FAILS

VERIFIED. I forced the restore to throw
`blobstore: lease acquire failed (fenced by generation 7)` at t=4s with clients already held past
`ReadyForQuery`:

```
psql:            FATAL:  the database system is starting up: blobstore: lease acquire failed (fenced by generation 7)
                 (exit status 1)

node-postgres:   FAILED: 57P03 the database system is starting up: blobstore: lease acquire failed (fenced by generation 7)
```

**Yes, this is a protocol-legal `ErrorResponse`, and it is the right one.** Construction: message
type `'E'`, body is a sequence of field-code plus null-terminated-string pairs, terminated by a
single zero byte. Minimum viable field set:

- `S` severity localized = `FATAL`
- `V` severity non-localized = `FATAL`
- `C` SQLSTATE
- `M` human-readable message

then `0x00`.

**SQLSTATE choice matters more than the message text:**

- **`57P03` `cannot_connect_now`** for "restore did not finish" and for the hold ceiling expiring.
  INFERRED but well established: this is what real Postgres emits for "the database system is
  starting up", so every retry layer that already understands Postgres (pgbouncer, HikariCP, pgx,
  Prisma, `pg`'s own error classification) handles it correctly with no new code anywhere.
  **Do not invent a code.**
- **`57P01` `admin_shutdown`** for lease loss or fencing specifically, which is more accurate than
  `57P03` and is what real Postgres sends when a backend is terminated administratively. Either
  is defensible; pick one and document it.

**After a `FATAL`, close the socket**, matching real Postgres. Do not send a trailing
`ReadyForQuery` - the instance is not going to recover, and leaving the connection open invites
the client to retry into the same dead process. (If you ever want a recoverable per-query error
instead, that shape is `ErrorResponse` plus `ReadyForQuery('I')` with the socket kept open. That
is not this case.)

Per section 2.5, the message should name the phase: `phase=leasing` versus `phase=restoring` tells
the operator whether they are looking at a contended lease or a slow bucket, and those have
completely different fixes.

One artifact from my test, so nobody misreads it: `node-postgres` emitted an unhandled `'error'`
event after receiving the FATAL, because my throwaway client had no pool error handler. That is a
harness omission, not a protocol problem. Closing after FATAL is correct server behavior.

---

## 5. The middle tier: answer `SELECT 1` / `SET` / `SHOW` immediately

**Recommendation: drop it.**

### The `SET` replay problem is structural, not an implementation detail

`docs/LIMITATIONS.md:11` states the constraint: "pglite-socket serializes every connection onto
one PGlite session." There is no per-connection session to replay a `SET` into. When you replay a
held `SET search_path TO myapp` onto the real backend you are not restoring one client's session,
you are mutating the **global** session shared by every other connection. Two clients that each
issued a data-free `SET` during the hold window race, and the loser silently inherits the
winner's setting.

It is worse than that. VERIFIED: PGlite already ignores `ALTER DATABASE ... SET` and
startup-packet GUCs entirely, and `statement_timeout` is inert. So the frontend cannot even
determine what the *true* post-restore value of a GUC would be in order to replay against it. And
a `SHOW` answered from a synthetic table would then diverge from what the real session reports,
which is the same silent divergence I demonstrated with `TimeZone` in section 2.2, except now for
a value the client explicitly asked for.

The existing mitigation for the single-session GUC problem (from the Supabase work) is
`RESET ROLE` plus `RESET ALL` plus `search_path` per submission. Layering a replay mechanism on
top of that is building a session abstraction on a system that does not have sessions.
**Reject `SET` and `SHOW` early-answering.**

### Classifying a query as data-free without a real SQL parser

The only safe classifier is **exact match on normalized text**: strip comments, collapse
whitespace, lowercase, then compare against a closed set (`select 1`, `select 1;`,
`select version()`, `select current_database()`). False positives are then near-zero by
construction, because there is no pattern to over-match.

The dangerous version is regex, and the false-positive cost is severe:
`/^select\s+1/` matches `SELECT 1 FROM huge_table WHERE expensive_predicate`, which is emphatically
not data-free. Answering that with a synthetic `1` returns a **wrong result silently** - the
client sees one row where the real answer might be zero rows or a million. Any prefix or regex
matcher is a correctness bug waiting for the first user whose validation query is slightly
unusual. If this is built at all it must be exact-match and it must never be allowed to grow.

But classification is not the real cost. **Response construction is.** `SELECT 1` in the simple
protocol needs `RowDescription` (name `?column?`, table OID 0, column 0, type OID 23 `int4`,
typlen 4, typmod -1, format 0) plus `DataRow` plus `CommandComplete "SELECT 1"` plus
`ReadyForQuery`. In the extended protocol it additionally needs `ParseComplete`,
`ParameterDescription`, `BindComplete`, and correct `Describe` handling for both statement and
portal. That is a real slice of a wire *backend*, written twice (once for the fake path, once for
the real one), for a query that costs microseconds once the backend exists.

### Does it actually help? No

Trace the benefit through. A pool's validation query fires *at connection setup*. Under this
design the connection is already established at about 4ms. Answering `SELECT 1` in 1ms instead of
5000ms lets the pool mark the connection healthy 5s earlier, and then the pool immediately issues
the application's real query, which waits the same 5s anyway. **You have moved the wait, not
removed it. Total time to useful response is identical.**

Two cases where it is not identical, both with cheaper fixes (INFERRED):

1. A pool that tears the connection down on slow validation - HikariCP `validationTimeout`,
   default 5000ms - producing a churn loop rather than a wait. Real, but so is raising
   `validationTimeout`, a one-line client config change.
2. A load balancer probing the wire port with `SELECT 1`. Not how Cloud Run works; conceivable on
   Fly.io. Point the check at the HTTP `/ready` endpoint, which already answers at t=0.

**Holding everything is simpler and is not measurably worse.** If case 1 bites a real user, add a
single exact-match for `select 1` in the simple protocol only, roughly 40 lines, and hold the line
there.

---

## 6. The schema-only variant

**Drop it as proposed. One narrow piece is worth reconsidering later, but only after a measurement
I expect will kill it.**

The instinct behind it is right: some of the perceived cold start is tools introspecting rather
than users querying. But you cannot answer data queries from a schema, and guessing is worse than
waiting.

### The arithmetic kills the general version

**To load a schema you must boot Postgres, and booting Postgres is `pgliteCreateMs`** - VERIFIED
at 675-687ms here, 1174ms in the quoted boot log. That is a large fraction of the very small-DB
restore you are trying to hide (`docs/COLDSTART-MODEL.md:9`: roughly 1.3s at 10MB). Running a
*second* PGlite to serve schema queries while the first restores doubles memory, and memory is the
binding constraint: `docs/LIMITATIONS.md:22-25` says a 500MB database in a 1GiB container is
already "tight."

So a "schema-only tier" is not really schema-only. It is a **response cache keyed on exact query
text**, holding pre-recorded `RowDescription` and `DataRow` byte blobs for Prisma's introspection
query, PostgREST's schema-cache query, Drizzle's, and `psql \d`.

### Staleness is solvable; the payoff is not

Staleness *is* fixable (INFERRED, but the mechanism is straightforward): version the cache by
snapshot generation, read the manifest early in restore (cheap, and it happens before the bulk
download), and refuse to serve any cache whose generation does not match. Without that gate it is
unsafe in a specific and nasty way: **PostgREST would publish a wrong API shape** and Prisma would
validate against a schema that no longer exists, both silently, both surviving until someone
notices a missing endpoint.

The payoff is what fails. These introspection queries are fired by **in-container clients that are
already started after the wire**, in parallel with nothing on the user's critical path. Answering
PostgREST's schema-cache query 3s earlier does not let PostgREST serve a *user request* 3s
earlier, because that request needs data. The measurable win is bounded by the `postgrestMs`
overlap, which the main design already captures for free by letting PostgREST boot in parallel
with the restore (section 3, finding 6).

**Recommendation: build the main design, measure the `postgrestMs` overlap (already instrumented
in `bootTimings`), and only revisit this if that number turns out to be large.** INFERRED
expectation: it will not be, because PostgREST's runtime boot is short and its schema query is
fast once the backend exists.

### The version actually worth wanting

Not schema-only *serving*, but **restore-order prioritization**: materialize the catalog and small
relations first so PGlite can open earlier and start answering while large relations stream in.
That is the lazy page-fault project (section 1), with all its unmeasured caveats. Neon's LFC
prewarm (section 7) is external evidence that the hot-set half of that idea is the part that pays.

---

## 7. Does the lease break this design?

**Yes, in one specific way, and there is a clean fix that must be designed in rather than bolted
on.**

### The problem

VERIFIED: `ZeroPG.open()` acquires the writer lease (`packages/server/src/server.ts:139-147`) and
can throw `FencedError` or `LockedError` if another instance has taken over. Under a naive design
the frontend completes handshakes at t=0, before `open()` has returned. **That means telling a
client "connected, authenticated, ready for query" about a database we may turn out not to own.**

How bad is it concretely:

- **No data is at risk.** Nothing has been read or written and no transaction exists at the
  backend. If lease acquisition fails, held clients get a FATAL (section 4) and the connection
  dies. The client's *outcome* is identical to today's `ECONNREFUSED`; it just arrives later.
- **The timing is bad.** VERIFIED: `acquireTimeoutMs` defaults to `90_000`
  (`packages/server/src/server.ts:145`). If a stale instance still holds the lease, `open()` can
  block for up to 90 seconds before throwing. Naively, you would hold clients for 90 seconds and
  then FATAL them, which is worse than failing fast.
- **Auth is the subtler point.** Terminating SCRAM at the frontend means authenticating against a
  config-supplied verifier rather than `pg_authid`. That is inherent to any
  frontend-terminates-auth design, cold start or not, so it is not a new cost of this feature. But
  write it down: the frontend's notion of "who you are" is permanently decoupled from the
  database's.

### The fix: gate the handshake on the lease, not on the restore

Split `boot()` into two phases and answer the handshake between them:

```
phase 'leasing'    acquire the lease.  Port is BOUND and connections ACCEPTED, but the
                   frontend stays SILENT (buffer bytes, answer nothing, not even
                   AuthenticationOk).  Typically a few object-store round trips.

phase 'restoring'  lease is HELD.  Frontend now negotiates, authenticates, and emits the
                   synthetic handshake.  "Connected" now honestly means "we own this
                   database and are materializing it."  This is the expensive phase:
                   3.5s to 11s.

phase 'ready'      unpause the queue, drain held messages.
```

You give up almost nothing (lease acquisition is fast and uncontended in the normal case, versus
3.5-11s for the restore) and the lie disappears. During `leasing` a client experiences a connect
that has not yet completed, which every stack in section 3 tolerates: libpq unbounded, `pg` 0,
pgx none, pgjdbc `loginTimeout` 0. Only Prisma's 5s `connect_timeout` and pgjdbc's 10s TCP
`connectTimeout` are live during that window, and both comfortably exceed a normal lease acquire.

**Additional lease requirements this design creates:**

1. **`ZEROPG_HOLD_MAX_MS` must be shorter than `acquireTimeoutMs`.** With the suggested defaults
   (60s versus 90s) that holds, but assert the relationship at construction rather than leaving it
   to chance, or a contended lease produces a 90-second hold.
2. **Fail fast on `FencedError`; do not wait out the timeout.** A fence means another instance
   definitively took over, which is terminal: abort immediately and FATAL the buffered connections
   with `57P01`. Only `LockedError` justifies retrying up to `acquireTimeoutMs`.
3. **Lease loss mid-hold and mid-life.** If the lease is revoked after the handshake but before
   ready, held clients get `57P01 admin_shutdown` and the socket closes. Same shape as the
   existing takeover path.
4. **Interaction with the known takeover write-loss behavior.** The existing finding is that a
   takeover or deploy-roll of an awake `sleep`-durability instance drops its unflushed writes, and
   the quiesce procedure is `POST /flush`. Handshake-early does not cause this, but INFERRED it
   makes it more *observable*: clients now connect within milliseconds of a new instance starting,
   so the window in which two instances are both reachable is more likely to be hit by real
   traffic. Worth a line in the docs; not a blocker.
5. **`/ready` semantics must not drift.** `BootPhase` at `packages/server/src/server.ts:33` gains
   a `'leasing'` value. Anything parsing that string (the fleet CLI, the console) needs updating in
   the same change.

---

## 8. Reconciling with pg-gateway adoption and the serialization invariant

### 8.1 Adopting pg-gateway

VERIFIED: pg-gateway (supabase-community, MIT) is a devDependency at `^0.3.0-beta.4`
(`package.json:26`) with the installed version reporting `0.3.0-beta.4`, and a spike at
`experiments/prisma-spike/pggw.ts` (131 lines). Adopting it is the right call and does not
conflict with anything here: this design needs a frontend that terminates auth, and pg-gateway is
one.

**What this design additionally requires from pg-gateway, beyond what the wire-frontend project
already plans:**

1. **A "backend not yet available" construction mode**, plus a `becomeReady(backend)` transition.
   pg-gateway's API will naturally assume a backend exists at construction. This must be designed
   into the adaptation layer, not bolted on: retrofitting a null-backend state into a library that
   assumes one is where this kind of work goes wrong.
2. **`BackendKeyData` emission.** VERIFIED absent (section 2.6). Add a writer plus per-connection
   random pid and secret. Small, self-contained, and a hard prerequisite.
3. **Consume-and-discard of the backend's handshake on splice**, framed to its `ReadyForQuery`
   (section 2.4). Only needed if you splice to a separate backend socket; the in-process path
   avoids it.
4. **`NegotiateProtocolVersion` for protocol 3.2.** Currently absent. Not caused by this design,
   but a client negotiating 3.2 during a cold-start hold fails in a more confusing way than the
   same client failing fast, so it should land alongside.
5. **The unhandled `ERR_INVALID_STATE` process kill** when a client rejects the server certificate
   is a **blocking defect for this design specifically**, more so than for the frontend project
   generally. Under handshake-early the process accepts connections from t=0, including from
   scanners and probes, for seconds before the database exists. A crash in that window destroys
   the whole boot rather than one connection. **Fix or wrap it before enabling early binding on
   any publicly bound wire (`wireHost=0.0.0.0`).**
6. **Build-time-pinned `server_version` plus a boot-time assertion** against the real backend
   (section 2.2).
7. **`TZ=UTC` in the image plus an explicit `SET TimeZone TO 'Etc/GMT0'` at boot** (section 2.2).
   The only silent-failure value in the whole handshake.
8. **Free correctness upgrades while you are in there:** echo the client's `application_name`, and
   set `session_authorization` to the authenticated username. Both are `""` today, which is simply
   wrong.

### 8.2 The serialization / RLS invariant, and how holding preserves it

This is the most important reconciliation, and it changes the recommended implementation of the
hold.

VERIFIED by reading `node_modules/@electric-sql/pglite-socket/dist/chunk-TORNJX5U.js`: the current
safety property comes from `QueryQueueManager`. It serializes every connection onto the single
PGlite session, and it is **transaction-aware**. When `db.isInTransaction()` is true and a
`lastHandlerId` is recorded, `processQueue` searches the queue for a message from *that same
handler* rather than taking the head, so no other connection's work can interleave inside an open
transaction. That is precisely what makes RLS isolation safe on the shared session (the Supabase
result: zero claim bleed, proven). pg-gateway has no equivalent, so **the port must bring the queue
with it** - a requirement of the frontend project, independent of cold start.

**Holding interacts with it in a way that must be stated explicitly:**

> **The cold-start hold buffer and the steady-state serialization queue must be the same object.**

If the hold is a separate byte buffer that flushes into the queue at ready, then at the splice
moment you can interleave connection A's held messages, connection B's held messages, and newly
arriving messages in an order the transaction-affinity rule never sees. The invariant is violated
precisely in the window where the most connections have the most pending work.

The correct construction is simple and makes the hold nearly free:

> **One queue per instance, created at t=0 in a paused state. Every connection's framed messages
> enqueue into it from the moment its handshake is answered. `becomeReady()` unpauses it and
> starts `processQueue()`. Held cold-start messages then become indistinguishable from
> steady-state messages.**
>
> **The hold *is* the queue, paused.**

This preserves the RLS property exactly, because the transaction-affinity check is evaluated at
*dequeue* time, which is always post-unpause when `db` exists. Before unpause, `db` is null and
nothing is dequeued, so there is no window in which the rule is unevaluable. At unpause, FIFO plus
transaction affinity handles the multi-client case correctly: if A's held bytes are
`BEGIN; SET LOCAL role ...` and B's are another `BEGIN`, A's `BEGIN` runs, `isInTransaction()`
becomes true, `lastHandlerId = A`, and the queue pulls only A's messages until A commits. B waits.
Correct by construction.

**Two things the port must fix, one of which this design makes materially more likely to bite:**

- **Enqueue framed messages, not raw byte buffers.** A held buffer routinely contains several
  pipelined protocol messages. pg-gateway frames, so this is natural, but do not shortcut it by
  pushing raw `Buffer`s into the queue.
- **Enqueue at `Sync` boundaries, not per message.** VERIFIED by reading the bundle: the current
  `QueryQueueManager` enqueues each framed message individually and `await`s it, so another
  handler's message can slot between connection A's `Parse` and its `Bind`. Since PGlite's
  extended-protocol state is per-session, that corrupts A. INFERRED that this rarely fires today
  because clients usually send `Parse/Bind/Describe/Execute/Sync` in one TCP segment and the
  per-connection `await` chain mostly keeps them adjacent. It is a **pre-existing latent hazard**,
  in the same area as `docs/TODO-pglite-socket-prepared-statements.md`.

  **A cold-start hold makes it much more likely.** At unpause you have, by construction, N
  connections each with a full batch of pending work arriving at the queue simultaneously: the
  exact worst case for cross-connection interleaving. The hazard is not new in kind, but this
  design promotes it from "rare race" to "reliably exercised on every cold start."

  **Requirement: the ported queue must treat an extended-protocol message group (everything up to
  and including `Sync`) as one indivisible queue entry**, and a simple-protocol `Query` as one
  entry. This is a hard prerequisite of the synthesize-and-hold stage, not a follow-up. Building a
  failing test for it first would also serve as the regression test for the fix.

---

## 9. What Neon actually does

### Does the proxy hold the connection? Yes

INFERRED from source I fetched but did not run: in `neondatabase/neon`,
[`proxy/src/proxy/mod.rs`](https://raw.githubusercontent.com/neondatabase/neon/main/proxy/src/proxy/mod.rs),
`handle_client` runs `auth_backend.authenticate()` (SCRAM, against the control plane) **before**
`connect_auth::connect_to_compute_and_auth()`. The client socket stays open across the compute
wake, and the proxy then calls `forward_compute_params_to_client()`, reading the compute's
`ParameterStatus` and `BackendKeyData` off the compute stream and relaying them onward.

Two consequences:

- **Neon terminates auth at the proxy and stalls the client between `AuthenticationOk` and
  `ParameterStatus`.** It does **not** synthesize parameters, it forwards the compute's real ones.
  Zero divergence risk, at the cost of keeping the entire wait inside the client's connect budget.
- That is why Neon still trips Prisma's 5s `connect_timeout` on a slow wake. Their docs frame it
  as a client-retry problem ("pause for a short period to allow your compute to restart, then try
  reconnecting"), which reads like refusal but is really "the proxy held you and you timed out
  first." **Because PGlite's handshake is a constant and Neon's compute's is not, we can do the
  strictly better thing that Neon cannot.**

### Advertised cold start, and how they got it

Roughly 500ms typical; 300-800ms depending on compute size; total time-to-first-query 500ms to 1s
([Neon connection latency](https://neon.com/docs/connect/connection-latency),
[compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle)). Their own writeup says
they went from **3-6s to about 500ms**
([Cold starts just got hot](https://neon.com/blog/cold-starts-just-got-hot)).

**The mechanism is not clever lazy loading. It is compute pools.** In their words: "we're
(basically) always starting computes before anyone asks for them, and then when we get a request
for a compute, we just take an 'empty' compute, give it some configuration." Plus skipping
reconfiguration on non-first connects.

**A pool of pre-started computes is `min-instances >= 1` with someone else paying for it.**
zeropg's entire premise is `min-instances=0`. Not transferable at any price this project would
accept.

### Do they page in lazily? Yes, but architecturally

Neon's compute has no local datadir to restore: storage *is* the Pageserver, and per their docs
every page read goes through the Pageserver rather than hitting local disk. Compute start
downloads only a **basebackup** of non-relation files (control file, WAL, clog), which is small
and roughly size-independent. So the compute serves queries before any relation data is local,
because relation data never becomes local.

**LFC prewarm is the one deep-version idea Neon independently validates.** They offload the Local
File Cache page list to endpoint storage on shutdown and asynchronously reload those pages on
start (`/lfc/prewarm`, `/lfc/offload`), now automatically on all planned restarts of read/write
endpoints in all regions ([Neon changelog 2026-03-27](https://neon.com/docs/changelog/2026-03-27),
[Prewarming](https://neon.com/blog/prewarming)). That is precisely the "learned hot-page set" at
`docs/LAZY-PAGEFAULT-RESTORE-from-blob.md:10-11`. If the deep version is ever revived, this is
external evidence that **the hot-set half is the part that pays** - and it is also the part the
spike never built.

### Transferable versus not

| Neon mechanism | transfers to single-process PGlite-in-WASM? |
|---|---|
| proxy terminates TLS and auth before the backend exists, holds the client | **Yes.** This is the core of the design here. |
| pre-warmed compute pool (the actual source of the 500ms) | **No.** That is `min-instances >= 1`. Depends on their multi-node split. |
| storage-as-Pageserver, no datadir restore at all | **No.** PGlite requires a real datadir on a real (tmpfs) filesystem. Depends on the compute/Pageserver/Safekeeper split. |
| basebackup limited to non-relation files | **Partially.** This is the deep version's thesis, and its own crossover analysis says it pays only above 50-100MB with a small hot set. |
| LFC offload and prewarm of a hot-page list | **Yes in principle**, and it is the highest-value unbuilt piece of the deep version. |
| forwarding the backend's real `ParameterStatus` instead of synthesizing | **Possible, but inferior here**: it keeps the wait inside `connect_timeout` and re-creates Prisma's P1001. |

**Set expectations honestly: we will not reach 500ms.** Neon's floor is low because their restore
is roughly zero. Ours cannot go below `pgliteCreateMs` (675-1174ms VERIFIED) plus the roughly 2s
platform floor (`docs/COLDSTART-MODEL.md:9`). What we *can* reach is "the connection never fails",
which is most of what users actually notice.

---

## 10. Staged recommendation

Effort estimates are person-days for someone already inside this codebase, including tests.

### Stage 1 - answer `SSLRequest` with `N`. **DONE, 0 days remaining.**

Shipped on the `blob-pglite-dev` VM at commit `9da362e` as `packages/server/src/wire-frontend.ts`,
per [`CONNECTION-SECURITY-AND-WIRE.md`](CONNECTION-SECURITY-AND-WIRE.md) section 3, with real-libpq
tests at `packages/client/test/wire-sslmode.test.ts`. My independent prototype VERIFIED the same
behavior from scratch, so this is corroboration. **The only remaining action is getting `9da362e`
onto a remote**, since section 11 of that doc records it as unpushed and it is currently the single
point of failure for the fix.

### Stage 0 - bind the port at t=0, hold, splice. ~1 day. Does NOT require owning the frontend.

**Cheaper than originally scoped, because `WireFrontend` already exists and already owns the
public port**, peeking the startup bytes and proxying to an inner `PGLiteSocketServer` on a private
loopback port. Two changes to it:

1. **Bind before `boot()` instead of after.** Today `ZeroPGServer.start()` calls `srv.listen()`
   (HTTP only) then `void srv.boot()` (`packages/server/src/server.ts:125-126`, VERIFIED), and the
   wire comes up at `phase = 'wire'` (`packages/server/src/server.ts:156-168`). Move the wire bind
   to alongside the HTTP bind.
2. **Hold accepted sockets until ready.** Do nothing to them: no `'data'` listener, no `resume()`,
   so bytes accumulate in the socket's readable buffer under TCP backpressure (VERIFIED mechanism).
   When `phase === 'ready'`, connect the inner proxy leg as `WireFrontend` already does, or hand
   the socket to a `PGLiteSocketHandler` (VERIFIED exported from `@electric-sql/pglite-socket`),
   whose `attach()` adds the `'data'` listener and drains the buffer automatically.

Delivers roughly 80% of the user-visible value: **`ECONNREFUSED` becomes "connect is slow"**, which
retires the `docs/LIMITATIONS.md:73-75` caveat for every client whose connect budget exceeds the
restore (libpq unbounded, `pg` 0, pgx none, pgjdbc `loginTimeout` 0). Does **not** rescue Prisma at
11s (5s `connect_timeout`); that is what Stage 2 is for.

Do this regardless of what happens to the frontend project. Small, reversible, and belongs behind
`ZEROPG_WIRE_EARLY_BIND=1`.

**Carry the `53300` fix with it** (section 0.5 item d): once the port accepts at t=0 the
connection cap must be enforced at accept time with a protocol-legal `ErrorResponse`, not by the
inner server's raw `"Too many connections\n"` write seconds later.

### Stage 2 - synthesize the handshake, hold the query. 3-5 days. REQUIRES owning the frontend.

The core design (section 2). Hard dependency: auth must terminate at the frontend, so pg-gateway
(or equivalent) must be adopted first. Checklist:

- section 8.1 items 1-8 (notably `BackendKeyData`, which pg-gateway does not send today, and the
  `ERR_INVALID_STATE` crash, which is a blocker for publicly bound wires).
- **Discard the backend's own handshake on splice** (section 0.5 item a), or use the in-process
  path so PGlite never emits a second one. This is the answer to the open question in
  `CONNECTION-SECURITY-AND-WIRE.md` section 6 and it is no longer a blocker.
- **Frontend-owned connection cap with a `53300 too_many_connections` `ErrorResponse`**
  (section 0.5 item d). Prerequisite, not a follow-up.
- The **lease gate** from section 7: split `boot()` into `leasing` and `restoring`, stay silent
  during `leasing`, answer the handshake only once the lease is held, fail fast on `FencedError`,
  assert `ZEROPG_HOLD_MAX_MS < acquireTimeoutMs`.
- The **single paused queue** from section 8.2, with `Sync`-boundary message grouping.
  Non-negotiable: this is what keeps RLS isolation intact.
- The **hold ceiling** from section 2.5 (`ZEROPG_HOLD_MAX_MS`, default 60000) with a
  phase-naming error message.
- **`57P03` / `57P01` FATAL plus close** on boot failure (section 4).
- **Docs**: replace the `ECONNREFUSED` caveat in `docs/LIMITATIONS.md` with the query-timeout
  caveat from section 3; add the Prisma pool-size >= 2 note; update `docs/COLDSTART-MODEL.md` to
  describe cold start as first-query latency rather than connection failure.

Ship behind a flag, with Stage 0 as the fallback path.

### Stage 3 - middle tier (`SELECT 1` / `SET` / `SHOW` early). DROP.

Section 5. Structurally unsafe for `SET` and `SHOW` on a single shared session, and for the safe
subset it moves the wait rather than removing it, leaving total time-to-useful-response unchanged.
If a real user hits HikariCP `validationTimeout` churn, add one exact-match `select 1` in the
simple protocol only, roughly 40 lines, and refuse to let it grow.

### Stage 4 - schema-only / cached catalog answers. DROP as proposed.

Section 6. Requires either a second PGlite (doubling memory, the binding constraint) or an
exact-text response cache whose only defensible win is already captured for free by Stage 2
letting PostgREST boot in parallel. Measure the `postgrestMs` overlap after Stage 2 before
spending anything here.

### Stage 5 - lazy page-fault restore. KEEP PARKED.

Section 1. Never measured, branch stranded on a laptop, known blocker in the calibration harness,
unbuilt bucket fault path, crash matrix must be re-run. Zero benefit for the 3.5-5s small-DB case
that `docs/COLDSTART-MODEL.md` says is the common one. Revisit only with a real user well over
500MB, and start with the eager baseline the doc's own step 3 says was never taken.

### Order and total

0. **Push `9da362e`.** Stage 1 is done but exists on one unpushed VM checkout.
1. **Stage 0** - bind early, hold, splice, plus the `53300` fix. ~1 day, no frontend dependency,
   behind `ZEROPG_WIRE_EARLY_BIND=1`. Builds on the existing `WireFrontend`.
2. **Stage 2** - synthesize and hold. 3-5 days, lands with pg-gateway adoption, behind a flag,
   Stage 0 as fallback.
3. Measure the PostgREST parallel-boot overlap; update `docs/LIMITATIONS.md` and
   `docs/COLDSTART-MODEL.md`.
4. Stages 3, 4, 5: do not build.

**Total remaining for the whole valuable part: 4-6 person-days**, down from 5-8 because Stage 1
is shipped and Stage 0 inherits `WireFrontend`.

---

## 11. Uncertainties I did not resolve

- **`server_version` across a PGlite bump.** Only 0.5.2 was tested. The build-time assertion
  (section 8.1 item 6) is a mitigation, not a verification.
- **The `pid=42` constant is undocumented PGlite internals.** It held across every configuration I
  tried, but it is exactly the kind of thing that changes without a changelog entry. Announcing our
  own random values (section 2.6) makes us independent of it, which is the main reason to do so.
- **Only `psql` 18.4 and `node-postgres` 8.21 were driven against the prototype.** The pgjdbc, pgx,
  Prisma and PostgREST rows in section 3 are INFERRED from documentation. **Test pgjdbc first**, as
  it is the client most exposed to the `TimeZone` divergence.
- **TLS plus hold is untested.** The prototype answers `SSLRequest` with `N`. Holding a client
  across a completed TLS handshake should behave identically, but session-ticket and renegotiation
  behavior across a multi-second idle is unverified. Test before enabling on a publicly bound wire.
- **Neon's proxy call ordering** is read from `proxy/src/proxy/mod.rs` on `main` via a fetched
  summary, not a local checkout. Consistent with every documented symptom I checked, but verify
  against a clone before quoting it publicly.
- **Whether 11s is still the right worst case.** It comes from `docs/COLDSTART-MODEL.md:28` and
  `docs/LIMITATIONS.md:26`. I did not re-measure a 500MB restore.
- **The `Sync`-boundary interleaving hazard (section 8.2) is inferred from reading the bundled
  `QueryQueueManager`, not from a reproduced failure.** I am confident about the mechanism and
  confident that holding increases its exposure, but I did not construct a failing test.

---

## Files referenced

- `docs/LAZY-PAGEFAULT-RESTORE-from-blob.md`
- `docs/COLDSTART-MODEL.md`
- `docs/LIMITATIONS.md`
- `docs/TODO-pglite-socket-prepared-statements.md`
- `packages/server/src/server.ts`: `BootPhase` line 33, `bootTimings` 70-75, `wireHost` default 111,
  `srv.listen()` before `void srv.boot()` 125-126, `phase = 'restoring'` 137, `ZeroPG.open` 139-147,
  `acquireTimeoutMs` default 145, `phase = 'wire'` 156-168, PostgREST start 170-186
- `packages/client/src/wire.ts:91` (`serveWire`)
- `package.json:26` (`pg-gateway` devDependency), `package.json:33` (`@electric-sql/pglite`)
- `experiments/prisma-spike/pggw.ts`
- `node_modules/@electric-sql/pglite-socket/dist/chunk-TORNJX5U.js` (`QueryQueueManager`,
  `PGLiteSocketHandler`)
- `node_modules/pg/lib/client.js:112,160,355-358,366`; `node_modules/pg/lib/defaults.js:62,73`
- `node_modules/pg-gateway/dist/chunk-PGRRI4HM.js` (`BackendKeyData` as parser constant only)

## External sources

- [Neon compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle)
- [Neon connection latency and timeouts](https://neon.com/docs/connect/connection-latency)
- [Neon connection errors](https://neon.com/docs/connect/connection-errors)
- [Cold starts just got hot](https://neon.com/blog/cold-starts-just-got-hot)
- [Zero-Downtime Patching Part 1: Prewarming](https://neon.com/blog/prewarming)
- [Neon changelog 2026-03-27](https://neon.com/docs/changelog/2026-03-27)
- [neondatabase/neon proxy/src/proxy/mod.rs](https://raw.githubusercontent.com/neondatabase/neon/main/proxy/src/proxy/mod.rs)
- [libpq connection parameters](https://www.postgresql.org/docs/current/libpq-connect.html)
- [pgJDBC connection properties](https://jdbc.postgresql.org/documentation/use/)
- [Prisma PostgreSQL connector](https://www.prisma.io/docs/orm/overview/databases/postgresql)
