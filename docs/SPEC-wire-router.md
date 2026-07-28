# Spec: the zeropg wire router

Status: **SPEC, not built.** Written 2026-07-28.

One always-on process that terminates the Postgres wire protocol on a real TCP port, routes
each connection to the right database by name, and starts or wakes that database on demand.

It is **one program with a RAM budget**, not two products. The knob is how many databases it
keeps warm:

| warm set | box | what it behaves like | cold start on first hit |
|---|---|---|---|
| `0` | GCP `e2-micro`, ~1 GB | pure protocol terminator and waker | always paid |
| `1-2` | 2 GiB | shim that also hosts the hottest database | zero for the warm set |
| `16-18` | 8 GiB | actual database host | zero for the warm set |

Build it once. Pick the box later. Do not fork the codebase for the two shapes.

> **CORRECTED 2026-07-28, capacity is per INSTANCE, not per byte.** An earlier draft of this
> table said "3-4 medium, 15-20 small" on 8 GiB, extrapolating from "a 500 MB database wants
> about 2 GiB comfortable". That is wrong. Measured resident memory is roughly **constant per
> PGlite instance and almost independent of database size**: about 400 MB on Linux at a 7.7 MB
> database and about 420-440 MB at a 509 MB database. The footprint is PGlite's WASM heap, not
> your data. (A macOS spot-check gave much larger and noisier figures, with RSS falling after
> inserts, so treat the Linux numbers as the planning ones and re-measure on the target OS.)
>
> Two consequences. Capacity is a function of instance **count**, so a small database costs
> nearly as much resident memory as a medium one. And a `t4g.nano` cannot host zeropg at all.
> Tracked as E8 in [EXPERIMENTS-QUEUE.md](EXPERIMENTS-QUEUE.md).

## 1. Why this exists

zeropg's flagship platform cannot hand out a `postgres://` URL. Cloud Run accepts HTTP/1.1,
HTTP/2, gRPC and WebSockets, and **no inbound raw TCP**. Every other constraint the design
carries downstream of that - loopback-only wire, co-located app and db, `sslmode=disable`
everywhere - exists because of it.

A tiny always-on box removes it, for a few dollars a month, without giving up scale-to-zero
for the databases themselves.

It also fixes a second problem that has nothing to do with TCP. **The bucket holds a
database's identity, not any host.** So "warm on this box" versus "cold in the bucket" is only
a question of who holds the lease. Promotion and demotion move no data. That makes a warm tier
nearly free to add once something is routing connections.

## 2. The reachability problem, which decides the whole design

The router terminates a client's TCP connection. It then has to reach the actual database.
Three options, and on GCP only one works:

1. **WebSocket tunnel to the backend.** Cloud Run accepts inbound WebSockets. The router
   dials `wss://<service>/wire`, and a bridge inside `@zeropg/server` unwraps the stream onto
   the local loopback wire. **This is the only option that works with Cloud Run backends, so
   it is required, and it is new code on BOTH ends.**
2. **Start the database locally** in the router's own process. Works, bounded by RAM. This is
   the warm set.
3. **Proxy raw TCP** to a platform that accepts it - Fly.io, Azure Container Apps. Simplest,
   but not available on the flagship platform.

> **NARROWED 2026-07-28 by experiment E9. A HELD tunnel is dead. A per-burst tunnel is not
> tested and is probably the right design.**
>
> An earlier revision of this callout said "option (1) is DEAD, do not build the bridge". That
> overstated the result. E9 tested a tunnel **held open and idle**, because that is what
> section 2 specified. It says nothing about a tunnel opened per query burst and closed
> immediately, which is the obvious fix and which the same measurement makes look attractive.
>
> An open WebSocket pins a Cloud Run instance awake and billable at exactly **1:1**. Measured
> on a deployed service with `min-instances=0`: a 301-second idle connection carrying zero
> bytes produced **301.9 billable seconds**, `instance_count` pinned at 1 for the whole hold
> and 0.0 the bucket after close. The instance is not merely alive, it has **full CPU** - a
> server-side tick counter advanced exactly 60 ticks per 60 seconds of wall clock with no
> traffic on the socket. There is no throttled-but-open state to exploit.
>
> So a tunnelled Postgres connection is an always-on billed instance for as long as the client
> stays connected. Scale-to-zero collapses entirely, and the shim's whole reason for existing
> goes with it.
>
> **Independently fatal even if billing were free:** the Cloud Run request timeout is a hard
> cap on connection lifetime. The `--timeout=300` service tore the connection down at 300991ms
> with close code **1006** (abnormal, `wasClean: false`), platform-initiated. The maximum is
> **3600 seconds, enforced at the API** (`--timeout=3601` is rejected outright). Every Postgres
> connection through such a tunnel would be severed at 60 minutes with an abnormal close, and
> pools would churn against it forever.
>
> Full measurements in [EXPERIMENTS-QUEUE.md](EXPERIMENTS-QUEUE.md) E9.
>
> **What survives.** Option (2), a local warm set, is untouched - it never involved Cloud Run.
> Option (3) is untouched: Fly.io and Azure Container Apps accept real TCP, so a router fronting
> those needs no tunnel at all. And the HTTP `/sql` face on Cloud Run is untouched, because
> those are short requests rather than held connections.
>
> **What this changes about the product.** A router that holds one tunnel per client connection
> cannot make Cloud Run backends reachable over `postgres://` at a price anyone would pay. That
> specific design is out.
>
> ### The per-burst tunnel, which E9 did not test and which the same numbers favour
>
> **The point of a shim is that it terminates the client connection.** Client-connection
> lifetime and backend-tunnel lifetime are therefore independent. The client can hold a
> `postgres://` session open for hours while the router opens a tunnel only when a query
> arrives and closes it as soon as the burst ends.
>
> E9's own control measurement is the encouraging part: **billing stopped the instant the socket
> closed** - the 60s bucket after close read `0.0`, with no idle tail at all. So a burst tunnel
> is billed for the burst and nothing else, which is *better* than the HTTP face, where Cloud
> Run's 15-minute reaper bills 20 minutes for a 5-minute session.
>
> The objection recorded in E9 is that this "gives up session state, transactions, and the
> single-session model PGlite requires". Two of those three are weaker than they look **because
> of** PGlite's constraints rather than in spite of them:
>
> - **Session state**: PGlite is one shared session for every connection. Per-connection session
>   isolation does not exist today - session GUCs and `SET ROLE` already leak across connections
>   and that is documented. There is little per-connection state to lose that was not already
>   shared.
> - **Transactions**: a real problem, and a solvable one. The router parses the protocol, so it
>   sees the `ReadyForQuery` status byte (`I` idle, `T` in transaction, `E` failed transaction).
>   Rule: only close the tunnel on `I`. Never mid-transaction.
> - **Named prepared statements**: genuinely lost across a tunnel close. They already collide
>   with `42P05` on the shared session, so the population that depends on them is blocked today
>   regardless.
>
> **The real unknown is latency, not correctness.** If closing the tunnel lets the instance
> scale to zero, the next burst pays a full cold start (3.5s to 11s). If Cloud Run keeps the
> instance warm-but-unbilled for a while, it does not. E9 measured billing, not instance
> lifetime, so this is open. Tracked as **E10** in [EXPERIMENTS-QUEUE.md](EXPERIMENTS-QUEUE.md).
>
> Until E10 runs, do not conclude either way. Steps 1-3 of the build order do not depend on it.

Superseded framing, kept for the record: the original spec said a router without (1) can accept
your connection and then do nothing useful on GCP, and must not ship without the bridge. E9 shows the bridge itself is the non-viable part.

## 3. Routing requires parsing the startup packet

To route by database name, something must read the `database` field out of the StartupMessage.

- **PGlite discards it.** Verified: two startup packets with different `user` and different
  `database` produce byte-identical 429-byte responses. It is a single-user backend that is
  already logged in.
- **pglite-socket never parses it.** The only protocol field it reads is
  `readInt32BE(4) === 196608`; everything else is forwarded as opaque bytes.

So the router must own a real startup-packet parser. **This is the strongest justification for
the wire-frontend work in the whole project**, and it is independent of TLS and SCRAM, both of
which are theater on loopback. Routing is not theater anywhere.

See [WIRE-AUTH-DECISION-2026-07-28.md](WIRE-AUTH-DECISION-2026-07-28.md) section 4 for the
build-versus-vendor call on the frontend itself.

## 4. Connection lifecycle

```
client connects, TCP :5432
  ↓
SSLRequest / GSSENCRequest handled (reply 'N', or terminate TLS if configured)
  ↓
parse StartupMessage -> { user, database, options }
  ↓
authenticate (SCRAM, or trust when bound to loopback)   [see the credential model]
  ↓
resolve `database` -> a placement
     warm here          -> attach to the local PGlite instance
     cold, RAM free     -> start locally, take the lease, attach
     cold, RAM tight    -> evict LRU (flush, release lease), then start locally
     remote             -> wake over HTTP, open the WS tunnel, attach
     unknown name       -> ErrorResponse 3D000 invalid_catalog_name
  ↓
replay PGlite's real handshake block, then proxy
```

**Handshake replay, not synthesis.** Harvest PGlite's real 429-byte block once at boot, strip
`R` (AuthenticationOk) and `K` (BackendKeyData), force the trailing `Z` to `'I'`, and emit all
16 real `ParameterStatus` messages. Do not fake `server_version` the way the existing
pg-gateway spike does. Caveat from probing: `ParameterStatus` values go stale across
connections, so track them live rather than replaying a boot snapshot forever - a `SET
TimeZone` emits six updates to the setter only, and pinning boot-time values is silent
timestamp corruption.

**Hold the connection during a cold start.** Complete the handshake immediately, then hold the
first query until the database is ready. Measured with a prototype: node-postgres at library
defaults against an 11s restore connected in 4ms and returned correct rows at 10880ms. Cap the
hold at 30s, and cap the leasing and restoring phases separately so the error names the phase
it died in. Full analysis in [COLDSTART-ABSORPTION.md](COLDSTART-ABSORPTION.md).

## 5. Eviction, and the data-loss hazard in it

**Every demotion must `POST /flush` before releasing the lease.** This is not a nicety.
Live-verified: taking the lease from an awake `sleep`-durability instance **drops its
unflushed writes**. Eviction is a lease handoff. An LRU evictor that forgets to flush is a
silent data-loss bug, not a performance bug.

Eviction protocol, in order, no steps skipped:

1. Stop accepting new connections for that database.
2. Drain or forcibly fail in-flight connections with a protocol-legal `ErrorResponse`
   (`57P01 admin_shutdown`).
3. `flush` and confirm it committed.
4. Release the lease.
5. Close the PGlite instance and free the memory.

If step 3 fails, **do not proceed**. Keep the database warm and evict a different one. Refusing
to evict is always better than losing writes.

**Split brain.** The router must be the only thing that decides where a database lives. If the
router holds a lease and something else wakes the same database elsewhere, the fence protects
correctness but you get takeover churn plus that write-loss path.

## 6. What already exists versus what is new

Existing, reuse rather than reinvent:

- `serveWire()` in `packages/client/src/wire.ts` - serves one datadir over TCP.
- `WireFrontend` in `packages/server/src/wire-frontend.ts` - already owns a public port, peeks
  the first 8 bytes, answers SSLRequest and GSSENCRequest, enforces a connection cap with a
  real `53300` ErrorResponse.
- The lease and fencing in `@zeropg/lease` - handoff and split-brain protection.
- `POST /flush` on `@zeropg/server` - the quiesce path.
- `POST /wake` and `/ready` - remote wake and readiness.
- The fleet CLI - already discovers live services and local datadirs.

New:

- **Startup-packet parser** and the name-to-placement router.
- **Warm-set manager**: capacity accounting, LRU, the eviction protocol in section 5.
- **WebSocket-to-wire bridge** in `@zeropg/server`, plus the client half in the router.
- **Placement policy**: a single function `where(databaseName) -> local | remote | cold`, so
  that the local-only build and the local-plus-remote build differ by one branch body.

## 6.5. The wire path needs a background timer. The HTTP path does not.

Load-bearing for anything that wants to host the router on freeze-between-requests compute
such as AWS Lambda.

- **Engine, HTTP `/sql`, `durability: 'strict'`**: genuinely zero CPU between requests. Lease
  renewal is on the request path (`packages/objectstore-fs/src/zeropg.ts:1275`, "E4 bet b: no
  background work"), WAL shipping happens inside `commit()`, and the engine's only
  `setInterval` is gated on `durability === 'interval'` (`zeropg.ts:470`).
- **Wire path**: `packages/server/src/server.ts:225-228` starts `wireFlushTimer` on a 5s
  interval **unconditionally, in every durability mode**. It exists because raw-wire writes
  hit PGlite directly and never pass through `ZeroPG.query()`/`exec()`, so they bypass the
  dirty flag and the durable commit that flag triggers. The timer watches Postgres' own
  row-modification counters and commits only when they advance.

**So the router, which is by definition a wire-path component, cannot run on compute that is
frozen between requests.** Writes arriving over the wire would never be flushed. That rules
out AWS Lambda as a router host, whatever it may be worth as a host for the HTTP face.

An always-on VM has no such problem, which is a further argument for the shape this spec
describes.

## 7. Non-goals

- **Not a connection pooler.** PGlite is one session per database; multiplexing more
  connections onto it does not add throughput.
- **Not multi-writer.** One lease per database, unchanged.
- **Not a query router.** No cross-database joins, no `postgres_fdw`-style federation. That
  was considered and parked: `postgres_fdw` holds a connection per remote per session, and a
  held connection to a scale-to-zero backend keeps it awake, which converts the fleet to
  always-on prices.
- **Not HA.** The router is a single point of failure for the warm tier. The bucket is the
  source of truth, so recovery is "start elsewhere" with an RTO of one cold start. Say this
  plainly rather than implying redundancy.

## 8. Build order

1. **Startup parsing plus routing, local placement only, warm set fixed at 1.** Proves the
   parser and gives a working single-database TCP endpoint.
2. **Warm set greater than 1, with the full eviction protocol** and a test that asserts writes
   survive an eviction under load. This is the step that can lose data if rushed.
3. **Cold-start holding**, per section 4.
4. **WebSocket bridge and remote placement.** Only now does the tiny-box configuration become
   useful on GCP.
5. **TLS and SCRAM**, only if a genuinely public port is the goal. On a private network or
   loopback these are theater. See the fork in
   [HANDOFF-2026-07-28-wire-auth.md](HANDOFF-2026-07-28-wire-auth.md).

Steps 1-3 are worth doing for the fat-box configuration alone, with no shim and no Cloud Run
involvement.

## 9. Open questions

- **Resident memory per idle PGlite instance.** The warm-set arithmetic in the table at the
  top is extrapolated from "a 500 MB database wants about 2 GiB comfortable", not measured per
  instance. Measure it before promising capacity. Tracked as E8 in
  [EXPERIMENTS-QUEUE.md](EXPERIMENTS-QUEUE.md).
- **Does the WebSocket tunnel keep a Cloud Run instance billable for its whole duration?** If
  an open tunnel counts as an active request, a long-lived client connection pins the instance
  awake and the economics collapse back to always-on. This decides whether option (1) in
  section 2 is viable at all. **Settle this before building the bridge.**
- **Whether a real Postgres could be the router**, giving a TCP endpoint plus federation in
  one box. Blocked on the same FDW connection-holding problem in section 7.
