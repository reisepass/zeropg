# Experiments queue

Things documentation cannot settle. Each entry states the question, the setup, and what
result decides what. Ordered by how much a wrong guess would cost us.

Status legend: **OPEN** = not started. **RUNNING**. **DONE** = result recorded inline.

---

## E1. Does Azure Container Apps TCP ingress HOLD a connection during cold start? **OPEN**

**Why it matters most.** Azure Container Apps and Fly.io are the only two platforms found that
offer public TCP ingress *and* scale to zero. That combination is the one thing Cloud Run
cannot do, and it is what would let zeropg hand out a real `postgres://` URL. But the entire
value depends on an undocumented behavior: when a replica is scaled to zero and a TCP
connection arrives, does the ingress **hold** the connection while the replica starts, or
**drop** it?

- **Holds** - Azure becomes the strongest target we have found, and the handshake-early design
  in [COLDSTART-ABSORPTION.md](COLDSTART-ABSORPTION.md) composes with it.
- **Drops** - handshake-early cannot help there at all, because the platform kills the
  connection before our code ever sees it. Azure falls back to being no better than Cloud Run
  for the wire, and the public-`postgres://` plan needs Fly.io or nothing.

**Setup.** Deploy any trivial TCP echo server to a Container App in a VNet environment with
external TCP ingress, `minReplicas: 0`, `maxReplicas: 1`. Wait out the scale-to-zero cooldown
(documented at 300s). Then `time nc <fqdn> <port>` and observe: connection accepted and held
until the replica answers, versus connection refused or reset.

**Also measure** while there: end-to-end time from connect to first byte on a cold replica,
so we know what the hold budget would have to be.

---

## E2. What is the real ECS on Fargate cold start? **OPEN**

**Why.** [PLATFORM-PORTABILITY.md](PLATFORM-PORTABILITY.md) cites 20-60s from a third-party
source. That figure decides whether Fargate is merely worse than Cloud Run or unusable. Our
own measured Cloud Run figure is roughly 2s platform floor plus restore. A 10x difference
changes the recommendation; a 2x difference does not.

**Setup.** One task definition, our actual db image, `desiredCount` 0 to 1, measured from the
API call to the first successful HTTP response. Run it ten times and report the distribution,
not one number. Separate the platform's task-launch time from our restore time using the boot
telemetry the server already emits (`restoreMs`, `pgliteCreateMs`, `totalMs`).

**Decides.** Whether Fargate goes on the supported list, and whether the ALB-plus-Lambda waker
is worth writing.

---

## E3. Can zeropg run in-process inside a single container, and what does it give up? **OPEN**

**Why.** Every platform verdict in [PLATFORM-PORTABILITY.md](PLATFORM-PORTABILITY.md) was
built on requirement 1, "multiple containers sharing localhost". That requirement is not
actually load-bearing: zeropg is a Node library and can run in the app's own process, or as a
second process in one container. This flaw made App Runner a false "hard no" and may have
mis-scored others. See [AWS-SCALE-TO-ZERO.md](AWS-SCALE-TO-ZERO.md).

**Setup.** Take one verified app and run it three ways against the same bucket: (a) db as a
separate container talking over loopback, the current shape; (b) db as a second process in
the same container; (c) fully in-process via `connect()` with no wire at all. Compare cold
start, memory ceiling, and which features break in (c) - PostgREST needs a wire, so at minimum
`/rest` is lost.

**Decides.** Whether we can offer a genuinely single-container deployment, which would widen
the supported-platform list considerably.

---

## E4. Lambda: does the freeze/thaw model break the durability design? **OPEN**

**Why.** Lambda with container images gives truly zero idle cost, which no other AWS option
does. But zeropg has background timers for WAL-shipping, lease renewal and flush, and Lambda
freezes the execution environment between invocations. If nothing runs between invocations,
those timers do not fire and the durability model needs rework.

**Setup.** Deploy `@zeropg/server` behind the Lambda Web Adapter with a container image.
Write, then let the environment freeze, then check whether the flush timer ever fired and
whether the lease lapsed. Measure cold start with a real restore.

**Decides.** Whether Lambda is the best AWS answer or a fundamental mismatch.

---

## E5. Does pglite-socket 0.2.7 retire our SSLRequest workaround? **OPEN**

**Why.** pglite-socket 0.2.3 added `handleSslRequest()` replying `'N'`. The monorepo pins
`^0.2.2`. Our own `WireFrontend` (commit `9da362e`) does the same thing plus GSSENC plus the
connection cap. If the upstream fix is sufficient for the SSL cases, `WireFrontend` shrinks to
the parts still doing work.

**Setup.** Bump the root pin to `>=0.2.7`, then re-run `packages/client/test/wire-sslmode.test.ts`
(20 assertions, real libpq) plus psql, pg_dump, Adminer, WhoDB and Prisma's native engine
**before** touching any doc that says `sslmode=disable` is required.

**Decides.** How much of `WireFrontend` we keep, and whether the `sslmode=disable` sweep
through the docs can start.

---

## E6. Do the PGlite instance-kill packets survive a fix? **OPEN**

**Why.** Verified: `PasswordMessage` (`'p'`) and unknown message types cause an infinite
synchronous spin in `_PostgresMainLoopOnce` that blocks the whole Node event loop.
`SSLRequest` and `GSSENCRequest` permanently corrupt the WASM instance. `SET
client_encoding='LATIN1'` returns zero bytes forever and is a perfectly legal `Q` message, so
a message-type allowlist gives no protection. We survive today only because pglite-socket's
framer mis-sizes those packets.

**Setup.** A regression test that fires each packet at the wire and asserts the process stays
alive and the instance stays usable. Then confirm whether the SQL-level guard plus the
instance-death supervisor in milestone M1b actually catches all of them, including via
`DO $$`, dynamic `EXECUTE`, and the third statement of a multi-statement `Q`.

**Decides.** Whether the guard is sound or whether the supervisor is the only real defence.

---

## E7. Does pg-gateway preserve transaction isolation? **DONE - no, and the port fixes it**

**Why.** Verified that the naive adoption shape does **not**: under
`db.runExclusive(execProtocolRaw)`, one client's `COMMIT` terminated another client's
transaction and discarded its `SET LOCAL`. That is exactly the failure PostgREST's per-request
`BEGIN; SET LOCAL ROLE; ...; COMMIT` depends on not happening, so it is the RLS isolation
guarantee. pglite-socket's transaction-aware `QueryQueueManager` is what currently provides it.

**Setup.** Port the affinity queue, then run the existing `test/killswitch-rls-isolation.mjs`
plus an expanded suite: abrupt disconnect mid-transaction (PGlite swallows `Terminate`, so a
client can send `BEGIN; SET ROLE service_role;` then RST), extended-protocol concurrency, and
a transaction left in the failed `Z(E)` state.

**Decides.** Whether the wire swap is safe at all. This gates M2 entirely.

### Result, 2026-07-28. Confirmed broken, and the ported queue fixes it completely.

`experiments/pg-gateway/e7-tx-isolation.ts` runs five tests against two server
shapes that differ **only** in serialization. Same pg-gateway handshake, same single
PGlite instance in both.

| Test | naive (`runExclusive(execProtocolRaw)`) | affinity (ported queue) |
| --- | --- | --- |
| 1. `SET LOCAL` isolation | FAIL - `AAA saw AAA \| BBB saw <empty>` | pass - `AAA saw AAA \| BBB saw BBB` |
| 2. RLS cross-user bleed | **FAIL - B read A's rows** | pass - 0/20 bleed |
| 3. RST mid-transaction | FAIL - next connection inherits the role | pass - rolled back |
| 4. failed `Z(E)` state | FAIL - B gets `25P02` | pass - B returns 42 |
| 5. extended protocol | FAIL - same bleed via Parse/Bind | pass |
| | **7 failures** | **0 failures** |

**Test 2 is worse than the previously recorded failure and is the finding that
matters.** The prior record was that B's `SET LOCAL` got discarded. It is actually a
live cross-user read. With RLS enabled and `USING (owner = current_setting('request.uid', true))`:

```
A saw [A-secret-1, A-secret-2]
B saw [A-secret-1, A-secret-2, B-secret-1] (first of 20)
```

B's `BEGIN` landed inside A's still-open transaction, so B's `SET LOCAL ROLE` and
`set_config(..., true)` were applied on top of A's, and B's `SELECT` ran with **both**
users' rows visible. That is a Supabase-RLS-shaped tenant data leak, produced by two
ordinary clients doing nothing abusive. Only 1/20 reads bled because after the first
COMMIT the transaction closed, which makes it a race, which makes it worse - it is
load-dependent and would pass a casual test.

**Test 3 is the second unaccompanied hazard.** PGlite swallows `Terminate`, so a client
that sends `BEGIN; SET LOCAL ROLE authenticated;` then RSTs leaves
`db.isInTransaction() === true` forever under the naive shape. The very next connection
authenticates as `postgres` and finds itself running as `authenticated` with the dead
client's `request.uid` still set. `clearTransactionIfNeeded()` in the queue is what
issues the `ROLLBACK`; it has to be wired to socket close, which the naive shape has
no place to do.

**What the port is.** `experiments/pg-gateway/lib/query-queue.ts`, ported literally
from pglite-socket 0.2.2 `QueryQueueManager`. The rule is one line: while
`db.isInTransaction()`, only dequeue messages whose `handlerId === lastHandlerId`.
The `query = null; break` when the owning connection has nothing queued is load-bearing
and is commented as such - `continue` spins, and serving anyone else is exactly the bug.

**Method note that changes the vendoring plan.** The npm tarball's stated `files:
["dist/**/*"]` does ship the source after all: `dist/chunk-PGRRI4HM.js.map` carries
full `sourcesContent` for all 26 modules including `src/connection.ts` (620 lines) and
`src/auth/sasl/scram-sha-256.ts`. Same for pglite-socket's map. So "vendor the source"
does **not** require cloning an unmerged GitHub branch - the exact source for the
published 0.3.0-beta.4 artifact is already in `node_modules`, and it is the source that
corresponds to the tested binary rather than whatever `next` has drifted to. Recovered
with `experiments/pg-gateway/extract-source.mjs`.

**Decided.** The wire swap is safe **only** with the affinity queue. pg-gateway alone is
not a drop-in for pglite-socket and adopting it without the queue is a data-isolation
regression, not a feature trade. E7 no longer blocks M2; the queue port is now a
requirement on it.

---

## E8. Always-on VM versus scale-to-zero: where is the crossover? **OPEN**

**Why.** The honest version of "is the premise worth it". A t4g.nano or Hetzner CX11 costs a
few dollars a month and never cold-starts. Each PGlite holds its datadir in memory, so one
small VM cannot host many databases.

**Setup.** Not a deploy experiment so much as a measurement: how many idle PGlite instances
actually fit in 1 GB, 2 GB and 8 GB of RAM, against the real Cloud Run bill for the same
database count at 95 percent idle. [BREAK-EVEN.md](../BREAK-EVEN.md) has the cost model
already; this adds the VM column.

**Decides.** What we tell people the product is for, and at what fleet size we should stop
recommending it.

---

## E9. Is the pg-gateway TLS process kill real, and is it patchable? **DONE - real, and patchable in ~15 lines**

**Why.** [WIRE-AUTH-DECISION-2026-07-28.md](WIRE-AUTH-DECISION-2026-07-28.md) section 4
disqualifies adopting pg-gateway as a dependency on the strength of this one defect.
It deserved a reproduction rather than a citation, because if it is real it is a
one-packet unauthenticated remote DoS on every zeropg database container, and if it is
patchable the "we must own the source either way" conclusion still holds but for a
much cheaper reason.

### Result, 2026-07-28. Real. Reproduced. Worse than a hang, and trivially remote.

`experiments/pg-gateway/e-tls-kill.ts` spawns a child server per scenario so a real
process death is observable as an exit code. The server has every guard an application
can apply from outside the library: `socket.on('error')`, a `try/catch` around
`fromNodeSocket`, and a `.catch()` on its promise.

| scenario | outcome |
| --- | --- |
| `psql sslmode=verify-full`, mismatched CA | **process DIED, exit=1** |
| `psql sslmode=verify-ca`, mismatched CA | **process DIED, exit=1** |
| `psql sslmode=require` (client accepts cert) | survived, `select 1` returned |
| same attack + process-level `unhandledRejection` handler | survived |

```
Error: ...SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca...
  reason: 'tlsv1 alert unknown ca', code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'
node:internal/webstreams/writablestream:215
=> process DIED (exit=1 sig=null)
```

**No credentials, no valid startup packet, no account.** The attacker only has to
complete a TCP handshake and refuse the certificate, which every stock libpq does
automatically under `sslmode=verify-full` against a cert it cannot chain. A *misconfigured
client* kills the database. This is as likely to fire by accident as by malice.

### Mechanism, from the recovered source

Two independent defects compose, and both are needed for the process to die:

1. **`connection.ts:162`, the constructor calls `this.init(duplex)` and discards the
   promise.** Every rejection out of `init()` is an unhandledRejection, and Node's
   default for that is process exit. This is *why* the caller's `try/catch` and
   `.catch()` around `fromNodeSocket` cannot see it: they wrap the constructor, not
   the dangling continuation it launched.
2. **`connection.ts:228`, the `catch` block itself throws.** `processData()`'s `finally`
   has already run `streamWriter.releaseLock()`, but by then the underlying
   `WritableStream` is errored and locked by the TLS machinery. Both branches of the
   handler touch it anyway - `getWriter()`/`close()` on the `BackendError` path,
   `abort()` on the other - and each raises `ERR_INVALID_STATE: Invalid state:
   WritableStream is locked`. A throw from inside a catch, on an orphaned promise.

### The patch, and proof it works

`experiments/pg-gateway/vendor/patched/` holds the recovered source with three patches.
`e-tls-kill-patched.ts` runs the identical attack **with no process-level handler at all**,
so a survival is the source patch and nothing else:

```
[child] onConnectionError: ERR_SSL_TLSV1_ALERT_UNKNOWN_CA ...tlsv1 alert unknown ca...
[child] onConnectionError: ERR_INVALID_STATE Invalid state: WritableStream is locked
[child] ALIVE 1 ... ALIVE 5
ok   process SURVIVED 3 cert-rejection attacks with no process-level handler
ok   the failure is still observable through the error sink
ok   legitimate psql client served afterwards (777)
```

- **PATCH 1a**: keep the `init()` promise and attach a handler, so a failure is
  attributable instead of fatal.
- **PATCH 1b**: wrap the `catch` body in its own `try/catch`. Cleanup on an
  already-broken stream is best-effort; there is no peer left to tell.
- **PATCH 2**: replace `console.error(err)` with an `onConnectionError` option. Upstream
  lets a remote peer drive this process's stderr volume with no way to route, count or
  rate-limit it.

Total: about 15 lines. **A process-level `unhandledRejection` handler also stops the
death** (scenario 4) and is the only mitigation available without owning the source - but
it is a blunt instrument that swallows every unrelated bug in the process too, so it is a
stopgap, not a fix.

### The regression suite matters more than the patch

`e-patched-regression.ts` exists because a crash fix that quietly broke authentication
would otherwise read as a pass. Against real psql, all green:

```
ok   SCRAM-SHA-256 accepted the correct password over TLS
ok   SCRAM-SHA-256 REJECTED the wrong password
ok   md5 accepted the correct password via node:crypto MD5
ok   md5 REJECTED the wrong password
ok   sslmode=require still works
ok   sslmode=verify-full with the CORRECT CA still works
ok   sslmode=disable is refused when tls is configured
ok   plaintext gateway (no tls option) still works
```

**The `@std/crypto` audit came in far under budget.** Section 4 budgets "~60 LOC" to rip
out `@std/crypto` and a supply-chain audit for the inlined WASM. The real dependency
surface is four functions - `copy`, `concat`, `encodeHex`, `decodeBase64`/`encodeBase64` -
and **only `auth/md5.ts` ever reaches `@std/crypto` at all**, for the single reason that
Web Crypto has no MD5. `src/crypto.ts` already does SCRAM's PBKDF2/HMAC/digest against the
global `SubtleCrypto`. So the 196 KB Rust wasm-bindgen blob exists solely to serve the
legacy auth method we do not intend to offer, and `crypto.createHash('md5')` retires it.
`vendor/patched/src/std-shim.ts` is the whole replacement.

One gotcha worth recording, since it cost a debugging cycle and would recur: `md5.ts`
imports the shim as `crypto`, **shadowing the global**, then calls
`crypto.getRandomValues()` in `generateMd5Salt()`. A shim exposing only `subtle` turns
that into a TypeError that surfaces as "server closed the connection unexpectedly" - it
looks like a protocol bug, not a missing method. The shim must spread `globalThis.crypto`.

**Also confirmed, and it constrains the deployment shape:** pg-gateway has no
"TLS optional" mode. `connection.ts:370` refuses plaintext startup whenever `tls` is
configured, so one gateway cannot serve both `sslmode=disable` loopback traffic and TLS
traffic. Our own frontend has to decide that per-listener.

**Decides.** The defect is real and the "adopting as a dependency is disqualified"
conclusion stands. But it is a ~15-line fix in code we would own, not an architectural
flaw, so it argues for vendoring rather than against pg-gateway as a starting point.
