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

## E7. Does pg-gateway preserve transaction isolation? **OPEN, blocking any wire swap**

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
