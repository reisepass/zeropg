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

## E9. Does an open WebSocket pin a Cloud Run instance awake and billable? **DONE - YES, 1:1**

**Why.** [SPEC-wire-router.md](SPEC-wire-router.md) section 9 named this as the question that
decides whether the tiny-VM shim is viable at all. Section 2 of that spec says a WebSocket
tunnel is *the only* way a router can reach a Cloud Run backend, so it is required and must be
built on both ends. But if an open tunnel counts as an active request, then a long-lived
Postgres client connection tunnelled over it pins the backend instance awake for as long as the
client stays connected, and scale-to-zero collapses back to always-on. That would not make the
bridge harder to build; it would make it pointless.

**Setup.** `experiments/e9-ws-pin/` - a dependency-free Node service that accepts a WebSocket,
sends one frame at open, then goes completely silent. It carries a `setInterval` tick counter so
CPU scheduling during the hold is observable independently of anything the client sees. Deployed
twice to Cloud Run (`min-instances=0`, `max-instances=1`, 1 vCPU / 512 MiB, europe-west1), once
with `--timeout=300` and once with `--timeout=3600`. `hold.mjs` opens one connection from
outside GCP and holds it idle, sending nothing.

### Result: the connection pins the instance, at exactly 1:1

`--timeout=300` service, one idle WebSocket held from 17:02:12Z:

```
request log:   status 101   latency 301.002044s   /wire
client:        {"event":"close","heldMs":300991,"code":1006,"wasClean":false}

billable_instance_time, 60s buckets:
  17:02  0.8      <- connection opens mid-bucket
  17:03  34.3
  17:04  60.2     <- fully billed, doing nothing
  17:05  60.1
  17:06  60.1
  17:07  60.2
  17:08  26.2     <- torn down mid-bucket
  17:09  0.0      <- counterfactual: billing stops when the socket closes
  TOTAL  301.9 billable seconds for a 301s idle hold
```

**301.9 billed seconds for 301 seconds of connection carrying zero bytes.** `instance_count`
held at 1 for the whole hold and dropped to 0 after. The 0.0 bucket after close is the control:
the instance is billed for exactly the connection's lifetime and not a second longer.

**The instance is not merely alive, it has full CPU.** The server-side tick counter advanced
70 -> 130 -> 190 -> 250 -> 310 -> 370 across the five one-minute heartbeats: exactly 60 ticks
per 60 seconds of wall clock, with no traffic on the socket. There is no throttled-but-open
state to exploit. This matches the documented behaviour ("A Cloud Run instance that has any open
WebSocket connection is considered active, so CPU is allocated"), and the measurement makes it a
fact rather than a doc claim.

**Confirmed over 20 minutes, ended by the client rather than the platform.** The 300s run above
is the clearer teardown evidence, but it is short enough that someone could argue the instance
simply had not been reaped yet. So the `--timeout=3600` service was given the same idle socket
for a full 20 minutes:

```
request log:   status 101   latency 1199.975145s   /wire
client:        {"event":"close","heldMs":1199961,"code":1005,"wasClean":true}

billable_instance_time: twenty consecutive 60.2-60.4 second buckets,
                        17:23 12.46, 17:24 11.70, then 0.0 from 17:25 onward
                        TOTAL 1201.6 billable seconds for a 1200s hold
server ticks:  137 -> 1276 across twenty one-minute heartbeats, no gap
```

**1201.6 billed seconds for 1200 seconds of silence**, and the ticks advance ~60 per minute for
the entire twenty minutes with no throttling interval anywhere. This run closed with code
**1005, `wasClean: true`** - our client hung up deliberately - which makes the contrast with the
300s run's platform-initiated 1006 exact rather than inferred. Billing then decays over roughly
two buckets and sits at 0.0. Idle time does not accumulate toward scale-down while a socket is
open; the hold is what keeps the instance alive, and only closing it releases the instance.

### The request timeout is a hard cap on connection lifetime

The `--timeout=300` connection died at **300991ms** with WebSocket close code **1006** (abnormal,
`wasClean: false`) - torn down by the platform, not by either endpoint. The `--timeout=3600`
service, given an identical idle connection at the same moment, sailed straight past 300s and
was still open and ticking at 360s+. So the cap is precisely the configured request timeout.

**The 60-minute maximum is real and enforced at the API**, not just documented:

```
$ gcloud run services update e9-ws-pin-t300 --timeout=3601
ERROR: service.spec.template.spec.timeout_seconds: Must be a number between 0 and 3600.
```

So the best case is a **hard 60-minute ceiling on any tunnelled connection**, after which the
client is disconnected uncleanly (1006) and must reconnect. Cloud Run's own docs note a
reconnecting client "isn't guaranteed to connect to the same instance", which for a lease-holding
database is a takeover, not a reconnect.

### What it means for the design

**Answer: yes, it pins the instance awake. The WebSocket bridge does not deliver scale-to-zero.**

- Cost: a pinned 1 vCPU / 1 GiB instance is roughly **$52/month per connected database**
  (30d x 86400s x ($0.000018/vCPU-s + $0.000002/GiB-s)). That is worse than the always-on VM the
  shim exists to avoid, and it is per database, not per fleet.
- The economics do not merely degrade, they invert: the shim's premise is one cheap always-on box
  fronting many scale-to-zero databases. With a tunnel per connection, every database with a
  connected client is also always-on, so you pay for the box *and* the fleet.
- A pooled client (any ORM default) holds several connections idle. Each is its own tunnel and
  its own billed request, so the pin is not even amortized.
- The 60-minute ceiling means even accepting the cost buys a connection that dies hourly with a
  1006 and may reconnect to a different instance.

**Consequence, recorded in the spec:** step 4 of the build order (the WebSocket bridge) does not
achieve what it was for. Steps 1-3 stand on their own for the fat-box configuration, which does
not involve Cloud Run at all. The tiny-shim-plus-Cloud-Run-backends shape needs a different
reachability answer than option (1), or it needs the databases to live somewhere with real TCP
ingress - which is what **E1** (Azure Container Apps) and Fly.io are about.

**What this does NOT rule out.** A tunnel opened *per query* and closed immediately bills only
for the query, and the router could keep the client's TCP connection alive across those. That is
a materially different design from the one in spec section 2 - it gives up session state,
transactions, and the single-session model PGlite requires - and nothing here says it works. It
is recorded only so the reader knows the pin applies to *held* connections specifically.

**Reproduce.** `experiments/e9-ws-pin/{server.mjs,hold.mjs,Dockerfile}`; deploy with
`--min-instances=0 --max-instances=1`, run `node hold.mjs wss://<url>/wire 12`, then read
`run.googleapis.com/container/billable_instance_time` over the window.
## E10. Does a per-BURST WebSocket tunnel keep the shim viable? **DONE - YES. Warm, free, and ~100ms**

**Why.** [E9](#e9-does-an-open-websocket-pin-a-cloud-run-instance-awake-and-billable-done---yes-11)
answered a narrower question than it appeared to: it measured a tunnel **held open and idle**,
because that is what the spec specified. It was briefly over-read as killing the tiny-VM shim
outright. It does not.

A shim terminates the client's connection, so client-connection lifetime and backend-tunnel
lifetime are independent. The client holds `postgres://` open for hours; the router opens a
tunnel only when a query arrives and closes it when the burst ends. E9's own control makes this
look good: **billing stopped the instant the socket closed**, the next 60s bucket read `0.0`,
no idle tail. A burst tunnel would be billed for the burst and nothing more, which beats the
HTTP face where Cloud Run's 15-minute reaper bills 20 minutes for a 5-minute session.

**The open question is latency, not cost or correctness.** Closing the tunnel may let the
instance scale to zero, in which case the next burst pays a full cold start (3.5s to 11s). Or
Cloud Run may keep it warm-but-unbilled for some window, in which case bursts are cheap and
fast. E9 measured `billable_instance_time`, not instance lifetime, so nothing here is known.

**Setup.** Reuse `experiments/e9-ws-pin/`. Open a tunnel, send a trivial query, close it, wait
N seconds, reopen and time the round trip. Sweep N across roughly 5s, 30s, 60s, 300s, 900s.
Record for each: time-to-first-byte on the reopen, and whether `billable_instance_time` accrued
during the gap. That distinguishes "instance stayed warm and free", "instance stayed warm and
billed" and "instance died, full cold start".

**Also test the transaction rule**, since it is the correctness half: drive a client through
`BEGIN; ...; COMMIT` with an idle gap in the middle and confirm the router refuses to close the
tunnel while `ReadyForQuery` reports `T`, and does close it on `I`.

**Decides.** Whether the tiny-VM shim in front of Cloud Run backends is viable at all, and
therefore whether step 4 of the build order in [SPEC-wire-router.md](SPEC-wire-router.md) gets
built. Steps 1-3 do not depend on it.

### Result, 2026-07-28. The per-burst tunnel works. Between bursts the instance is warm AND free.

Ran on `experiments/e10-ws-burst/`, deployed to Cloud Run `e10-ws-burst` (europe-west1,
`--min-instances=0 --max-instances=1`, 1 vCPU / 512 MiB, `--timeout=3600`). Each burst opens a
WebSocket, waits for the hello frame, sends one trivial query, reads the reply, and closes.
The gap that follows carries **no open connection at all**.

```
gap    reopen TTFB   query   same instance?   ticks in gap    CPU work unit during gap
                                              (vs wall clock)  (n, min / median / max)
 5s        107ms      3ms    yes  41d8b82a      2 / 5           2   50ms / 4056ms / 4056ms
30s        110ms      3ms    yes  41d8b82a      5 / 30          5   47ms / 8600ms / 9390ms
60s         97ms      2ms    yes  41d8b82a      8 / 60          8   52ms / 8701ms / 9099ms
300s        93ms      4ms    yes  41d8b82a     27 / 300        27  356ms / 11200ms / 13900ms
```

**No gap ever cost a cold start.** The instance identity (`boot`) was the same `41d8b82a`
across every gap up to and including 300 seconds, so nothing was restarted and no burst paid
the 3.5s-11s restore. Reopen time-to-first-byte sat in a **93-110ms** band with no upward trend
against gap length - that is the round trip to europe-west1 plus the TLS and WebSocket
handshake, not a wake.

**And the gap is not billed.** `run.googleapis.com/container/billable_instance_time`, 60s
buckets, over the sweep:

```
20:50  0.0     20:53  0.1     20:56  0.0
20:51  0.4     20:54  0.0     20:57  0.1
20:52  0.1     20:55  0.0     20:58  0.0
```

Set against E9's held socket, which billed **60.2 seconds per 60-second bucket** on the same
configuration, this is the whole result in one comparison: **held tunnel 60.2 s/min, per-burst
tunnel ~0.1 s/min, and the instance survives either way.** The tenths that do appear are the
bursts themselves.

### The tick counter is not a CPU measurement, and E9's use of it overstated its case

E9 concluded "the instance is not merely alive, it has **full CPU**" from a `setInterval` tick
advancing 60 times per 60 seconds. The first E10 sweep reproduced exactly that: ticks kept pace
across the gaps, and the run was on course to be written up as WARM-WITH-CPU (billed).

That reading is wrong, and the billing metric above is the proof. A `setInterval` callback that
increments an integer is nearly free, so it keeps firing on schedule on an instance throttled to
a small fraction of a core. **Ticks measure scheduling, not capacity.** So the probe was changed
to run a fixed CPU-bound unit of work (a 2M-iteration arithmetic loop) inside each tick and
record how long it took. The same unit of work:

- **~50ms** while a socket is open (E9's condition), and
- **4,056ms to 13,900ms** during a gap with nothing connected

which is an **80x to 190x** throttle. The instance is held in memory with its CPU almost
entirely withdrawn. That is precisely the "warm but unbilled" state E10 was written to look for,
and E9's instrument could not have detected it. The billing metric and the work-unit timing are
independent measurements and they agree.

This does not overturn any E9 number: E9's billing figures stand, and a *held* socket really is
billed 1:1 with full CPU. What is corrected is the inference that ticks alone establish CPU
allocation.

### The transaction rule holds, and the close is genuinely conditional

`experiments/e10-ws-burst/txn-rule.mjs` is a real Postgres wire proxy - it parses the actual
byte stream in both directions and applies a 3s idle-close timer gated on the `ReadyForQuery`
status byte. Driven by a real `psql` session against the live E11 Fly backend, with 6s gaps so
the timer fires repeatedly inside each state:

```
{"event":"ready-for-query","status":"I"}
{"event":"ready-for-query","status":"T"}
{"event":"tunnel-close-REFUSED","readyForQueryStatus":"T","reason":"...inside a transaction, MUST NOT close"}
{"event":"tunnel-close-REFUSED","readyForQueryStatus":"T","reason":"...inside a transaction, MUST NOT close"}
{"event":"ready-for-query","status":"E"}
{"event":"tunnel-close-REFUSED","readyForQueryStatus":"E","reason":"...inside a transaction, MUST NOT close"}
{"event":"tunnel-close-REFUSED","readyForQueryStatus":"E","reason":"...inside a transaction, MUST NOT close"}
{"event":"ready-for-query","status":"I"}
{"event":"tunnel-close-ALLOWED","readyForQueryStatus":"I","reason":"ReadyForQuery=I, session is idle, safe to close"}

  PASS  proxy parsed ReadyForQuery='T' / 'E' / 'I'
  PASS  close REFUSED while ReadyForQuery='T'
  PASS  close REFUSED while ReadyForQuery='E'
  PASS  close ALLOWED once ReadyForQuery='I'
  PASS  no close ever ALLOWED on a non-'I' status
  PASS  row committed across the gap survived (count=1, got 1)
  RESULT: PASS
```

The `COMMIT` issued after a 6s gap succeeded and the row is visible on a separate direct
connection, so the refusal protected real work rather than only logging that it would. A failed
transaction (`E`) is held open too, and released only when `ROLLBACK` returns the session to
`I` - the close is conditional in both directions, not a disguised "never close".

**A trap worth recording, because it fails silently and in the SAFE direction.** The first
version of the parser walked Postgres message framing from byte zero and never found a single
`ReadyForQuery`: every decision saw `status: null`. The cause is that libpq at its default
`sslmode` sends an `SSLRequest` first, and the server answers with a **single bare byte** (`N`)
that is not a length-framed message. Feeding that byte to the framing walker desyncs it
permanently - it reads `N` as a message type and the next four bytes, really the head of
`AuthenticationOk`, as a length. Nothing errors. The proxy simply never observes a transaction
state again, and because `null` is not `'I'` it refuses every close, so the test still *passed
every behavioural assertion*. A router built this way would look correct and would never close a
tunnel, quietly reverting to E9's billed-held-tunnel economics. The harness now asserts that
`T`, `E` and `I` were each actually parsed, so a null-status run fails loudly.

### What it means for the design

**Answer: yes, the per-burst tunnel keeps the shim viable. Step 4 of the build order is back on.**

- **Cost.** A burst tunnel is billed for the burst and nothing else. Idle gaps up to 300s cost
  ~0.1 s/min against E9's 60.2 s/min, so the shim's premise - one cheap always-on box fronting
  many scale-to-zero databases - survives intact.
- **Latency.** ~100ms to reopen, flat across gap length. There is no cold start to absorb at
  these gaps, so [COLDSTART-ABSORPTION.md](COLDSTART-ABSORPTION.md)'s hold-the-first-query
  machinery is not needed on the warm path (it is still needed for the genuinely-cold first hit).
- **Correctness.** The `ReadyForQuery` rule is sufficient for the transaction half and is cheap
  to implement, since the router parses the protocol anyway to route by database name.
- **The 60-minute request-timeout ceiling stops mattering.** It caps a single tunnel's lifetime,
  and a burst tunnel lives for a burst. The client's own `postgres://` session is terminated at
  the router and is unaffected.

**What this does NOT establish.** The upper end of the sweep is unfinished: 900s was still
running when this was written, so the warm window's outer edge is unmeasured and the instance
may well die somewhere between 300s and 900s. That only costs a cold start on the first burst
after a long quiet period, which is the case the product already absorbs. Also untested: bursts
against a backend doing real PGlite work rather than an echo, and concurrent bursts from several
routed databases at once.

**Reproduce.** `experiments/e10-ws-burst/{server.mjs,burst.mjs,Dockerfile}`; deploy with
`--min-instances=0 --max-instances=1 --timeout=3600`, run
`node burst.mjs wss://<url>/wire 5 30 60 300 900`, then read
`run.googleapis.com/container/billable_instance_time` over the window. Transaction rule:
`./txn-rule-drive.sh <backend-host> 5432` against any real Postgres wire endpoint.

---

## E11. Fly.io baseline: does a public `postgres://` with scale-to-zero actually work? **OPEN, unblocked**

**Why.** Fly.io forwards real public TCP (`[[services.ports]] port = 5432, handlers = []`) and
stops idle Machines (`auto_stop_machines` / `auto_start_machines`, `min_machines_running = 0`).
If both hold together, Fly gives what Cloud Run cannot: a genuine `postgres://` URL that costs
nothing idle, **and no shim is needed at all** because clients dial the backend directly. That
would make the Cloud Run shim a niche path rather than the main one.

Access is in place: `flyctl` is authenticated on `blob-pglite-dev` as `ruben@forest-ai.org`,
org `personal`, with `FLY_API_TOKEN` and `PATH` wired into `~/.bashrc`. There is prior art at
`experiments/standalone-service/fly.toml` and `scripts/deploy-standalone-fly.sh`. Tigris
(`https://fly.storage.tigris.dev`) is the natural object store there, but **the credentials in
`.tigrisfly.env` were exposed in a session transcript on 2026-07-28 and must be rotated before
use.**

**Setup.** Deploy `@zeropg/server` to one Fly Machine with a raw TCP service on 5432,
`auto_stop_machines = "stop"`, `min_machines_running = 0`, backed by a Tigris bucket. Then:

1. Let it stop. Confirm the Machine is genuinely stopped and not billing.
2. `psql` at libpq's **default** `sslmode` straight at the public hostname. Does the connection
   get held while the Machine starts, or refused? This is the Fly counterpart of E1 and it is
   the whole question.
3. Measure connect-to-first-row on a cold Machine, and separately on a warm one.
4. Confirm the single-writer constraint: `min_machines_running` is a floor, not a ceiling, so
   verify that only one Machine ever holds the lease and that a second would be fenced rather
   than corrupting.

**Then, and only after the baseline passes**, layer step 5 of
[SPEC-wire-router.md](SPEC-wire-router.md): real TLS and SCRAM from the forked pg-gateway.
On Fly the port is genuinely public, so unlike loopback these are load-bearing rather than
theater. Test `sslmode=require`, `verify-full` against a real cert, and a wrong password.

**Decides.** Whether the product's public-`postgres://` story is "deploy to Fly" rather than
"run a shim in front of Cloud Run". If Fly passes, the shim drops to one row of the scope table
in SPEC-wire-router.md section 0 and stays there.

---

## E12. Is the pg-gateway TLS process kill real, and is it patchable? **DONE - real, and patchable in ~15 lines**

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

---

## E13. Does prepared-statement namespacing unblock sqlx? **DONE - namespacing works, sqlx stays blocked**

**Why.** [TODO-pglite-socket-prepared-statements.md](TODO-pglite-socket-prepared-statements.md)
calls this "the single highest-value enhancement surfaced by the real-apps
exercise", because named prepared statements are what block Rust sqlx and Diesel,
neither of which has a DSN escape hatch the way Go's pgx does
(`default_query_exec_mode=cache_describe`). The rewriter was previously built and
verified; this rebuilds it, then asks the question that was not asked - whether
fixing names is sufficient.

### Result, 2026-07-28. The rewriter works. It is not enough.

`experiments/pg-gateway/lib/stmt-rewriter.ts`, roughly 45 lines of real logic,
prefixes statement and portal names per connection on Parse/Bind/Describe/Close/Execute.
`e-prepared-stmts.ts` drives it with real node-postgres clients:

```
=== collision [rewriter OFF] ===
  A prepares s1: rows=1
  B prepares s1: ERROR 42P05 prepared statement "s1" already exists

=== collision [rewriter ON] ===
  A prepares s1: rows=1
  B prepares s1: rows=2
  A re-executes s1: 1

=== many connections, same statement names, concurrent ===
  8 connections x 5 rounds of prepared "shared": 0 failure(s)
```

Reproduced as previously recorded, and it holds under 8-way concurrency with every
connection reusing the same name.

### The blocking finding: advisory locks are unfixable at the wire layer

```
pg_try_advisory_lock(42) from 3 separate connections: [true, true, true]
rows in pg_locks where locktype='advisory': 1
```

**All three connections were granted the same exclusive lock.** Confirmed to be
inherent, not an artifact of the gateway or the rewriter - calling
`pg_try_advisory_lock(42)` three times against a bare `PGlite` instance with no wire
at all returns `true, true, true` with one row in `pg_locks`. Advisory locks are
session-scoped and **re-entrant within a session**. Multiplexing N connections onto
one session means they are all the same lock holder, so mutual exclusion silently
degrades to a no-op.

This is the mechanism behind the previously measured result, and it means:

- **sqlx is NOT unblocked by statement namespacing.** `sqlx migrate` serializes on
  `pg_advisory_lock`. With namespacing it gets past 42P05 and then races on
  migrations instead - arguably a worse failure, because 42P05 is a loud error and a
  lost migration race is silent corruption.
- The same applies to golang-migrate, Diesel's migration harness, and anything else
  using advisory locks as a distributed mutex.
- No wire-layer rewrite can fix it. The lock namespace is the session, and the whole
  premise is one shared session. Fixing it means either a real lock manager in the
  router keyed by connection id, or a per-connection PGlite, which is the thing the
  architecture exists to avoid.

**So the value of the rewriter is narrower than the TODO claims.** It unblocks
drivers that merely *name* statements. It does not unblock the migration path for
any driver that also takes an advisory lock, which is most of them.

### The edges, all confirmed

| edge | result |
| --- | --- |
| SQL-level `PREPARE p1` | `42P05` - it is a `Query` message carrying SQL text, so the rewriter never sees a name field |
| `DEALLOCATE d1` after a protocol prepare | `26000 prepared statement "d1" does not exist` - client asks for the unprefixed name |
| `pg_prepared_statements` | shows `c1_d1` - leaks the internal prefix, and shows every other connection's statements |
| `ErrorResponse` text | **fixed here.** `rewriteIncoming()` strips the prefix from ErrorResponse/NoticeResponse |

The ErrorResponse un-prefixing was previously listed as unhandled and is now
implemented. It was verified with a negative control rather than trusted, because
node-postgres raises its own client-side error for a duplicate name that never
reaches the server and would have made the test pass vacuously. Driving a raw
`Describe('S', 'ghost')` over a hand-built socket:

```
without rewriteIncoming:  prepared statement "c1_ghost" does not exist
with    rewriteIncoming:  prepared statement "ghost" does not exist
```

**Decides.** Build the rewriter, it is cheap and correct. But do not put "unblocks
sqlx" on it in any roadmap or marketing copy - that claim is now measured false. The
advisory-lock semantics are the real blocker for Rust migration tooling, they sit
below the wire, and they need their own entry.

---

## E14. Does `sslnegotiation=direct` hang or error? **DONE - it hangs, indefinitely**

**Why.** [WIRE-AUTH-DECISION-2026-07-28.md](WIRE-AUTH-DECISION-2026-07-28.md) section 4
predicts this and adds ALPN to the patch list, calling it "a hang, not an error - the
exact class we exist to eliminate". A prediction from reading the framer is worth
confirming, because an error is a support ticket and a hang is a burned connection slot
plus a user with no idea what happened.

### Result, 2026-07-28. Confirmed, and the hang is unbounded.

```
--- 1. direct TLS ClientHello with ALPN, the PG17 opening move ---
    HUNG (no response, no close, still open after 10022ms)
--- 2. bare 0x16 TLS record header, nothing else ---
    HUNG (no response, no close, still open after 10003ms)
--- 3. control: the SSLRequest path a PG16 client uses ---
    errored after 34ms: server replied "S"
```

The server sends nothing and closes nothing. The client waits until it gives up on its
own, and until then the connection slot is held.

**Client caveat, stated because it limits the claim.** The psql available here is
16.14, which predates the `sslnegotiation` parameter and rejects it outright
(`invalid URI query parameter: "sslnegotiation"`). So this is driven with `node:tls`
emitting a real ClientHello with `ALPNProtocols: ['postgresql']`, which is byte-for-byte
the opening move libpq makes. The property under test is what the server does with `0x16`
as the first byte, and that does not depend on which client produced it. A PG17 psql
should still be run against this before the ALPN patch is called done.

### Mechanism, exactly

Pre-startup, `message-buffer.ts:61` sets `codeLength = 0` (the startup packet has a
4-byte header with no type byte), so `processMessages()` reads a `uint32` at offset 0 and
treats it as the message length. For a TLS record header the first four bytes are
`0x16 0x03 0x01 0x02`:

```
0x16030102 = 369,295,618 bytes = 352 MiB
```

So the framer concludes the client has announced a 352 MiB startup packet, and the
`while (offset + headerLength <= bufferFullLength)` loop simply never yields. It is not
a crash or a rejection - it is a buffer patiently waiting for a third of a gigabyte that
will never arrive. Worse, a client that kept writing would be *fed into that buffer*,
which is a memory-growth path on unauthenticated input.

**This is a better argument for the framer being ours than the crash was.** It is not a
bug upstream would call a bug - pg-gateway simply predates PG17 direct SSL. But every
libpq from 17 onward can be pointed at us this way, and the correct behaviour (sniff
`0x16` as the first byte, branch to a TLS terminator with ALPN `postgresql`) is ~10 LOC
only because the TLS path already exists.

**Decides.** ALPN stays on the patch list and is now measured rather than predicted. The
first-byte sniff belongs in our framer, not in a pg-gateway option, because the framer
has to make the decision before pg-gateway's state machine starts.
