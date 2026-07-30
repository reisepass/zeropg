# Running zeropg per cloud

What each platform can and cannot do, what it costs idle, and what you actually have to
configure. Every number here was measured on a real deployment; nothing is extrapolated from
vendor docs. Where something is untested it says so.

The one thing that varies most between platforms, and the thing most people do not expect:
**whether the platform can accept a raw inbound TCP connection, and whether it will HOLD that
connection while a stopped instance boots.** That single property decides whether you can hand
someone a `postgres://` URL at all.

| | inbound raw TCP | holds the connection while cold-starting | scale to zero | public `postgres://` |
|---|---|---|---|---|
| **Fly.io** | **yes** | **yes, measured** | yes | **yes** |
| Google Cloud Run | no | n/a | yes | no, needs a shim |
| Azure Container Apps | yes (VNet) | **untested** | yes | probably, unverified |
| AWS Lambda | no | n/a | yes | no |
| AWS ECS on Fargate | yes | n/a (no wake) | no | yes, but always-on |
| AWS App Runner | no | n/a | **no** | no |
| Always-on VM | yes | n/a (never cold) | no | **yes** |

---

## Fly.io - where zeropg *can* offer a real `postgres://`

**Wake-on-TCP is the enabling property.** But read
[COMPETITIVE-LANDSCAPE.md](COMPETITIVE-LANDSCAPE.md) first: raw TCP ingress is a *Fly* feature,
not a zeropg one, and Fly's own **Legacy (unmanaged) Postgres on a volume** gets it too, scales
to zero via `auto_stop_machines`, and has a real Postgres behind it - no 0.5GB ceiling, working
advisory locks, working `LISTEN`/`NOTIFY`, `sqlx` and Diesel fine. **For a single database on
Fly, use that instead of zeropg.**

What Fly's own numbers do establish is that the *managed* path is not competing for idle
workloads: **`fly mpg` starts at $38/month with no scale-to-zero and no public connection
string**. zeropg's case on Fly is fleet scale and disposability, not any one database.

Fly forwards a genuine public TCP port with no proxy layer in the path:

```toml
[[services]]
  internal_port = 5432
  protocol = "tcp"
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[services.ports]]
    port = 5432
    handlers = []          # empty handlers = raw TCP, no HTTP/TLS termination
```

### What "wake on TCP" actually means, measured

Point `psql` at a **stopped** Machine and the connection is **held, not refused**. The Fly
proxy accepts the TCP handshake in about **30ms**, then boots the VM behind the still-open
socket and splices you through when it is ready.

```
21:07:41 proxy: App has excess capacity, autostopping machine
               0 out of 1 machines left running
21:07:44 state: stopped
...
proxy: Starting machine
proxy: machine started in 1.37s
proxy: machine became reachable in 3.299s
```

Cloud Run cannot do this at any price. It is the whole difference.

**Connect-to-first-row, phase split.** Measured two ways, because client placement turns out
to dominate the warm number and not to touch the cold one ([E15](EXPERIMENTS-QUEUE.md#e15)):

```
                        TCP     SSL-neg    startup    query     TOTAL
  cold, from outside   30ms     ~10.5s      151ms     134ms    10.7-11.2s
  cold, in-region     6.3ms      12.2s       26ms      18ms    12.2s
  warm, from outside   29ms      249ms      134ms     134ms    0.55s
  warm, IN-REGION     8.1ms       17ms       11ms       3ms    0.038s
```

**The warm path is 38ms in-region.** Roughly 93% of the 0.55s figure is round-trip latency
from a transatlantic client, not server time. The cold path does not improve in-region at all,
which is the proof that it is server-side work.

**Where the ~11s cold path actually goes** (E15 phase table, on the guest-kernel axis):

```
   node exec -> first user code        2888ms    <- largest single phase
   PGlite create (WASM + postgres)     2092ms
   kernel -> node exec                 1165ms
   snapshot restore from Tigris        1391ms    <- the only phase that is data transfer
   lease + manifest                     557ms
   fork/exec child + ESM graph          590ms
   dial -> guest kernel boot            660ms
```

About 6.2s is runtime and container startup against ~1.4s of actual data transfer. The ~2.9s
of "Node startup" is **not** the interpreter, module loading or the app bundle - all three
measure 32-46ms on the same VM. It is first-touch paging of a 120 MB Node binary on a cold
Firecracker image. **A bigger Machine does not help** (`shared-cpu-4x` moved it by ~3%);
a smaller runtime image is the lever.

**libpq's default `sslmode` works with no query-string workaround:**

```
$ psql "postgres://postgres@<ip>:5432/postgres" -c "select version()"
 PostgreSQL 18.3 (PGlite 0.5.4) on wasm32-unknown-linux-gnu
```

No `?sslmode=disable`. This is the first zeropg deployment shape where that is true, because
`WireFrontend` answers `SSLRequest` with `N` and libpq falls back to plaintext.

**Durability across stop/start held** over 6 autostop cycles: a row written through the raw
wire before the first stop was present after every restart, with `fresh: false` and
`snapshotBytes: 5158807` each time.

**A stopped Machine bills only for its root volume**, not CPU or RAM.

### Two things you must handle before using this

**1. Bind the port before the restore, or you lose the race.** The Fly proxy waits about
**8.4 seconds** for your internal port to answer. `ZeroPGServer` currently binds 5432 only
*after* the PGlite restore completes, and the total lands either side of that budget
essentially at random:

```
                       raw wire probe        psql (libpq, default sslmode)
   before the fix      10.3s / 10.4s / drop  FAIL / FAIL / FAIL  (~10s each)
   after  the fix      10.57s/10.26s/10.30s  10.47s / 10.57s / 10.56s
```

The fix is to bind the public port in the process's first tick and park arriving clients
(buffering their bytes, answering nothing) until the wire is up. Proven in
`experiments/e11-fly-baseline/prebind.mjs`, which took the proxy's "became reachable" from
8.4s to 3.3s and turned 0/3 psql connections into 6/6.

> **Not yet in `@zeropg/server`.** The fix lives in `experiments/`. Until it is upstreamed,
> a Fly deployment is racy on cold start. This is the single blocker on calling Fly supported.

**2. `min_machines_running` is a floor, not a ceiling.** Two Machines can exist, and Fly's
proxy will load-balance across both. The lease protects the bucket correctly - the second
Machine blocked 25.6s on the lease, then took over, and the first was permanently fenced at
commit:

```
{"event":"wire-flush-failed","error":"writer fenced: lease with token 2 is no longer ours
 (manifest CAS failed at commit)"}
```

**But the client is not protected.** An `INSERT` sent to the fenced Machine returned
`{"rows":[{"id":35}],"rowCount":1}` - a success - and that row never reached the bucket. A
plain `psql` was routed to the loser by the proxy, so the phantom row was visible to a normal
client before vanishing. Under `durability: "sleep"` the acknowledgement precedes the commit
that gets fenced.

`--ha=false` on every deploy is necessary but **not sufficient**: nothing stops a later
`clone`, a rolling deploy, or an autoscale from creating a second. The correct fix is for a
fenced instance to close its wire listener and exit so the proxy stops routing to it. **Do not
run this shape in production until that lands.**

### 3. Do not reach for `auto_stop_machines = "suspend"`. It is fast, wrong, and short-lived

Suspend snapshots the Machine's RAM instead of cold-booting, so the PGlite instance is already
in memory on resume. It is by far the fastest thing measured anywhere in this project:

```
  cold  (stopped)   10.9s from outside     12.2s in-region
  RESUME            1.13s from outside     0.685s in-region     <- 16x
  warm              0.55s from outside     0.038s in-region
```

Verified as a genuine resume rather than a quick cold boot: the original process survives with
its boot stamps intact, and the guest observes a wall-clock freeze.

**Two independent reasons not to use it** ([E15](EXPERIMENTS-QUEUE.md#e15)):

**It serves stale data.** The lease TTL is 60s and lives in the bucket with a wall-clock
expiry. A frozen guest renews nothing, so **any suspend longer than a minute leaves the lease
takeable**. Take it from elsewhere, commit a row, then resume the Machine, and a normal `psql`
gets:

```
1|row-before-suspend            <- STALE. The bucket holds two rows.
```

It also **accepts writes** into the database it no longer owns, and `validateLease()` reports
`ok: true` on the fenced instance, because the real holder's clean release deleted
`lease.json` and the zombie re-created it at its original fencing token. Two writers at the
same token left the bucket **unreadable** - the manifest referenced a WAL segment that does
not exist. E11's "the bucket cannot be corrupted by a second Machine" does not extend here.

**And the snapshot decays in about two minutes anyway.** Polled with zero client traffic, a
`suspended` Machine leaves that state on its own - sometimes to `started`, which bills CPU and
RAM for a database nobody is using, and sometimes to `stopped`, which costs the next client the
full ~11s. Fly documents the snapshot as explicitly not guaranteed to persist and gives no way
to configure the timing.

**A workload idle for two minutes is not what scale-to-zero is for.** Even with the lease bugs
fixed, suspend would deliver its 685ms only on traffic that barely goes idle. **Stay on
`auto_stop_machines = "stop"`.**

---

## Google Cloud Run - HTTP only, and that shapes everything

**Cloud Run accepts no inbound raw TCP.** HTTP/1.1, HTTP/2, gRPC and WebSockets only. Nearly
every constraint elsewhere in zeropg's design descends from this: loopback-only wire,
co-located app and database, `sslmode=disable` in older recipes.

### The shape that works: co-location

Containers in one Cloud Run instance share a network namespace, so the app reaches the database
over `127.0.0.1` on any port. This is the recommended and best-tested topology.

```yaml
metadata:
  annotations:
    autoscaling.knative.dev/maxScale: "1"        # single writer on the bucket datadir
    autoscaling.knative.dev/minScale: "0"        # scale to zero
    run.googleapis.com/cpu-throttling: "false"   # the wire flush timer needs CPU while warm
    run.googleapis.com/startup-cpu-boost: "true"
    run.googleapis.com/container-dependencies: '{"auth":["db"]}'
```

Three of those are load-bearing:

- **`maxScale: "1"`** is a correctness constraint, not a cost one. Two instances fight over the
  lease.
- **`cpu-throttling: "false"`** because raw-wire writes bypass `ZeroPG.query()`/`exec()` and are
  only committed by a 5-second background timer. Throttle the CPU and that timer does not run.
- **`container-dependencies`** so the app does not start before the database.

You do not need a separate container at all. zeropg is a Node library and runs in-process, or as
a second process in the same container.

**Cold start** is roughly 3.5-5s for small databases, about 11s at 500 MB.

### Serving instantly while the database restores

Cloud Run's ingress container can bind and serve immediately while the database restores behind
it. The Supabase example does this deliberately: `app` does **not** depend on `db`, so it serves
its shell instantly and `/rest` returns 503 until the backend is ready.

### If you want a public `postgres://` here

You need a shim: a small always-on box that terminates TCP and tunnels to Cloud Run over
WebSocket. Two measured constraints shape it:

- **Never hold the tunnel open idle.** A held WebSocket pins the instance awake and billable at
  exactly **1:1** - a 301-second idle connection carrying zero bytes billed 301.9 seconds, with
  full CPU throughout. Roughly $52/month per connected database.
- **Open it per query burst instead, and it is warm, free and fast.** Measured across gaps of
  5s, 30s, 60s, 300s and 900s: reopen time-to-first-byte **93-117ms**, the same instance every
  time, **no billing during any gap**. CPU throttles between bursts but the instance stays
  resident, so there is no cold start to pay.

Also: the request timeout hard-caps any tunnelled connection at **3600 seconds**, enforced at
the API, after which the client is disconnected with close code 1006.

See [SPEC-wire-router.md](SPEC-wire-router.md). **Not built yet.**

---

## Azure Container Apps - promising, untested

Azure has both properties Cloud Run lacks: **external TCP ingress** (VNet environment required)
and a **KEDA TCP scale rule that scales in to zero**. On paper it is the closest thing to Fly.

**The deciding question is unmeasured:** does its TCP ingress *hold* a connection while a
replica starts from zero, or drop it? If it holds, Azure joins Fly as a first-class target. If
it drops, cold connections simply fail and no amount of work on our side helps, because the
platform kills the connection before our code sees it.

Tracked as E1 in [EXPERIMENTS-QUEUE.md](EXPERIMENTS-QUEUE.md). Also note Container Apps has
`initContainers` but **no ordering between sidecars**, and a 300s cool-down before scaling to
zero.

---

## AWS

**Lambda** is the only AWS product that both scales to genuine zero and wakes on a request. It
works for the HTTP `/sql` face: with `durability: 'strict'` zeropg needs no CPU between requests
at all, because lease renewal is on the request path and WAL shipping happens inside `commit()`.

**But it cannot host the wire.** Raw-wire writes are committed only by a 5-second background
timer, and Lambda freezes the execution environment between invocations, so those writes would
never flush. Also: reserved concurrency 1 is **not** a writer fence (it bounds in-flight
requests, not environments), and container-image functions go Inactive after weeks idle and
reject the first invocation, so a weekly ping is mandatory.

**ECS on Fargate** ports the container shape cleanly - 10 containers per task, `awsvpc`
localhost, and `dependsOn: HEALTHY` is richer than Cloud Run's annotation. But there is **no
request-driven scale-from-zero**, so the first request after idle *fails* rather than waits. You
would write the wake path yourself.

**App Runner is out.** It closed to new customers on 2026-03-31, and `MinSize` has a documented
minimum of 1, so it never scaled to zero. It also doubles instances on every deploy, which is a
guaranteed two-writer window.

---

## An always-on VM - underrated

No cold starts, real TCP, no platform quirks. The datadir still lives in the bucket, so the VM
stays disposable: blow it away and restore anywhere in seconds. You give up scale-to-zero and
keep everything else.

**Sizing is per instance, not per byte.** Resident memory is roughly constant regardless of
database size: about 400 MB at a 7.7 MB database, 420-440 MB at 509 MB. So:

| RAM | databases held warm |
|---|---|
| 1 GiB | 1, tight |
| 2 GiB | 3-4 |
| 8 GiB | 16-18 |

A `t4g.nano` cannot run zeropg at all.

**The economics cross over early.** Against Cloud Run at roughly 200 sessions a month per
database, a VM wins from about the second or third database and does not lose again, because
Cloud Run pays a 15-minute idle tail per database per session while the VM's cost is flat. For
1-10 databases this is probably the best shape available, and it is not the one the README
leads with.

---

## Choosing

- **App talks to its own database** - co-locate, any platform. Simplest, best tested.
- **You want a public `postgres://`** - Fly.io, once the bind-early fix lands.
- **Many small databases, mostly idle** - one always-on VM, or the router in
  [SPEC-wire-router.md](SPEC-wire-router.md).
- **You are on Cloud Run and want `postgres://`** - you need the shim, and it is not built.
- **You need real concurrency, more than ~0.5 GB, or Rust `sqlx`/Diesel** - use managed
  Postgres. See [LIMITATIONS.md](LIMITATIONS.md) and [GRADUATION.md](GRADUATION.md).
