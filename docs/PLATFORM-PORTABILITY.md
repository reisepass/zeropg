# Platform portability: what zeropg actually needs from Cloud Run, and who else has it

Status: **research / planning only.** Nothing here has been deployed or measured
by us except where it explicitly cites our own results. Every vendor claim is
tagged **VERIFIED** (fetched from the vendor doc named, on 2026-07-28) or
**INFERRED** (reasoned from adjacent documented behaviour, not stated outright).
Vendor docs move; re-check before acting.

Companion docs: [PLATFORM-CANDIDATES.md](PLATFORM-CANDIDATES.md) (Render and Fly
cost notes), [COLDSTART-MODEL.md](COLDSTART-MODEL.md) (our measured cold starts),
[../BREAK-EVEN.md](../BREAK-EVEN.md) (per-cloud cost crossovers),
[CONNECTION-SECURITY-AND-WIRE.md](CONNECTION-SECURITY-AND-WIRE.md).

## 0. The deployment shape we are trying to port

The reference is the live stripped-Supabase service,
[`../examples/cloudrun/supabase/service.yaml`](../examples/cloudrun/supabase/service.yaml):
three containers in one scheduling unit.

| container | role | listens |
|---|---|---|
| `app` | ingress: frontend + Kong-style reverse proxy | Cloud Run's injected `PORT` (8080), the only externally reachable port |
| `auth` | GoTrue | `127.0.0.1:9999`, internal only |
| `db` | zeropg: PGlite behind the Postgres wire protocol, GCS-backed | `127.0.0.1:5432` (wire) and `127.0.0.1:8081` (control/health), internal only |

The load-bearing annotations:

```yaml
autoscaling.knative.dev/maxScale: "1"          # correctness: one writer on the bucket
autoscaling.knative.dev/minScale: "0"          # scale to zero
run.googleapis.com/startup-cpu-boost: "true"
run.googleapis.com/cpu-throttling: "false"     # background timers run while warm
run.googleapis.com/container-dependencies: '{"auth":["db"]}'
```

`maxScale: "1"` is not a cost knob. Two instances would both take the
conditional-write lease and fight over the single-writer datadir. Any platform
that cannot hard-cap concurrency at one instance is not a candidate unless the
lease is trusted to be the only guard (it is designed to be, but the cap is the
belt to the lease's braces, and losing it is a real change in the safety story).

---

## 1. Comparison table

Legend: **Y** = yes, documented. **P** = partial / conditional. **N** = no.

| # | Requirement | Cloud Run (reference) | ECS on Fargate | AWS App Runner | Azure Container Apps | Fly.io Machines |
|---|---|---|---|---|---|---|
| 1 | Multiple containers in one scheduling unit, reachable over `127.0.0.1:<port>` | **Y** up to 10 per instance incl. ingress | **Y** up to 10 per task definition, `awsvpc` gives the task one ENI shared by all containers | **N** no sidecars at all | **Y** sidecars in `properties.template.containers[]`, shared network and disk | **Y** multi-container Machines, `containers[]`, docs show reaching Redis at `localhost:6379` |
| 2 | Exactly one container receives external ingress | **Y** the container with `ports.containerPort` | **P** you choose which container the load balancer targets; nothing stops another container binding a public port on the shared ENI | n/a | **P** `ingress.targetPort` picks one port; no first-class "ingress container" concept | **P** `[[services]] internal_port` picks one port |
| 3 | Container startup ordering | **Y** `run.googleapis.com/container-dependencies` | **Y** `dependsOn` with `START` / `COMPLETE` / `SUCCESS` / `HEALTHY` | n/a | **P** `initContainers[]` run to completion before app containers; **no ordering between sidecars** | **Y** `depends_on` with `started` / `healthy` / `exited_successfully` |
| 4 | Genuine scale to zero, wake on request | **Y** `minScale: 0` | **N** no native request-driven scale-from-zero; needs external glue | **P** scales compute to zero but bills provisioned memory while idle | **Y** `minReplicas: 0` with an HTTP **or TCP** scale rule | **Y** `auto_stop_machines` + `auto_start_machines`, `min_machines_running = 0` |
| 5 | Hard cap of exactly one instance | **Y** `maxScale: "1"` | **Y** `desiredCount: 1` with no autoscaling policy | **P** min/max size settings exist but the product is built to scale out | **Y** `maxReplicas: 1` | **P** deploy exactly one Machine in the process group; `min_machines_running` is a floor not a ceiling |
| 6 | CPU allocated outside request handling | **Y** `cpu-throttling: "false"` | **Y** always, it is a microVM | n/a | **Y (INFERRED)** no throttling concept in the docs; the idle-billing rule keys on "using less than 0.01 vCPU cores", which presumes the container may use CPU with no request in flight | **Y** always, it is a microVM |
| 7 | Startup CPU boost | **Y** `startup-cpu-boost` | **N** no equivalent; you buy the vCPU for the task's whole life | **N** | **N** no documented equivalent | **N** no documented equivalent |
| 8 | Startup probe per container | **Y** `startupProbe` per container | **Y** per-container `healthCheck` with `startPeriod`, consumed by `dependsOn: HEALTHY` | **P** one service-level health check | **Y** per-container `probes[]` with `"type": "startup"` | **Y** per-container health checks feeding `depends_on` |
| 9a | Inbound **raw TCP** from the public internet | **N** | **Y** NLB on any TCP port, or a public IP on the task ENI | **N** HTTP only | **Y** external TCP ingress, **VNet environment required** | **Y** `[[services.ports]] port = 5432, handlers = []` |
| 9b | Inbound raw TCP from inside a VPC | **N** entry is always the HTTPS front end | **Y** the task has a real ENI with a private IP | **N** | **Y** internal TCP ingress within the environment | **Y** over 6PN / WireGuard |
| 9c | Outbound raw TCP from the container | **Y** Direct VPC egress / VPC Access connector | **Y** | **Y** VPC connector | **Y** | **Y** |
| 10 | Writable in-memory FS sized for a ~0.5 GB datadir | **Y** whole writable FS is tmpfs, counts against the memory limit; sized in-memory volumes also available | **P** `ephemeralStorage` is 20 GiB **disk**, not RAM; `linuxParameters.tmpfs` exists in the API but the Fargate parameter list does not accept it (**INFERRED**: the Fargate-hosted parameter doc omits the Fargate-supported note that its siblings carry, and `sharedMemorySize` is explicitly unsupported) | n/a | **P** `EmptyDir` ephemeral storage per replica; sizing tied to the CPU/memory combination table | **P** rootfs is a real disk in the microVM; use a tmpfs mount inside the container if you want RAM |
| 11 | Documented / measured cold start | **~2s platform floor** (our measurement) + restore | **20-60s** typical task launch (third-party) | seconds, undocumented | undocumented; KEDA polls every 30s for non-HTTP rules, HTTP/TCP rules are proxy-driven | sub-second to seconds; "suspend" faster than "stop" |
| 12 | Idle-but-warm billed? Idle timeout? | billed while warm unless `cpu-throttling: true`; ~15 min idle before teardown (our measurement) | **billed continuously**, there is no idle state | billed for provisioned memory when idle | **reduced idle rate**, only when `minReplicas > 0`; **zero** when scaled to zero. Cool-down before scaling to zero is 300s | **zero** CPU/RAM while stopped or suspended; proxy stop loop runs every few minutes |

Sources for the table are cited per-platform below.

---

## 2. Google Cloud Run (the reference)

VERIFIED, https://docs.cloud.google.com/run/docs/deploying and
https://docs.cloud.google.com/run/docs/container-contract:

- "You can deploy up to 10 containers per instance including the ingress container."
- Exactly one ingress container; it "must listen for requests on `0.0.0.0` on the
  port to which requests are sent" and must not bind `127.0.0.1`. Sidecars are
  reached over localhost, and Cloud Run "maps the service names to the localhost
  IP address (`127.0.0.1`)" via `/etc/hosts`.
- The writable filesystem "is an in-memory file system, so writing to it uses the
  instance's memory", and does not persist across instance stop. This is exactly
  how the PGlite datadir lives inside the memory limit today.
- Startup order is configured through container dependencies and requires health
  checks on the depended-upon container.

Not verified from a doc page but proven by the running service: the exact
annotation spellings in `service.yaml` above, including
`run.googleapis.com/container-dependencies: '{"auth":["db"]}'`.

**The one thing Cloud Run cannot do: accept inbound raw TCP.** Not from the
internet, and not from a VPC either. Everything enters through the HTTPS front
end. That is the single constraint that shapes the entire rest of this document,
because a database's native interface is a raw TCP port. Today zeropg works
around it by co-locating the app with the db in the same instance, so the wire
protocol never leaves `127.0.0.1`. Combined with the fact that
`serveWire` never answers `SSLRequest` (see the
[CONNECTION-SECURITY-AND-WIRE.md](CONNECTION-SECURITY-AND-WIRE.md) discussion),
the loopback confinement is currently load-bearing for security as well as for
connectivity.

---

## 3. AWS: ECS on Fargate

### What clears the bar

**VERIFIED**, https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html:

- `networkMode` must be `awsvpc` for Fargate. All containers in the task share
  the task ENI, so `127.0.0.1:5432` between containers works exactly as on Cloud
  Run. The doc's own health-check example uses `curl -f http://localhost/`.
- With `awsvpc`, "you use `containerPort` to specify the port"; `hostPort` must
  equal `containerPort` or be omitted.
- `dependsOn` is a first-class array of `{ "containerName": ..., "condition": ... }`:
  - `START`: dependent container has started.
  - `COMPLETE`: dependent container has exited (cannot be set on an essential container).
  - `SUCCESS`: exited with status zero (cannot be set on an essential container).
  - `HEALTHY`: dependent container passed its `healthCheck`. "This condition is
    confirmed only at task startup." Requires a `healthCheck` on that container.
  This is a strictly richer version of the Cloud Run annotation. Our
  `{"auth":["db"]}` becomes `"dependsOn": [{"containerName": "db", "condition": "HEALTHY"}]`
  on the `auth` container.
- Per-container `healthCheck` with `command`, `interval`, `timeout`, `retries`,
  `startPeriod`. `startPeriod` is the analogue of a startup probe's
  `failureThreshold` window: our current `periodSeconds: 3, failureThreshold: 40`
  becomes roughly `interval: 3, retries: 3, startPeriod: 120`.

**VERIFIED**, https://docs.aws.amazon.com/general/latest/gr/ecs-service.html:

- "Containers per task definition: Each supported Region: 10". Same ceiling as
  Cloud Run, and we use three.
- Task definition size 64 KiB.
- Note the default **Fargate On-Demand vCPU resource count: 6** per region on new
  accounts. A fleet of one-vCPU-plus-two-vCPU tasks hits that fast; it is
  adjustable but it is a real gate on a fleet demo.

### What does not clear the bar

**Scale to zero (#4) is the hard one.** Fargate has no request-driven
scale-from-zero. `desiredCount: 0` genuinely runs nothing and costs nothing, but
nothing wakes it: there is no component that holds an inbound connection while a
task boots. This is a long-standing gap tracked at
https://github.com/aws/containers-roadmap/issues/1017 (VERIFIED: the issue
exists and is titled "[ECS] [Fargate]: can ecs fargate tasks scale to zero ?").

What people actually do, in rough order of how well it fits zeropg:

1. **ALB + Lambda waker + retry/hold page.** ALB target group is empty when
   desiredCount is 0, so the ALB returns 503. A 503-triggered path (CloudFront
   function, or a Lambda subscribed to the ALB's `HTTPCode_ELB_503_Count` alarm,
   or a Lambda behind a second ALB rule) calls
   `ecs:UpdateService --desired-count 1`, and the client is told to retry. The
   client sees a failure or a loading page for the 20-60s the task takes to
   start. AWS's own published version of this pattern is the CI/CD scale-to-zero
   post, https://aws.amazon.com/blogs/containers/ci-cd-pipeline-for-testing-containers-on-aws-fargate-with-scaling-to-zero/
   (VERIFIED that the post exists and describes Lambda scaling tasks up and back
   to zero; it is a CI pattern, not a user-facing request-hold pattern).
2. **CloudFront in front, Lambda@Edge / CloudFront Function as the waker.** Same
   idea, the edge absorbs the wait. Documented by third parties, e.g.
   https://medium.com/qest/ecs-scale-to-zero-using-cloudfront-8b7dcb61b59b
   (third party, not vendor).
3. **Scheduled scaling.** Application Auto Scaling scheduled actions set min/max
   capacity on a cron. Fine for "office hours", useless for a hobby app that
   wakes on a visitor.
4. **EventBridge on a queue depth / API Gateway request**, with the caller
   polling. Same shape as 1.

None of these hold the connection. **This is the single biggest functional gap
between Cloud Run and Fargate for zeropg**: Cloud Run's wake is invisible to the
client, Fargate's wake is a visible failure plus a retry. Our measured
`~3.5-5s` Go-tier cold starts become "503, come back in a minute" unless we
write the hold-and-retry layer ourselves.

**Startup CPU boost (#7)** has no equivalent. On Fargate you buy the task's vCPU
for its entire life. Our own note in [../BREAK-EVEN.md](../BREAK-EVEN.md) is that
0.25 vCPU makes restores roughly 4x slower than the 1 vCPU E3 numbers, so the
cheap-task option and the fast-cold-start option are the same dial on Fargate,
where on Cloud Run boost decouples them.

**tmpfs (#10) is the subtle one.** Fargate gives you `ephemeralStorage`
(20 GiB by default, expandable, platform version 1.4.0 or later) but that is
**disk, not RAM**. The `linuxParameters.tmpfs` structure exists in the ECS API,
but the Fargate task-definition parameter reference documents
`sharedMemorySize` as explicitly unsupported on Fargate and does not carry a
Fargate-supported note for `tmpfs` (INFERRED: `tmpfs` is not usable on Fargate;
this is the widely-repeated community understanding and it should be confirmed
by an actual `RegisterTaskDefinition` call before anyone plans around it).

Practically this is fine and possibly better: on Fargate we would let the PGlite
datadir land on the task's ephemeral disk rather than in RAM, which decouples
DB size from the memory tier. It is a genuine behaviour change from Cloud Run
(where datadir bytes are memory bytes) and it changes the memory-tier table in
BREAK-EVEN.md in our favour. Worth measuring: ephemeral disk is EBS-backed and
slower than RAM, so restore and page-fault behaviour will differ.

**Cold start (#11).** Third-party measurements put an unoptimised Fargate task
launch at 20-60 seconds (https://aws.plainenglish.io/taming-cold-starts-on-aws-fargate-the-architecture-behind-sub-5-second-task-launches
and similar; third party, not vendor). Seekable OCI (SOCI) lazy image loading is
the documented mitigation. Add our restore on top. So the realistic Fargate cold
start for a Go-tier zeropg app is **20-60s**, versus 3.5-5s on Cloud Run, and the
gap is entirely platform, not us.

**Billing (#12).** There is no idle state. A running task is billed at the full
vCPU and GB rate for every second it exists. The whole scale-to-zero economics
therefore rest on the waker actually scaling back down, which is a timer you
have to write. See [../BREAK-EVEN.md](../BREAK-EVEN.md) §4: the smallest Fargate
task running 24/7 is still cheaper than the smallest RDS, so on AWS the cost
argument for scaling to zero is weak anyway; the argument is operational.

### AWS App Runner

**App Runner is out.** It is the closest Cloud Run analogue in shape (managed
HTTPS, scale down when idle, no cluster) but it **does not support multiple
containers per service at all**. The feature request is
https://github.com/aws/apprunner-roadmap/issues/71, "Allow container side-cars
AKA multiple containers per service", still open (VERIFIED that the issue exists
and is open).

Consequences for zeropg:

- Requirement #1 fails outright. The only way to run on App Runner is to bake
  app + db into a single image with a process supervisor, which is a real option
  (and the one Render free would force too) but it is a packaging fork, not a
  port.
- App Runner also bills provisioned memory while idle (roughly $0.007/GB-hr,
  per [../BREAK-EVEN.md](../BREAK-EVEN.md) §4), so "scale to zero" is really
  "scale compute to zero, keep paying rent on the RAM". At 2 GiB that is about
  $10/month of floor for a database that is asleep.
- No raw TCP ingress either.

Verdict: not a target.

---

## 4. Azure Container Apps

This is the surprise of the exercise. **Azure clears bars that Cloud Run does
not.**

**VERIFIED**, https://learn.microsoft.com/en-us/azure/container-apps/containers:

- "In advanced scenarios, you can run multiple containers in a single container
  app." Sidecars go in `properties.template.containers[]`; init containers go in
  `properties.template.initContainers[]`.
- "Multiple containers in the same container app share hard disk and network
  resources and experience the same application lifecycle." Localhost between
  containers therefore works.
- Init containers "run in the order they're defined in the array and must
  complete successfully before the primary app container starts." That is a
  run-to-completion ordering primitive, **not** the "start db, wait for it to be
  healthy, then start auth, and keep db running" shape we use. There is no
  documented `dependsOn` between sidecars.
- Per-container `probes[]` supports `"type": "liveness" | "readiness" | "startup"`,
  with `httpGet` / `tcpSocket`, `initialDelaySeconds`, `periodSeconds`. Our
  `db` startupProbe ports over cleanly.
- Consumption plan CPU and memory come from a fixed combination table
  (0.25 vCPU / 0.5 GiB through 4.0 vCPU / 8.0 GiB, in 0.25 vCPU steps), and
  **the total across all containers in the app must add up to one of the
  combinations**. Our current Cloud Run allocation is 1 + 1 + 2 = 4 vCPU and
  0.25 + 0.25 + 2 = 2.5 GiB, which is not a valid Azure pair; it would have to
  be re-cut (e.g. 2.0 vCPU / 4.0 GiB total, split across the three containers).
- Consumption-only environments cap at 2 cores and 4 GiB.
- Image size cap: 8 GB total per replica on Consumption.

**VERIFIED**, https://learn.microsoft.com/en-us/azure/container-apps/scale-app:

- `minReplicas` default 0, min 0. `maxReplicas` min 1. So `minReplicas: 0,
  maxReplicas: 1` is exactly our `minScale: 0, maxScale: 1`.
- "You aren't billed usage charges if your container app scales to zero."
- **There is a TCP scale rule.** `"tcp": { "metadata": { "concurrentConnections": "100" } }`,
  or `--scale-rule-type tcp --scale-rule-tcp-concurrency 100` on the CLI. The
  doc's own example says the revision "scales out to as many as five replicas and
  can scale in to zero", using `--transport tcp --ingress <external/internal>`.
- Cool down period is 300s and "only takes effect when scaling in from the final
  replica to 0".
- Warning worth internalising: "if ingress is disabled and you don't define a
  `minReplicas` or a custom scale rule, your container app scales to zero and has
  no way of starting back up."

**VERIFIED**, https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview:

- TCP ingress exists as a first-class protocol alongside HTTP. "Container Apps
  supports TCP-based protocols other than HTTP or HTTPS."
- **"External TCP ingress is only supported for Container Apps environments that
  use a virtual network."** Internal TCP ingress works without one.
- Up to five additional TCP ports per app beyond the main one. Externally exposed
  extra ports must be unique across the whole environment. Port `36985` is
  reserved.
- HTTP ingress request timeout is 240 seconds.

**VERIFIED**, https://learn.microsoft.com/en-us/azure/container-apps/billing:
zero charge at zero replicas; a reduced *idle* rate applies only when
`minReplicas > 0` and the replica is at the minimum, has all containers started,
is serving no HTTP requests, is under 0.01 vCPU, and is under 1000 bytes/sec of
network. Free monthly grant per subscription: 180,000 vCPU-seconds,
360,000 GiB-seconds, 2 million HTTP requests.

### What this means

**Azure Container Apps can expose the Postgres wire protocol on a real public TCP
port and still scale to zero, waking on an inbound TCP connection.** That is the
headline portability finding of this document, and it is a capability the
current Cloud Run deployment does not have and cannot have. It would turn zeropg
from "a database that only your co-located app can reach" into "a database with a
`postgres://` URL you can paste into psql, that costs nothing when nobody is
connected".

Caveats, all of which need a real deployment to settle:

1. **Does the TCP ingress hold the connection during a cold start, or drop it?**
   (INFERRED, unresolved.) The HTTP path clearly holds (240s timeout). For TCP,
   the docs describe the scale rule but not the connection-hold semantics from
   zero. If it drops, a client sees a connection reset and must retry, which is
   Fargate-class behaviour with extra steps. This is the single question that
   decides whether Azure is a headline target or a footnote, and it is cheap to
   test: one container, `--transport tcp`, `--min-replicas 0`, `psql` at it.
2. **Cold start must fit inside the client's connect timeout.** libpq's default
   `connect_timeout` is unlimited, so a hold would work, but pooled clients
   (pgx, node-postgres) usually set 5-30s. Our Go-tier 3.5-5s restore plus
   Azure's replica start is plausibly inside that; a Next.js app is not.
3. **No `cpu-throttling` equivalent needed** (INFERRED): there is no documented
   request-scoped throttling, and the idle-billing definition presumes a running
   replica can consume CPU with no request in flight, so the WAL-ship and
   lease-renewal timers should just run. Verify by watching a flush happen with
   no traffic.
4. **No startup CPU boost.** Restore runs at whatever vCPU the combination table
   gave you.
5. **No sidecar ordering.** Our `{"auth":["db"]}` dependency has no direct
   translation. Workarounds: (a) an init container that blocks until the bucket
   is reachable, then let `auth` retry its DB connection with backoff, which is
   what a robust `auth` should do anyway; (b) fold the readiness wait into the
   `auth` entrypoint, which the current image already does via `ZEROPG_DB_HOST` /
   `ZEROPG_DB_PORT` probing. **(b) is already implemented**, so this gap costs us
   approximately nothing.
6. **External TCP needs a VNet environment**, which is more Azure surface area
   (and, per the billing note, VNet usage can carry additional charges).
7. **Storage backend**: Azure Blob supports `If-Match` / `If-None-Match` etag
   preconditions, which is the conditional-write primitive the lease needs. See
   [../BREAK-EVEN.md](../BREAK-EVEN.md) §5. `@zeropg/blobstore` would need an
   Azure Blob driver; today it has GCS, S3, R2, and filesystem.

---

## 5. Fly.io

### Multi-process vs multi-container: they are different things

**VERIFIED**, https://fly.io/docs/reference/configuration/: the `[processes]`
section defines *process groups*, and each group runs on its **own Machines**.
Process groups get their own `[[services]]`, `[[vm]]`, `[[mounts]]`. This is
Fly's answer to "web + worker", and it is **not** what we need: two process
groups do not share a network namespace, they are separate microVMs that talk
over Fly's private 6PN network, not over `127.0.0.1`.

**VERIFIED**, https://fly.io/docs/machines/guides-examples/multi-container-machines/:
Fly does now have real multi-container Machines.

- Configured via a `containers` array: `{"config": {"containers": [...]}}` on the
  Machines API, a bare `containers` array in a JSON file for `fly machine run`,
  or from `fly.toml` via `[experimental] machine_config = 'cli-config.json'` or
  an inline triple-quoted `machine_config = '''{ "containers": [...] }'''`.
  There is also a `[build.compose]` path that consumes a Docker Compose file.
- **Containers in one Machine share the network.** The docs' Compose example
  states application code reaches Redis at `localhost:6379`.
- **`depends_on` exists** with conditions `"healthy"`, `"started"`,
  `"exited_successfully"`. Fly's init ("Pilot") "models these dependencies as a
  directed graph and walks it to orchestrate the correct container startup
  order." This is a direct, and better, replacement for
  `run.googleapis.com/container-dependencies`.
- No documented per-Machine container limit.
- Requires flyctl v0.3.147 or later for `fly deploy` support. The feature reads
  as **preview/experimental**, not GA. That is a real risk for anything we would
  tell users to run.

### Raw TCP: yes, genuinely

**VERIFIED**, https://fly.io/docs/reference/configuration/: `[[services]]` takes
`internal_port` and `protocol = "tcp"`, and `[[services.ports]]` with
`handlers = []` is documented as raw TCP with no HTTP processing. So:

```toml
[[services]]
  internal_port = 5432
  protocol = "tcp"
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[services.ports]]
    port = 5432
    handlers = []
```

Fly forwards a real public TCP port. Like Azure, this gives zeropg a genuine
`postgres://` URL. Unlike Azure it needs no VNet, and unlike Azure the wake path
for TCP is the same Fly Proxy path as everything else.

### Scale to zero

**VERIFIED**, https://fly.io/docs/launch/autostop-autostart/:

- `auto_stop_machines` takes `"off"` (or `false`), `"stop"` (or `true`), or
  `"suspend"`. Suspend restarts faster than stop.
- `auto_start_machines` defaults to true: the proxy starts Machines on request.
- `min_machines_running = 0` gives true zero. It only applies to the primary
  region, and it requires `auto_stop_machines` to be `"stop"` or `"suspend"`.
- "The Fly Proxy's stop loop runs every few minutes and stops at most one machine
  per region per pass", and machines stop "after several minutes" of idleness.
  No precise idle timeout is documented.
- Stopped or suspended Machines are **not billed for CPU and RAM**. (The page
  does not address rootfs or volume storage; volumes bill while stopped, which is
  why [PLATFORM-CANDIDATES.md](PLATFORM-CANDIDATES.md) says skip volumes and let
  the bucket be the disk.)
- The autostop/autostart doc is written around HTTP and **does not explicitly
  state that it applies to raw TCP services** (INFERRED: it does, because the
  mechanism is Fly Proxy connection handling and `[[services]]` is the same
  config object for both; but this is exactly the "does the proxy hold the TCP
  connection through the boot" question again, and it must be tested).

### The one-instance cap

Fly has no `maxScale`. You control instance count by how many Machines exist in
the process group. `min_machines_running` is a floor, not a ceiling. So "exactly
one" is achieved by deploying exactly one Machine and not running
`fly scale count`. That is weaker than `maxScale: "1"`: nothing in the platform
prevents a second Machine from existing, so the lease becomes the only guard.
Also relevant: Fly migrates Machines between hosts for maintenance, which is a
second-writer window of the class our fencing is designed for but which we have
never exercised (open question 3 in
[PLATFORM-CANDIDATES.md](PLATFORM-CANDIDATES.md)).

### Filesystem

The Machine has a real rootfs on a real disk inside the microVM, so the datadir
does not have to live in RAM. If we want the current RAM behaviour, mount a
tmpfs inside the container. Either way, DB size decouples from the memory tier,
same as on Fargate.

---

## 6. The rest, briefly

Judged against bars **1** (localhost multi-container), **4** (scale to zero),
**5** (hard cap of one), **6** (CPU while warm).

**Railway.** Scale to zero: yes, "serverless" sleeps a service after roughly 10
minutes with no traffic and charges no compute while asleep (third-party
summaries and Railway's own marketing; the public-networking doc we fetched
covers only HTTP, so the sleep semantics are **not vendor-verified here**).
Multi-container in one scheduling unit: **no** as far as we can tell, Railway's
unit is a service and services talk over a private network, not localhost, so
bar 1 fails and the multi-container shape becomes one-image-with-supervisor.
Hard cap of one: replicas are a per-service integer, so yes. CPU while warm: yes,
it is a normal container. Railway does have a TCP proxy feature for raw TCP,
which we did not verify from the doc. Overall: plausible for the db-only shape,
unverified, and the sleep-vs-wake behaviour ("your services will keep themselves
awake without you realising") is a known sharp edge.

**Render.** Bar 1 fails: one container per service, no sidecars. Bar 4 is free
tier only, with a spin-down after 15 idle minutes and a **roughly one-minute**
wake behind a Render-branded loading page, which is Heroku-free-dyno class rather
than Cloud Run class. There is no pay-per-awake-second paid tier, so the paid
path is a flat always-on instance and the scale-to-zero story simply ends. Bar 5
is fine, bar 6 is fine. Free tier is 512 MB / 0.1 vCPU, and 0.1 vCPU will inflate
restore several-fold. See [PLATFORM-CANDIDATES.md](PLATFORM-CANDIDATES.md) for
the fuller writeup. Verdict: viable as a zero-dollar db-only demo, not as a
serious target.

**Koyeb.** Bar 4 is the best in class: **VERIFIED**,
https://www.koyeb.com/docs/run-and-scale/scale-to-zero, deep sleep gives "a cold
start time of 1-5 seconds", and *light sleep* uses snapshotting for "a 200 ms
start time". Idle period defaults to 5 minutes, configurable up to 6 hours on
Standard/Pro. Caveats from the same page: scale-to-zero "works only for Services
exposed to the Internet", and "HTTP/2 requests cannot be used to wake up a
sleeping Service" (WebSocket can). Bar 1: not documented as supported, Koyeb's
unit is a service with one container, so assume **no**. Bars 5 and 6: fine.
Light sleep is genuinely interesting for us because a snapshot-resume skips both
the container boot *and* potentially the restore, but it presumes the process
state is resumable, and our restore-from-bucket plus lease-takeover on wake would
need to be re-validated against a resumed process holding a stale lease. That is
a correctness question, not a performance one.

**Knative / self-hosted Kubernetes.** All four bars clear, because this is where
the Cloud Run semantics came from. Bar 1: a Pod is the scheduling unit, all
containers share the network namespace, `127.0.0.1` is the whole point. Bar 3 is
weaker than Cloud Run's: vanilla Kubernetes has init containers plus (since 1.28,
GA 1.29) native sidecar containers via `initContainers` with
`restartPolicy: Always`, but no general `dependsOn`; you get ordering by making
`db` a native sidecar that starts before the app containers. Bar 4: Knative
Serving scales to zero out of the box via the activator, which **holds the
request** while the Pod starts, exactly like Cloud Run. Bar 5:
`autoscaling.knative.dev/max-scale: "1"` is the literal same annotation, since
our `service.yaml` is already a `serving.knative.dev/v1` document. Bar 6: no
throttling concept, the container just runs. Raw TCP inbound is a Kubernetes
`Service` of type LoadBalancer or a NodePort, which works, though Knative
Serving's own ingress path is HTTP. The catch is that "self-hosted Kubernetes"
means you are running the cluster, which is always-on cost and always-on
operations, so it inverts the entire pitch unless you already have a cluster.
Worth noting anyway: **the `service.yaml` we ship is already a Knative manifest**,
so the port is closer to trivial than any other option on this page.

---

## 7. The wake-shim idea

> Could a tiny always-on VM act as a shared wake shim for a whole fleet:
> speak the Postgres wire protocol on a real TCP port, accept a connection, wake
> the corresponding scale-to-zero backend over HTTP, then proxy the stream?

### How Neon does it

**VERIFIED** (from Neon's docs and changelog, surfaced via search on
https://neon.com/docs/connect/connection-latency and
https://neon.com/docs/introduction/compute-lifecycle):

- Clients connect to a **proxy**, not to Postgres. The proxy terminates TLS and
  handles authentication, then wakes the compute and connects to it.
- **Routing is by TLS SNI.** Neon's own explanation of why: "the Postgres wire
  protocol does not transfer the server domain name, so Neon relies on the Server
  Name Indication (SNI) extension of the TLS protocol to do this." Endpoint IDs
  look like `ep-mute-recipe-239816.us-east-2.aws.neon.tech`.
- Computes suspend after 300 seconds of inactivity by default, and typical
  wake is **300-500 ms** from first query to first response.
- Separately, the Neon serverless driver "proxies the Postgres wire protocol over
  WebSocket, so that it can run in environments without raw TCP connection
  support". Note this is the *client* side, for Workers-style runtimes. It is not
  how the proxy reaches the compute.

The part that does not transfer: **Neon's computes accept raw TCP.** They run on
Neon's own infrastructure with routable addresses, so once the proxy has woken
one it just opens a socket. Our backends are Cloud Run services, which cannot
accept inbound raw TCP from anywhere, VPC included.

### So how would our shim reach the woken backend?

Three options, and only one works on Cloud Run:

1. **Raw TCP to the backend.** Dead on Cloud Run. Works on Fargate (task ENI or
   NLB), Azure with TCP ingress, and Fly. But on all three of those the shim is
   pointless, because the client could have connected directly.
2. **Postgres over WebSocket (or HTTP/2 CONNECT-ish tunnelling) to the backend.**
   The shim terminates the client's TCP, then opens a WSS connection to
   `https://<service>.run.app/wire` and pipes bytes both ways. The backend needs a
   small WS-to-wire bridge inside the `db` container that upgrades the request and
   splices to `127.0.0.1:5432`. This is Neon's serverless-driver trick moved one
   hop: the WebSocket sits between shim and backend instead of between client and
   proxy, which is what lets the client stay a vanilla libpq.
   **This is the only option that works on Cloud Run, and it is not hard**: it is
   perhaps 100 lines on each side, and it reuses the existing loopback wire.
3. **Postgres over plain HTTP request/response.** Does not work. The wire protocol
   is a stateful duplex conversation with server-initiated messages
   (`NoticeResponse`, `NotificationResponse`, `CopyData`), which request/response
   framing cannot carry without inventing a session layer.

### Cost

INFERRED from vendor pricing pages, not fetched today, so treat as
order-of-magnitude and verify before quoting:

| shim host | approx monthly |
|---|---|
| AWS `t4g.nano` on demand, us-east-1 | ~$3 compute + ~$0.65 for an 8 GB gp3 root volume |
| GCP `e2-micro` | ~$6, but one `e2-micro` in us-west1 / us-central1 / us-east1 is covered by the GCP Always Free tier |
| Fly `shared-cpu-1x` 256 MB always on | ~$1.94 (this figure is from [PLATFORM-CANDIDATES.md](PLATFORM-CANDIDATES.md)) |
| Oracle Cloud always-free ARM | $0 |

Plus a TLS certificate (free via Let's Encrypt, but it is a renewal job) and a
wildcard DNS record if you want SNI routing.

So: **$0 to $4 per month for an entire fleet.** Amortised over ten databases that
is 30 cents each; over one database it is more than the database costs.

### Latency

The shim adds one network hop **per round trip**, and Postgres is chatty: a
simple query is one RTT, an extended-protocol query with a parse and a bind is
more, and a connection setup is several.

- Shim in the **same region** as the backend: roughly +1 to 3 ms per round trip,
  plus one extra TLS handshake at connect time. Negligible for anything except
  tight loops.
- Shim in a **different region**: multiply every query's RTT by the inter-region
  latency. A shim in us-east-1 fronting a europe-west1 backend adds ~90 ms to
  every single query. This is not a shim you can put "somewhere convenient".
- On a **cold** backend, the shim's own wake call adds an HTTP round trip before
  the restore starts, so cold connect is roughly `shim RTT + Cloud Run cold start
  + restore`, i.e. our measured 3.5-5s plus a bit.

The shim can also do something Cloud Run genuinely cannot: **hold the client's
TCP connection open while the backend wakes**, which is exactly the property
Fargate lacks. That is a real feature, not just a workaround.

### Single point of failure, and the pitch

Both concerns are real and they point the same way.

- **SPOF.** One VM fronting a fleet means one reboot, one kernel patch, one
  expired certificate, one OOM, and every database in the fleet is unreachable
  even though every backend is healthy. Making it not-a-SPOF means two VMs, a
  load balancer, health checks, and a certificate distribution story, at which
  point you have built a control plane.
- **The pitch.** zeropg's claim is not merely "cheap", it is "**no orchestrator,
  no control plane, no always-on component**; the bucket is the source of truth
  and the lease is the only coordination". A shared always-on proxy that every
  connection must traverse is precisely the always-on coordinating component the
  design has been avoiding. The dollar cost is trivial; the *architectural* cost
  is not, because it changes what zeropg is.
- **It also becomes a credential chokepoint.** The shim terminates TLS and, if it
  authenticates, holds or forwards credentials for every database behind it. Our
  own [EDITOR-AUTH-SECURITY.md](EDITOR-AUTH-SECURITY.md) and
  [WIRE-AUTH-DECISION-2026-07-28.md](WIRE-AUTH-DECISION-2026-07-28.md) work is
  about *not* having such a thing.

### Recommendation

**Do not build a shared, project-operated wake shim.** Instead, split it into the
two useful halves:

1. **Build the WS-to-wire bridge in `@zeropg/server`** (the backend half of
   option 2). It is small, it is useful on its own, and it unlocks everything
   below. It is also the natural home for the TLS story, since `serveWire`
   currently does not answer `SSLRequest` at all.
2. **Ship the shim as a client-side tool, not as infrastructure**: a
   `zeropg fleet proxy` subcommand that runs *on the developer's machine*,
   listens on `127.0.0.1:5432`, wakes the Cloud Run service, and tunnels over
   WSS. Per-user, not per-fleet. Cost zero, SPOF nonexistent (if your laptop is
   off, you were not querying anyway), no credential chokepoint, and it gives
   exactly the "paste a `postgres://` URL into psql or DataGrip" experience that
   motivated the question. This fits the existing fleet CLI, which already serves
   local datadirs on demand and hands out copyable `postgres://` URLs.
3. **If a public, always-reachable `postgres://` endpoint is the actual goal,
   change platforms rather than adding a proxy.** Azure Container Apps with
   external TCP ingress, or a Fly Machine with `handlers = []`, both give a real
   public Postgres port that scales to zero, with no shim, no SPOF, and no
   always-on component. That is strictly better than any shim on Cloud Run, and
   it is the reason this document's headline finding is a portability finding and
   not a proxy design.

The only scenario where a hosted shim wins is a managed multi-tenant product with
an SLA, where a control plane is expected and the SNI routing table is a feature.
That is not this project.

---

## 8. Bottom line

### Runs TODAY with no zeropg code changes

- **Google Cloud Run.** The reference.
- **Knative on any Kubernetes.** The `service.yaml` we ship is already a
  `serving.knative.dev/v1` manifest, `max-scale`/`min-scale` are the same
  annotations, the activator holds requests during cold start like Cloud Run
  does, and Pod localhost is the same as Cloud Run localhost. The container
  ordering annotation is Cloud-Run-specific and would become a native sidecar
  (`initContainers` with `restartPolicy: Always`), which our `auth` entrypoint's
  existing readiness probing already makes optional. Caveat: you are now running
  a cluster, which is an always-on cost that inverts the economics.
- **Azure Container Apps, HTTP-ingress shape**, most likely. Sidecars share the
  network, scale to zero is native, `maxReplicas: 1` is exact, probes port over.
  The work is a resource re-cut to a valid vCPU/memory combination, dropping the
  container-dependency annotation, and an Azure Blob driver in
  `@zeropg/blobstore` (the lease needs `If-Match`, which Blob has). Call this
  "small, mostly config" rather than "none", because of the storage driver.

### Needs work, and what the work is

- **ECS on Fargate.** Everything about the multi-container shape ports cleanly
  and `dependsOn` is richer than what we have. The work is entirely the missing
  scale-from-zero: you must build the waker (ALB or CloudFront in front, a Lambda
  that sets `desiredCount` to 1 on a 503, a scale-down timer) *and* accept that
  the first request after idle fails rather than waits. Secondary work: decide
  whether the datadir moves from RAM to `ephemeralStorage` (probably yes, and it
  is an improvement), and re-tune for the absence of startup CPU boost. Estimated
  cold start 20-60s versus our 3.5-5s. Also raise the default Fargate On-Demand
  vCPU quota of 6 before running a fleet.
- **Azure Container Apps, TCP-ingress shape.** Same base work as above, plus a
  VNet environment, plus answering the one open question that matters: **does the
  TCP ingress hold an inbound connection while the replica cold-starts from
  zero?** One afternoon's experiment. If yes, this is the most interesting
  non-Google target we have, because it gives a public `postgres://` URL that
  costs nothing when idle.
- **Fly.io Machines.** Multi-container Machines with `depends_on` map onto our
  shape well, autostop/autostart is genuine scale to zero, and raw public TCP
  ports are a documented first-class feature. Three pieces of work: multi-container
  Machines are preview-grade so pin flyctl and expect churn; there is no
  `maxScale` so the single-writer guarantee rests entirely on the lease, which
  means Fly is the right place to finally exercise the fencing under host
  migration; and confirm that autostop/autostart really covers raw TCP services.
- **Render free, Railway, Koyeb.** All fail bar 1, so they are one-image-with-a-supervisor
  ports of the `db`-only shape, not ports of the multi-container shape. Koyeb's
  light-sleep 200 ms wake is worth a look on its own merits, with the caveat that
  a snapshot-resumed process wakes holding a lease that may have lapsed, which
  needs a correctness pass before it can be recommended.

### Out

- **AWS App Runner.** No sidecars at all
  (https://github.com/aws/apprunner-roadmap/issues/71 still open), and it bills
  provisioned memory while idle, so it fails the defining requirement and
  weakens the defining benefit at the same time. Hard no.

### The single most important finding

**Cloud Run's inability to accept inbound raw TCP is the deepest thing zeropg
depends on, and it is the one constraint that has quietly shaped the whole
design** (co-located app and db, loopback-only wire, no TLS on `serveWire`).
Two platforms remove it: Azure Container Apps external TCP ingress and Fly.io
`handlers = []`. Both keep scale to zero while doing so. That is a bigger
opportunity than it is a portability risk: the thing that would most change what
zeropg *is* is not escaping Google, it is getting a real `postgres://` port.
