# AWS scale-to-zero for zeropg, re-done under a single-container topology

Status: **research / planning only.** Nothing here has been deployed or measured
by us on AWS. Every vendor claim is tagged **VERIFIED** (fetched from the URL
named, on 2026-07-28) or **INFERRED** (reasoned from adjacent documented
behaviour, not stated outright). Our own numbers are tagged **MEASURED** and
cite the result file. Vendor pricing and limits move; re-check before acting.

This document supersedes the AWS sections of
[PLATFORM-PORTABILITY.md](PLATFORM-PORTABILITY.md). It does not supersede that
document's Azure, Fly, or wake-shim analysis.

Companion docs: [PLATFORM-PORTABILITY.md](PLATFORM-PORTABILITY.md),
[COLDSTART-MODEL.md](COLDSTART-MODEL.md) (our measured cold starts),
[../BREAK-EVEN.md](../BREAK-EVEN.md) (per-cloud cost crossovers),
[LIMITATIONS.md](LIMITATIONS.md).

---

## 1. The single-container correction

### 1.1 What the previous document got wrong

[PLATFORM-PORTABILITY.md](PLATFORM-PORTABILITY.md) built its entire comparison
on requirement 1: "multiple containers in one scheduling unit, reachable over
`127.0.0.1:<port>`". It then failed AWS App Runner outright on that requirement
and called it a "Hard no".

That requirement is a property of **one demo**, not of zeropg. The reference
shape the document chose,
[`../examples/cloudrun/supabase/service.yaml`](../examples/cloudrun/supabase/service.yaml),
has three containers because *Supabase* has three parts (a frontend proxy,
GoTrue, and the database). zeropg contributes exactly one of them. Nothing in
zeropg requires a separate scheduling unit, a sidecar, or a loopback TCP hop.

zeropg is a Node library. It runs in three topologies, and only the third is a
sidecar:

| topology | what it is | entry point |
|---|---|---|
| **(a) in-process** | PGlite and the bucket-backed engine inside the app's own Node process. No wire protocol, no second process, no TCP at all. | `ZeroPG.open({ store, ... })` from `@zeropg/objectstore-fs` |
| **(b) second process, same container** | the app spawns (or supervisord starts) a zeropg process alongside it; they talk over `127.0.0.1`. One image, one container. | `ZeroPGServer.start({ store, ... })` from `@zeropg/server` |
| **(c) sidecar** | zeropg in its own container in the same scheduling unit. What the Supabase demo does, because it also has GoTrue. | same as (b), just packaged separately |

Verified against the package surface:

- `ZeroPGServer` ([`../packages/server/src/server.ts`](../packages/server/src/server.ts))
  is already a **single-container** artifact. It binds one public HTTP port
  (`$PORT`, default 8080) and starts everything else on loopback inside itself:
  the Postgres wire front end on `127.0.0.1:5432` and a PostgREST child process
  on `127.0.0.1:3000`. The comment at the top of that file says so explicitly:
  "one scale-to-zero container that holds the writer lease + PGlite + the object
  storage durable home". It is not a sidecar design and never was.
- `ZeroPG.open()` ([`../packages/objectstore-fs/src/zeropg.ts`](../packages/objectstore-fs/src/zeropg.ts))
  is the in-process engine. It exposes `query()`, `exec()`, `commit()`,
  `flush()`, and `get raw(): PGlite` for direct PGlite access. An app can import
  it and never open a socket.
- `serveWire()` ([`../packages/client/src/wire.ts`](../packages/client/src/wire.ts))
  is a *local datadir* convenience for psql and ORMs. It is not on the
  bucket-backed path and is not required by any deployment.

### 1.2 What in-process actually costs

Not nothing. Three real giveaways, listed so nobody plans around a fantasy:

1. **PGlite blocks the Node event loop.** PGlite executes Postgres as
   synchronous WASM on the calling thread. A slow query stalls the app's HTTP
   server in the same process. This is documented in our own findings:
   [WIRE-AUTH-DECISION-2026-07-28.md](WIRE-AUTH-DECISION-2026-07-28.md) records
   an infinite synchronous spin inside `_PostgresMainLoopOnce` where "a 20s
   `setTimeout` never fired". A second process (topology b) does not have this
   problem, because the app's event loop and PGlite's are different loops. This
   is the strongest argument for (b) over (a) in a latency-sensitive app.
2. **The app must be Node**, or must spawn zeropg as a second process. Topology
   (a) is unavailable to a Go, PHP, or Rust app. Topologies (b) and (c) are
   language-agnostic.
3. **Memory accounting merges.** The PGlite WASM heap lives inside the app
   process. MEASURED: a `ZeroPGServer` process holding a **7.7 MB** database
   sits at **381 to 398 MB RSS** with PostgREST off
   ([`../results/standalone-ram.jsonl`](../results/standalone-ram.jsonl),
   2026-06-14), and one holding a **509 MB** database sits at **416 to 440 MB
   RSS** ([`../results/e3b-memory.jsonl`](../results/e3b-memory.jsonl),
   2026-06-12). So the per-instance floor is roughly **400 MB regardless of
   database size**, and an app embedding zeropg must budget for it on top of its
   own heap.

What in-process does **not** give up, contrary to the obvious guess: the wire
protocol. `ZeroPGServer` binds `WireFrontend` to `this.db.raw`, so an in-process
embed can stand up the same loopback Postgres port if it wants one. The wire
face is a choice, not a consequence of the topology.

One gap worth naming, because it makes topology (a) less turnkey than it sounds:
**`connect('s3://...')` is not wired.**
[`../packages/client/src/index.ts:92`](../packages/client/src/index.ts) throws
for `gs://`, `r2://`, `s3://`, and `cos://` with an explicit "not wired yet"
message. In-process bucket-backed today means importing `@zeropg/objectstore-fs`
directly. That is a small amount of work, not a design problem, but it is work
that does not exist yet.

### 1.3 The correction that matters most: we have almost no background work

The brief for this document assumed "zeropg has background timers for
WAL-shipping, lease renewal and flush". That is **wrong for the default
configuration**, and getting it right changes the Lambda verdict completely.

Verified in [`../packages/objectstore-fs/src/zeropg.ts`](../packages/objectstore-fs/src/zeropg.ts):

- **Lease renewal is on the request path, not a timer.** `validateLease()` at
  line 1275 carries the comment "E4 bet b: no background work". It validates and,
  past half-life, renews the lease inline during a query. There is no lease
  heartbeat.
- **WAL shipping is part of `commit()`**, which is part of the write path. There
  is no shipping timer.
- **The only `setInterval` in the engine** is at line 471, and it is created
  **only** when `durability === 'interval'`. It is also `.unref()`ed.

`Durability` is `'strict' | 'interval' | 'sleep'`, defaulting to **`'strict'`**
(line 309). The three modes map onto a frozen-CPU platform like this:

| mode | background CPU needed between requests? | behaviour on a freeze/thaw platform |
|---|---|---|
| `strict` (default) | **none** | works unchanged. Every acknowledged write is already in the bucket before the response is sent. |
| `interval` | yes, a timer every `flushIntervalMs` (default 1000) | **broken.** The timer does not advance while frozen. |
| `sleep` | no timer, but needs a shutdown window long enough to snapshot | **broken** on Lambda (300 ms budget); unreliable on any platform that kills without notice. |

`ZeroPGServer` adds one more timer: `wireFlushTimer`, a 5-second poll of
`pg_stat_database` that catches writes arriving over the **raw wire**, which
bypass `ZeroPG.query()` and therefore bypass the dirty flag
([`../packages/server/src/server.ts:224-229`](../packages/server/src/server.ts)).
It is irrelevant in topologies (a) and (b) if nothing connects over the wire,
and it is the reason a wire-exposing deployment cannot be purely request-driven.

**So: with `durability: 'strict'` and no raw-wire clients, zeropg needs zero CPU
between requests.** That is exactly the contract a freeze/thaw platform offers.

### 1.4 Revised verdict: AWS App Runner

**Old verdict: "Hard no, no sidecars."** That reasoning is void. App Runner's
lack of sidecars is irrelevant to a single-container zeropg.

**Revised verdict: still out, for two harder reasons, one of which is fatal on
its own.**

1. **App Runner is closed to new customers, and the date has already passed.**
   VERIFIED, https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html,
   which carries the banner verbatim: "AWS App Runner is no longer open to new
   customers. Existing customers can continue to use the service as normal."
   The API reference pages carry the dated form, e.g.
   https://docs.aws.amazon.com/apprunner/latest/api/API_CreateAutoScalingConfiguration.html:
   "AWS App Runner will no longer be open to new customers starting March 31,
   2026." Today is 2026-07-28. Unless the account is already an App Runner
   customer, **this option does not exist**. The same page adds: "AWS continues
   to invest in security and availability for AWS App Runner, but we do not plan
   to introduce new features."
2. **App Runner never scaled to zero in the first place.** VERIFIED,
   https://docs.aws.amazon.com/apprunner/latest/api/API_CreateAutoScalingConfiguration.html:
   `MinSize` has a documented **"Minimum value of 1. Maximum value of 25"**, and
   its default is 1. There is no `minReplicas: 0`. The only route to zero compute
   is the manual `PauseService` API, which
   https://docs.aws.amazon.com/apprunner/latest/dg/manage-pause.html describes as
   "App Runner reduces the compute capacity for the service to zero" and warns
   "When you pause your service, your application loses its state ... any
   ephemeral storage that your code used is lost". Pause is an admin action, not
   a request-driven idle behaviour, and it does not wake on a request.
3. **The idle bill, exactly.** VERIFIED, https://aws.amazon.com/apprunner/pricing/
   (no publication date is stated on that page). US East (N. Virginia):
   provisioned container instances **$0.007 per GB-hour**; active container
   instances **$0.064 per vCPU-hour** and **$0.007 per GB-hour**. The wording,
   verbatim: "When your application is idle, you pay per GB of memory for
   provisioned container instances which keep your application warm and eliminate
   cold starts." Memory is billed at the same rate idle or active; only the vCPU
   charge stops. At the 1 vCPU / 2 GB configuration a zeropg instance needs, that
   is `2 x 0.007 x 730` = **$10.22 per month with zero traffic**. At 1 vCPU / 4 GB
   it is **$20.44 per month**.
4. **CPU is throttled between requests.** VERIFIED,
   https://aws.amazon.com/apprunner/faqs/: "If your application receives no
   incoming requests, App Runner will scale the containers down to a provisioned
   instance, a CPU-throttled instance ready to serve incoming requests within
   milliseconds." AWS never quantifies the throttle
   (NOT STATED on that page or on
   https://docs.aws.amazon.com/apprunner/latest/dg/develop.html). So
   `durability: 'interval'` would be unreliable, and `durability: 'strict'` would
   be mandatory here too. The developer guide is blunter still: "App Runner
   doesn't guarantee state persistence beyond the duration of processing a single
   incoming web request."
5. **A 120-second HTTP request timeout.** VERIFIED,
   https://docs.aws.amazon.com/apprunner/latest/dg/develop.html: "There is a total
   of 120 seconds request timeout limit on the HTTP requests." Every `strict`
   commit has to finish inside that.
6. **Every deployment creates a two-writer window.** VERIFIED, same page: "App
   Runner temporarily doubles the number of provisioned instances during
   deployments, to maintain the same capacity for both old and new code." Even
   with `MinSize: 1, MaxSize: 1` you get two instances on every deploy, both of
   which restore the datadir and contend for the lease. This is the same class of
   problem as our recorded sleep-durability deploy-roll write loss, and it is
   guaranteed rather than occasional.

**Net: the previous document reached the right answer for the wrong reason.**
Correcting the reasoning makes the verdict stronger, not weaker. App Runner is
out because you cannot sign up for it and because its floor is one always-billed
instance, not because it lacks sidecars.

Worth flagging for the record: App Runner's designated successor is **Amazon ECS
Express Mode** (VERIFIED, same availability-change page: "We recommend that
customers explore Amazon Elastic Container Service (Amazon ECS) Express Mode when
migrating from AWS App Runner"). Express Mode provisions "an ECS service on
Fargate, an Application Load Balancer, auto scaling, and networking". An ALB is a
fixed hourly charge with no scale-to-zero, so the replacement is structurally
**worse** for our cost model than the thing it replaces.

---

## 2. Comparison table

Criteria, all under a **single-container or in-process** topology:

- **zero-when-idle**: does the monthly bill go to zero with no traffic?
- **request wake**: does an inbound request wake it, with no glue you write?
- **request held**: is the cold start invisible to the client, or does the first
  request fail?
- **CPU between requests**: do `setInterval` timers fire with no traffic?
- **cold start**: best-evidenced figure, ours or the vendor's.
- **datadir**: where the ~0.5 GB Postgres data directory can live.

Legend: **Y** yes, **P** partial, **N** no.

| option | zero-when-idle | request wake | request held | CPU between requests | memory ceiling | datadir | cold start | idle cost, 1 DB |
|---|---|---|---|---|---|---|---|---|
| **Cloud Run** (reference) | **Y** | **Y** | **Y** | **Y** with `cpu-throttling: "false"` | 32 GiB | tmpfs, counts against memory | **3.5 to 12.3 s** MEASURED | $0 |
| **AWS Lambda** (container image + Lambda Web Adapter + Function URL) | **Y**, genuinely $0 | **Y** | **Y** | **N**, environment is frozen | 10,240 MB | `/tmp`, up to 10,240 MB, configured separately from memory | INFERRED 5 to 15 s, unmeasured by us | **$0** |
| **ECS on Fargate** | **Y** at `desiredCount: 0` | **N**, needs glue you write | **N**, first request 503s | **Y**, it is a microVM | 120 GB | ephemeral disk, 20 to 200 GiB, **no tmpfs** | no credible public figure; measure it | $0 at zero, but nothing wakes it |
| **ECS Fargate Spot** | **Y** | **N** | **N** | **Y** | same | same | same | $0, but a one-task service can stay down |
| **EKS + Knative** | **N**, $73/month control plane floor | **Y** | **Y**, the activator buffers | **Y** | node-sized | node disk or tmpfs | pod start + restore | **$73+/month** |
| **EKS + KEDA HTTP add-on** | **N**, same floor | **Y** | **Y**, the interceptor holds | **Y** | node-sized | same | pod start + restore, plus node provisioning if no spare capacity | **$73+/month** |
| **AWS App Runner** | **N**, `MinSize` minimum is 1 | **Y** while running | **Y** | **N**, "CPU-throttled" when idle | 12 GB | 3 GB ephemeral, shared with the image | seconds, undocumented | **$10.22/month** at 2 GB |
| **ECS Express Mode** | **N**, always-on ALB | **N** | **N** | **Y** | Fargate-sized | Fargate ephemeral | Fargate-class | ALB hourly + Fargate |
| **AWS Batch** | **Y** | **N**, job-queue only, no HTTP front door | **N** | **Y** | Fargate-sized | Fargate ephemeral | Fargate-class + queue latency | $0, but not reachable |
| **Lightsail Containers** | **N** | n/a | n/a | **Y** | 8 GB | container FS | n/a | **$7/month** minimum |
| **ECS Anywhere** | **N** | **N**, no load balancing support at all | **N** | **Y** | your hardware | your disk | your hardware | **$7.48/month** control plane, plus your hardware |
| **Always-on EC2** | **N** by definition | n/a, always warm | n/a | **Y** | instance-sized | real disk | **none** | **$3.71 to $12.90/month** |

---

## 3. Per-option analysis

### 3.1 AWS Lambda

This is the option the previous document omitted entirely, and it is the
strongest AWS answer.

#### What fits

**Sizing.** VERIFIED, https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html:
container image code package **10 GB** ("maximum uncompressed image size,
including all layers"); function memory **128 MB to 10,240 MB, in 1-MB
increments**; `/tmp` **between 512 MB and 10,240 MB, in 1-MB increments**;
timeout **900 seconds (15 minutes)**. VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html: "At 1,769
MB, a function has the equivalent of one vCPU." A max vCPU figure is NOT STATED
on either page; 10,240 / 1,769 is 5.79 vCPU-equivalents but AWS does not print
that number.

For zeropg that is comfortable. A 500 MB datadir in a 2,048 MB `/tmp` alongside a
2,048 MB memory allocation (1.16 vCPU) is a reasonable starting configuration,
and the memory dial doubles as the CPU dial for the restore.

**Truly zero idle cost.** VERIFIED, https://aws.amazon.com/lambda/pricing/ (no
publication date stated on the page): there is no idle charge, no provisioned
memory concept, and no per-function standing fee. US East (N. Virginia)
on-demand: duration **$0.0000166667 per GB-second** on x86 and **$0.0000133334
per GB-second** on arm64; requests **$0.20 per million** on both. Free tier is
still **1 million requests and 400,000 GB-seconds per month**, with a separate
400,000 GB-second pool per architecture. Ephemeral storage above 512 MB is
**$0.0000000309 per GB-second**, billed per second of *execution*, not per second
of held capacity, so a large `/tmp` on a rarely-invoked function costs
essentially nothing.

**Request-held cold start, natively.** Lambda's entire model is "hold the caller
while the environment initialises". This is the one AWS product with Cloud Run's
wake semantics, and it is the reason everything else on AWS loses.

**The HTTP face already matches.** VERIFIED, https://github.com/aws/aws-lambda-web-adapter
(the repo has moved from the `awslabs` org to the `aws` org; Apache-2.0, latest
release **v1.0.1 published 2026-05-28**, GA v1.0.0 on 2026-03-27). README,
verbatim: "AWS Lambda Web Adapter allows developers to build web apps (http api)
with familiar frameworks ... anything speaks HTTP 1.1/1.0 ... and run it on AWS
Lambda." It supports "Amazon API Gateway Rest API and Http API endpoints, Lambda
Function URLs, and Application Load Balancer", "docker OCI images", "graceful
shutdown", and "response streaming".

`ZeroPGServer` already is what LWA wants: an HTTP server on `$PORT` with a
readiness endpoint. The mapping is direct:

```
AWS_LWA_PORT=8080                    # ZeroPGServer's default, and it reads $PORT
AWS_LWA_READINESS_CHECK_PATH=/ready  # server.ts returns 200 only at phase 'ready'
AWS_LWA_ASYNC_INIT=true              # see the Init limit below
```

**Function URLs cost nothing extra.** VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/furls-http-invoke-decision.html,
verbatim: "Function URLs follow the standard Lambda pricing model - you only pay
for function invocations and compute time. There are no additional charges for
the URL endpoint itself." Endpoint form
`https://<url-id>.lambda-url.<region>.on.aws`, and "Once you create a function
URL, its URL endpoint never changes." Response payload is 6 MB buffered, 200 MB
streamed. A Function-URL-specific request timeout distinct from the 900-second
function timeout is **NOT STATED** on
https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html,
https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html, or the quotas
page. (Contrast App Runner, which does publish a 120-second limit.)

#### What breaks, precisely

**1. `durability: 'interval'` is dead.** VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html,
verbatim: "Lambda freezes the execution environment when the runtime and each
extension have completed and there are no pending events." And on background
work, verbatim: "Background processes or callbacks that were initiated by your
Lambda function and did not complete when the function ended resume if Lambda
reuses the execution environment. Make sure that any background processes or
callbacks in your code are complete before the code exits."

Read precisely: incomplete work does not progress while frozen, it *resumes* on
the next thaw, and only if that environment is reused. `setInterval`,
`setTimeout`, and the Node event loop are **NOT STATED** anywhere on that page;
the "background processes or callbacks" sentence is the authoritative wording.
Consequence: a 1-second flush interval becomes "whenever the next request happens
to arrive", which is unbounded and invisible. Do not use `interval` on Lambda.

**2. `durability: 'sleep'` is dead.** VERIFIED, same page, verbatim on the
Shutdown phase duration limit:

> - 0 ms - A function with no registered extensions
> - 500 ms - A function with a registered internal extension
> - 2,000 ms - A function with one or more registered external extensions
>
> If the runtime or an extension does not respond to the `Shutdown` event within
> the limit, Lambda ends the process using a `SIGKILL` signal.

With no extension there is **no shutdown window at all**. SIGTERM to the runtime
is gated on an external extension: VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/lambda-python.html, in a section
titled "Graceful shutdown for extensions", verbatim: "Python 3.12 and later
Python runtimes offer improved graceful shutdown capabilities for functions with
external extensions. When Lambda shuts down an execution environment, it sends a
`SIGTERM` signal to the runtime and then a `SHUTDOWN` event to each registered
external extension." There is **no equivalent statement on the Node.js runtime
page** (NOT STATED on
https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html), so on Node this
is undocumented behaviour that works because the extension flips the budget.
AWS's own sample repo https://github.com/aws-samples/graceful-shutdown-with-aws-lambda
states verbatim: "Lambda reserves up to 300 ms (500 ms for a runtime with an
internal extension) for the runtime process to perform a graceful shutdown."

**300 ms does not snapshot a 0.5 GB datadir to S3.** Note that Lambda Web Adapter
installs itself into `/opt/extensions/` (README Dockerfile line, verbatim:
`COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter
/opt/extensions/lambda-adapter`), so simply using LWA moves you from 0 ms to the
2,000 ms window and gets SIGTERM delivered. It is still not enough. Use `strict`.

**3. The 10-second Init limit will fire on a large datadir.** VERIFIED, same
lifecycle page, verbatim: "The `Init` phase is limited to 10 seconds. If all
three tasks do not complete within 10 seconds, Lambda retries the `Init` phase at
the time of the first function invocation with the configured function timeout."
The exemption note, verbatim: "The 10-second timeout doesn't apply to functions
that are using provisioned concurrency, SnapStart, or Lambda Managed Instances."
None of those apply to us.

MEASURED, [`../results/e3b-memory.jsonl`](../results/e3b-memory.jsonl): a 509 MB
datadir restore on Cloud Run at 1 vCPU took **8,993 to 9,768 ms** for the restore
alone, plus 777 to 858 ms of `PGlite.create`, for a total boot of **10,131 to
11,266 ms**. That is already past 10 seconds before Lambda's own runtime
initialisation. So on a 500 MB database the Init retry is not a risk, it is the
expected path, and the restore would run **twice** while being billed both times.
Container-image INIT has always been billed, and since 2025-08-01 all INIT is:
VERIFIED, https://aws.amazon.com/blogs/compute/aws-lambda-standardizes-billing-for-init-phase/
(posted 2025-04-29, effective 2025-08-01).

The documented escape hatch is `AWS_LWA_ASYNC_INIT=true`, described in the LWA
README as "enable asynchronous initialization for long initialization
functions". `ZeroPGServer.start()` is already built for this: it calls
`srv.listen()` synchronously and `void srv.boot()` in the background, and `/ready`
answers 503 with a phase until the restore finishes. This is a good fit, but it
is untested and it is experiment E-A2 below.

**4. Reserved concurrency = 1 is not a single-writer fence.** VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html,
verbatim: "Reserved concurrency - This sets both the maximum and minimum number
of concurrent instances allocated to your function." And VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html, verbatim:
"Concurrency is the number of in-flight requests that your AWS Lambda function is
handling at the same time."

Every guarantee is phrased in terms of concurrent *requests*. That AWS never
bounds live *environments* is **NOT STATED** as a guarantee anywhere on those
pages, and the same lambda-concurrency page positively documents the opposite,
verbatim: "For functions using on-demand concurrency, Lambda may occasionally
initialize execution environments ahead of invocation requests. When this
happens, you may also observe a time gap between your function's initialization
and invocation phases. We recommend you to not take a dependency on this
behavior." Plus: "Lambda terminates execution environments every few hours to
allow for runtime updates and maintenance - even for functions that are invoked
continuously. You should not assume that the execution environment will persist
indefinitely."

An environment that runs Init runs our restore and takes our lease. So on Lambda
**the lease is the only writer guard, and takeover is routine rather than
exceptional**. Our fencing is designed for exactly this, but it has never been
exercised at this frequency. This is the biggest correctness question in the
whole port, and it is experiment E-A3.

Second simultaneous request behaviour: VERIFIED, the decision page, verbatim:
"Function URLs scale directly with your Lambda function's concurrency limits ...
Once that limit is reached, Lambda responds to additional requests with HTTP 429
responses. There's no built-in queuing mechanism". So with reserved concurrency 1
a concurrent second caller gets a 429, not a queue. For a database that is a
throughput ceiling of one in-flight request per function, which for PGlite (which
serialises everything anyway) is less bad than it sounds, but it does mean no
connection pooling and no parallel readers.

**5. The `Inactive` landmine, which is a direct hit on the pitch.** VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/images-create.html, verbatim: "If a
function is not invoked for multiple weeks, Lambda reclaims its optimized
version, and the function transitions to the `Inactive` state. To reactivate the
function, you must invoke it. **Lambda rejects the first invocation** and the
function enters the `Pending` state until Lambda re-optimizes the image."

A database that is idle for weeks and then gets one visitor is precisely zeropg's
target workload, and on Lambda that visitor's request is **rejected outright**,
not merely slow. Mitigation is a weekly EventBridge Scheduler ping, which costs
effectively nothing but is an always-on scheduled component the design has been
trying to avoid. It is a cron, not a coordinator, so it is a much smaller
concession than a wake shim, but it must be in the recipe.

**6. No `postgres://`.** Function URLs are HTTP request/response. The 15-minute
maximum duration and the freeze model make a long-lived TCP wire session
impossible. On Lambda, zeropg is HTTP-only: `POST /sql`, `/rest` via PostgREST
(which would itself need to run as a child process in the image and would hold
its pool across freezes, another untested area), and `/wake` plus `/ready`.

**7. SnapStart is triply excluded.** VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html, verbatim: "SnapStart
is available for the following Lambda managed runtimes: Java 11 and later, Python
3.12 and later, .NET 8 and later" and "Other managed runtimes (such as
`nodejs24.x` and `ruby4.0`), OS-only runtimes, and container images are not
supported." Plus, verbatim: "SnapStart does not support provisioned concurrency,
Amazon Elastic File System (Amazon EFS), Amazon S3 Files, or ephemeral storage
greater than 512 MB." Node.js, container image, and a >512 MB `/tmp` each
disqualify us independently. The Koyeb-style "light sleep resumes a snapshot in
200 ms" trick is not available on Lambda for us.

**8. Provisioned concurrency defeats the point.** VERIFIED,
https://aws.amazon.com/lambda/pricing/: provisioned concurrency
**$0.0000041667 per GB-second**, duration while enabled **$0.0000097222 per
GB-second**, and verbatim "The Lambda free tier does not apply to functions
enabling Provisioned Concurrency." Holding a single 2 GB environment warm is
`0.0000041667 x 2 x 2,592,000` = **$21.60 per month** before a single
invocation. That is more than an always-on t4g.small. Do not use it.

**9. EFS is the wrong shape.** VERIFIED,
https://docs.aws.amazon.com/lambda/latest/dg/configuration-filesystem-efs.html:
requires the function to be in a VPC, and the performance guidance is verbatim
"For best performance, create an access point with a non-root path, and limit the
number of files that you create in each directory", which is directly hostile to
a Postgres data directory layout. It also gives multiple environments a shared
mutable filesystem with no locking primitive, which makes the single-writer
problem worse rather than better. (Note that a newer option exists, **Amazon S3
Files** as a Lambda mount, per
https://docs.aws.amazon.com/lambda/latest/dg/configuration-filesystem.html:
"Serverless file system for mounting your Amazon S3 bucket". Worth a separate
look for the lazy-page-fault restore idea in
[LAZY-PAGEFAULT-RESTORE-from-blob.md](LAZY-PAGEFAULT-RESTORE-from-blob.md), but
not for the primary datadir.)

**Cold start.** AWS does document a generic figure. VERIFIED, the lifecycle page,
verbatim: "Cold starts typically occur in under 1% of invocations. The duration of
a cold start varies from under 100 ms to over 1 second." That is for ordinary
functions and tells us nothing about a container image doing a 500 MB S3 restore.
A container-image-versus-zip comparison and any INIT-duration figure for large
images are **NOT STATED** anywhere I could find. INFERRED, by adding our measured
restore to a plausible container pull and Node boot: **5 to 15 seconds** depending
on datadir size and memory tier, which is worse than Cloud Run's measured 3.5 to
12.3 s but the same order. Unmeasured. This is experiment E-A4.

#### Verdict on Lambda

**Viable, and the option I would pick on AWS**, with three caveats stated up
front: `durability: 'strict'` only, the lease is the sole writer guard with
routine takeover, and a weekly keepalive ping is mandatory because of the
`Inactive` state. It gives up the `postgres://` port entirely.

### 3.2 ECS on Fargate

Under a single-container topology the previous document's multi-container praise
for Fargate becomes moot, and what is left is one disqualifier and several
corrections.

#### The disqualifier, unchanged and now better evidenced

**No request-driven scale-from-zero, and no component that holds a request.**
VERIFIED, https://github.com/aws/containers-roadmap/issues/1017 is still **OPEN**,
opened 2020-08-06, last updated 2026-01-23, 32 comments, 82 thumbs-up, project
status "Researching". The last substantive AWS comment in the thread is from
2021. Six years open, no feature.

What actually wakes a `desiredCount: 0` service, enumerated:

1. **Application Auto Scaling with `minCapacity: 0` plus a CloudWatch metric.**
   VERIFIED, https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html,
   verbatim: "If you want your task count to scale to zero when there's no work to
   be done, set a minimum capacity of 0. With target tracking scaling policies,
   when actual capacity is 0 and the metric indicates that there is workload
   demand, Service Auto Scaling waits for one data point to be sent before scaling
   out." ECS publishes metrics at 1-minute intervals, and "you cannot create
   CloudWatch alarms for metrics that do not exist". For a queue this works. For
   HTTP it requires an ALB metric that only exists once something is already being
   served, so it is circular.
2. **A CloudWatch alarm on the ALB's HTTP 503 count.** This is the state of the
   art in the wild and it is exactly what it sounds like: the first requests after
   idle are deliberately served as errors, and a Lambda then sets
   `desiredCount: 1`.
3. **Scheduled scaling.** Cron. Useless for a visitor-driven wake.
4. **You call `UpdateService` or `RunTask` yourself** from Lambda, Step
   Functions, or CI. Glue you write and own.
5. **Predictive scaling** (November 2024). Historical patterns, not requests.

There is **no AWS mechanism anywhere in the container lineup where an inbound
HTTP request is held or buffered while a task starts**. That is the whole
finding. Knative's activator does it (section 3.3), KEDA's interceptor does it,
Cloud Run does it, Lambda does it. ECS does not.

#### Correction: the "20 to 60 second cold start" was folklore

The previous document cited 20 to 60 seconds from a third-party post. That figure
does not survive scrutiny and should not be repeated.

What actually exists:

- **AWS publishes no per-task launch-latency figure at all.** The frequently-cited
  https://aws.amazon.com/about-aws/whats-new/2022/04/aws-fargate-delivers-scaling-applications
  (posted 2022-04-13) is about *throughput*, verbatim: "can now launch up to 500
  tasks in under a minute per service, 16X faster than last year" and "burst up to
  100 On-Demand or Spot tasks, with a sustained task launch rate of 20 tasks per
  second". Tasks per minute is not seconds per task.
- **The best-methodology public measurement is AWS's own Spring Boot study.**
  VERIFIED, https://aws.amazon.com/blogs/containers/start-spring-boot-applications-faster-on-aws-fargate-using-soci/
  (posted 2023-10-05): **500 container startups**, 1 vCPU / 2 GB task, eu-west-1,
  timed from the `RunTask` CloudTrail entry to the Spring `ApplicationReadyEvent`.
  Images 875 MB compressed (uber JAR), 790 MB (layered JAR), ~175 MB (Quarkus).
  SOCI gave 17% on the uber JAR, 25.6% for layered-plus-SOCI versus uber-no-SOCI,
  and only 13 to 14% on the ~175 MB Quarkus image. The post reports relative
  improvements, not an absolute baseline we can lift.
- **The most recent measurement is AWS-authored with n=5 and covers image pull
  only.** VERIFIED, https://arxiv.org/html/2607.06868v1 (2026-07-07, authors at
  AWS): on Fargate, a 1.3 GB python-flask image pulled in 19,740 ms +/- 527
  without SOCI and 4,833 ms +/- 1,075 with it; a 2.5 GB image, 25,150 ms +/- 200
  versus 5,088 ms +/- 1,297. Pull time only. The paper explicitly says end-to-end
  speedup is lower.
- **The 2024 to 2026 third-party numbers are content-farm output.** The
  "sub-5-second task launches" and "87 ms microVM cold start" posts have no
  methodology, no region, no run counts, and contradict each other by two orders
  of magnitude.

**The correct statement is: nobody has published a defensible bare-Fargate task
launch figure, and we should measure our own.** Fargate exposes per-phase task
lifecycle timestamps (`pullStartedAt`, `pullStoppedAt`, `createdAt`, `startedAt`)
through `DescribeTasks`, so this is a half-day experiment, not a literature
problem. See E-B1.

SOCI is not a general fix for us. VERIFIED,
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html,
verbatim: "We recommend that you try lazy loading with container images greater
than 250 MiB compressed in size. You are less likely to see a reduction in the
time to load smaller images." It also requires ECR private registries, gzip or
uncompressed layers (zstd images cannot use SOCI), and SOCI Index Manifest v2.

#### Correction: no tmpfs on Fargate, and the previous document's inference was right

The previous document marked this INFERRED. It is now VERIFIED, and the
authoritative statement is on a different page than the one it checked.
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html
states verbatim: "`linuxParameters` - ... The `devices`, `sharedMemorySize`, and
`tmpfs` parameters are not supported." The task-definition parameter reference at
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
documents `tmpfs` without a Fargate-unsupported note, unlike its siblings, which
is why the community understanding was muddy. The API reference
https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_LinuxParameters.html
is likewise silent about Fargate for `tmpfs`. Three pages, one of which
contradicts the other two by omission. Confirm with a real
`RegisterTaskDefinition` call before planning around it (E-B2).

So on Fargate the datadir goes on **ephemeral disk**. VERIFIED,
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-storage.html:
minimum 20 GiB, expandable to 200 GiB via `ephemeralStorage.sizeInGiB`, AES-256
encrypted, and verbatim "The pulled, compressed, and the uncompressed container
image for the task is stored on the ephemeral storage." First 20 GB free, extra at
**$0.000111 per GB-hour** in us-east-1 (price list publication date 2026-07-07).

This is a genuine behaviour change from Cloud Run and it is **in our favour on
cost**: database size decouples from the memory tier. It is a behaviour change
against us on latency: an encrypted EBS-backed volume is slower than tmpfs for a
restore and for page faults. Unmeasured.

#### Pricing

VERIFIED, AWS Price List
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-1/index.json
(publication date 2026-07-07) and https://aws.amazon.com/fargate/pricing/,
us-east-1 Linux:

| | vCPU-hour | GB-hour |
|---|---|---|
| x86 on-demand | $0.04048 | $0.004445 |
| ARM on-demand | $0.03238 | $0.00356 |
| x86 Spot | $0.01270844 | $0.00139548 |
| ARM Spot | $0.0101655 | $0.00111764 |

Spot is a **68.6%** discount on all four against on-demand, consistent with the
pricing page's "up to a 70% discount".

Always-on monthly (730 hours), for tiers that can actually hold a ~400 MB RSS
process:

| task | x86 on-demand | ARM on-demand | ARM Spot |
|---|---|---|---|
| 0.25 vCPU / 1 GB | $10.63 | $8.51 | $2.67 |
| 0.25 vCPU / 2 GB | $13.88 | $11.11 | $3.49 |
| 0.5 vCPU / 2 GB | $21.26 | $17.02 | $5.34 |

Note that 0.25 vCPU is roughly 4x slower on restore than the 1 vCPU tier our E3
numbers were taken at ([../BREAK-EVEN.md](../BREAK-EVEN.md) §4), so the cheap tier
and the fast-cold-start tier are the same dial. Fargate has no startup CPU boost.

#### Fargate Spot

VERIFIED, https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html:
"a two-minute warning is sent before a task is stopped. The warning is sent as a
task state change event to Amazon EventBridge and as a SIGTERM signal to the
running task." Default `stopTimeout` is 30 seconds, settable up to **120
seconds**. That is genuinely enough for a `sleep`-durability flush of a 0.5 GB
datadir, which makes Fargate Spot the *only* option in this document where the
`sleep` mode survives cleanly.

Against that, verbatim from the same page: "Fargate doesn't replace Spot capacity
with on-demand capacity" and "A service with only one task is interrupted until
capacity is available". A single-task Spot service can simply stay down for an
unbounded period. For a database that is disqualifying, and `maxScale: 1` is the
whole point of our topology, so we cannot buy availability with more tasks.
Linux only, x86 and ARM64 both supported (ARM64 Spot since 2024-09-06). Task-size
limits for Spot are NOT STATED on either page.

#### Verdict on Fargate

**Not the first choice, but the right choice if you need a real `postgres://`
port.** The task gets its own ENI under `awsvpc`, so an NLB or a public IP on the
task gives inbound raw TCP, which no other option in this document offers on AWS.
The cost is that you write the waker, and the first request after idle is a
failure rather than a wait.

### 3.3 EKS with Knative or KEDA

Semantically this is the closest thing to Cloud Run on AWS, because it *is* the
thing Cloud Run's semantics came from. Economically it is the worst option here.

**Knative's activator holds the request.** VERIFIED,
https://knative.dev/docs/serving/request-flow/, verbatim: "The activator serves as
a buffer or queue for incoming requests -- if a request is routed to a Revision
which does not currently have available capacity, the activator delays the request
and signals to the autoscaler that additional capacity is needed." Scale-to-zero
grace period: VERIFIED, https://knative.dev/docs/serving/autoscaling/scale-to-zero/,
the key is `scale-to-zero-grace-period` with a **default of `30s`**, alongside
`enable-scale-to-zero` and `scale-to-zero-pod-retention-period`.

**Our manifest already is a Knative manifest.** `examples/cloudrun/supabase/service.yaml`
is a `serving.knative.dev/v1` document and `autoscaling.knative.dev/minScale` and
`maxScale` are the same annotations. The port is closer to trivial than any other
option on this page. The Cloud-Run-specific pieces that would need replacing are
`run.googleapis.com/container-dependencies` (becomes a native sidecar:
`initContainers` with `restartPolicy: Always`, Kubernetes 1.29 GA) and
`run.googleapis.com/cpu-throttling` (no equivalent needed, a Pod just runs).

**KEDA's HTTP add-on also holds the request.** VERIFIED,
https://keda.sh/http-add-on/0.15/concepts/scaling/, verbatim: "When a request
arrives for a backend that has been scaled to zero, the interceptor holds the
request while KEDA scales the backend up". Status is **beta**: VERIFIED,
https://github.com/kedacore/http-add-on, verbatim: "The HTTP Add-on is in beta and
actively maintained by the KEDA community, with a v1.0 release planned" and
"minor breaking changes ... may still occur before v1.0". The older "we can't yet
recommend it for production usage" wording is no longer present.

**The economics kill it.** VERIFIED, https://aws.amazon.com/eks/pricing/: EKS
control plane **$0.10 per cluster per hour** = **$73.00 per month** for versions
in standard support (the first 14 months), and **$0.60 per cluster per hour** =
**$438.00 per month** in extended support thereafter. That 6x extended-support
cliff is the trap in every stale EKS cost comparison, and it triggers by doing
nothing.

Can a cluster have zero worker nodes? Mechanically yes, since EKS bills per
cluster-hour and Fargate profiles run pods without EC2 nodes (VERIFIED,
https://docs.aws.amazon.com/eks/latest/userguide/fargate.html). But that route
carries disqualifiers, verbatim from the same page: "Daemonsets aren't supported
on Fargate", "Pods that run on Fargate are only supported on private subnets" (so
a NAT gateway, roughly $32 per month more, or VPC endpoints), "The Amazon EC2
instance metadata service (IMDS) isn't available", "Amazon EKS doesn't support
Fargate Spot", and "Can run workloads that require Arm processors: No". And
INFERRED but decisive: Knative's activator, autoscaler, and controller, or KEDA's
operator, metrics-server, and interceptor, are themselves long-running pods that
must run 24/7 somewhere. The scale-to-zero stack has an always-on footprint.

EKS Auto Mode does not help: VERIFIED, same pricing page, it adds a per-instance-
hour management fee of **$0.02064 to $0.07344 per hour** depending on instance
type, on top of EC2 and on top of the $0.10 per hour control plane.

**Verdict: correct semantics, absurd economics for a scale-to-zero database.**
$73 per month before serving a byte is more than an always-on RDS db.t4g.micro
and roughly 20x an always-on t4g.nano. It is only rational if you already run an
EKS cluster for other reasons, in which case zeropg drops into it with the
manifest we already ship. Section 4 works out the fleet-size math and it never
crosses over.

### 3.4 The rest of AWS, briefly

**AWS Batch.** VERIFIED, https://docs.aws.amazon.com/batch/latest/userguide/fargate.html:
"Fargate is only available for AWS Batch compute environments that use Amazon ECS
as the orchestrator." It genuinely costs zero when idle. But it is job-queue
driven: work enters through `SubmitJob`, there is no HTTP front door, and there is
no way to route a live inbound connection to a started container. You would build
API Gateway plus Lambda plus SubmitJob plus a polling response channel, at which
point you have written a worse Lambda. **Dismissed.**

**Lightsail Containers.** VERIFIED, https://aws.amazon.com/lightsail/pricing/:
flat monthly per node, **Nano $7, Micro $10, Small $15, Medium $40, Large $80,
XLarge $160**, with 500 GB per month of data transfer included. No scale-to-zero
and no hourly idle discount. The $7 floor is worse than a t4g.nano at $3.07 per
month on-demand or $1.90 per month reserved, for a product with fewer knobs.
**Dismissed.**

**ECS Anywhere.** VERIFIED,
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-anywhere.html:
this is registering *your own* on-premises server or VM into an ECS cluster with
the `EXTERNAL` launch type. AWS bills **$0.01025 per registered instance-hour**
($7.48 per month) for the control plane on top of your own hardware, and verbatim
"Service load balancing isn't supported" and "Service discovery isn't supported",
with `awsvpc` unavailable. The docs themselves say external instances "are
optimized for running applications that generate outbound traffic or process data"
and that "the lack of Elastic Load Balancing support makes running these workloads
less efficient" for inbound traffic. **Dismissed**: it is a way to pay AWS for the
privilege of running your own VM, which is section 4's option without section 4's
economics.

**App2Container.** Confirmed to be a migration/containerisation CLI, not a
runtime, per https://docs.aws.amazon.com/app2container/latest/UserGuide/supported-applications.html.
It is also being sunset: `https://aws.amazon.com/app2container/` now redirects to
the AWS Transform product page, and AWS closed it to new customers on 2025-11-07.
**Dismissed, it is not a hosting option at all.**

**Amazon ECS Express Mode** (announced 2025-11-21, VERIFIED
https://aws.amazon.com/about-aws/whats-new/2025/11/announcing-amazon-ecs-express-mode/).
The designated App Runner successor. It "orchestrates and configures all necessary
infrastructure: a Fargate-based ECS service with a unique accessible URL, load
balancer with SSL/TLS, auto scaling policies, monitoring, and networking
components", with no additional charge beyond the underlying resources. The
scaling knobs are `autoScalingMetric` with valid values
`AVERAGE_CPU | AVERAGE_MEMORY | REQUEST_COUNT_PER_TARGET`, plus `minTaskCount` and
`maxTaskCount` (VERIFIED,
https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ExpressGatewayScalingTarget.html;
whether `minTaskCount: 0` is accepted is **NOT STATED** on that page). Even if
zero were accepted, there is always an Application Load Balancer running at a fixed
hourly charge, and `REQUEST_COUNT_PER_TARGET` only produces a metric while a
target is registered, so it is not request-triggered wake. **Dismissed for our
purposes, and worth noting that AWS's own migration path away from its only
scale-toward-zero product leads somewhere with a hard always-on floor.**

**Amazon ECS Managed Instances** (announced 2025-09-30). EC2 underneath with a
management fee, existing to cover what Fargate cannot do (privileged containers,
eBPF agents, GPUs, more than 120 GB memory). No scale-to-zero. **Dismissed.**

---

## 4. The always-on VM question, worked properly

> Why not just run zeropg on a small always-on VM?

This is the strongest objection to the whole premise and it deserves a straight
answer rather than a defence.

### 4.1 The binding constraint is RAM per instance, and it is ~400 MB

MEASURED, and this is the number the entire section turns on:

| database size | process RSS | source |
|---|---|---|
| 7.7 MB | **381 to 398 MB** (PostgREST off) | [`../results/standalone-ram.jsonl`](../results/standalone-ram.jsonl), 2026-06-14 |
| 509 MB | **416 to 440 MB** | [`../results/e3b-memory.jsonl`](../results/e3b-memory.jsonl), 2026-06-12, n=15 across 1Gi / 2Gi / 4Gi tiers |

The floor is the PGlite WASM heap plus Node, and it is **roughly 400 MB whatever
the database size**. A 7.7 MB database and a 509 MB database cost within 10% of
each other in process memory. On Cloud Run the datadir bytes are *additionally*
charged to memory because the writable filesystem is tmpfs; on a VM with the
datadir on a real disk they are not.

So the honest density table, budgeting ~150 MB for the OS and leaving no swap:

| VM RAM | usable | zeropg instances **awake at once** |
|---|---|---|
| 0.5 GiB (t4g.nano) | ~360 MB | **zero.** One PGlite does not fit. |
| 1 GiB (e2-micro, t4g.micro) | ~870 MB | **one**, tightly, datadir on disk not tmpfs |
| 2 GiB (t4g.small) | ~1.9 GB | **three to four** |
| 4 GiB (CAX11) | ~3.9 GB | **eight to nine** |
| 8 GiB (t4g.large, CAX21) | ~7.9 GB | **sixteen to eighteen** |

Two consequences worth stating loudly:

- **A t4g.nano cannot run zeropg at all.** Every "just use a $3 VM" argument on
  AWS starts one instance size too small. The real floor is a t4g.micro at $6.13
  per month plus $0.64 for an 8 GB gp3 root volume.
- **Density is bounded by concurrent-awake instances, not by fleet size**, and
  only if you build a supervisor that starts a zeropg process on demand and stops
  it after idle. Without one, "awake at once" equals "in the fleet", and the VM's
  cost scales with fleet size exactly like Cloud Run's does. That supervisor is a
  worse Cloud Run, running on one box, with no isolation and a hard RAM ceiling.
  This is the load-bearing caveat in every VM-versus-serverless comparison and it
  is usually skipped.

### 4.2 The price table

All VERIFIED on 2026-07-28 against the URL given.

| host | spec | monthly | source |
|---|---|---|---|
| EC2 t4g.nano | 2 vCPU burst / 0.5 GiB | $3.07 + $0.64 disk = **$3.71** | AWS Price List, effective 2026-07-01, https://aws.amazon.com/ec2/pricing/on-demand/ |
| EC2 t4g.micro | 2 vCPU burst / 1 GiB | $6.13 + $0.64 = **$6.77** | same |
| EC2 t4g.small | 2 vCPU burst / 2 GiB | $12.26 + $0.64 = **$12.90** | same |
| EC2 t4g.small, 1-year RI no-upfront | same | $7.67 + $0.64 = **$8.31** | AWS Price List, effective 2026-07-27 |
| EC2 t4g.nano, 1-year RI no-upfront | same | $1.90 + $0.64 = **$2.54** | same |
| EC2 t4g.large | 2 vCPU / 8 GiB | ~$49.05 + disk | same |
| EC2 t4g.small **free trial** | 2 vCPU / 2 GiB, 750 h/month | **$0.64** (disk only), until **2026-12-31** | https://aws.amazon.com/ec2/instance-types/t4/ |
| GCP e2-micro | 2 vCPU shared / 1 GiB | **$6.11** list | https://cloud.google.com/products/compute/pricing/general-purpose |
| GCP e2-micro **Always Free** | same, 1 instance, us-west1 / us-central1 / us-east1, 30 GB pd-standard, 1 GB NA egress | **$0.00** | https://docs.cloud.google.com/free/docs/free-cloud-features, page updated 2026-07-21 |
| Hetzner CX23 | x86, cheapest shared plan | **EUR 5.49** (~$6.49) excl. IPv4 and VAT | https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ |
| Hetzner CAX11 | ARM Ampere, 2 vCPU / 4 GB / 40 GB | **EUR 5.99** (~$6.99) | same |
| Hetzner CAX21 | ARM, 4 vCPU / 8 GB | **EUR 10.49** (~$12.49) | same |
| Fargate ARM 0.25 vCPU / 2 GB, always on | | **$11.11** | section 3.2 |
| EKS control plane alone | | **$73.00** (or $438.00 in extended support) | https://aws.amazon.com/eks/pricing/ |

Note the June 2026 Hetzner price rise, effective 2026-06-15: CX11 no longer
exists, the cheapest x86 plan went from EUR 3.99 to EUR 5.49, and US CPX plans
rose about 3x. The old "Hetzner is 10x cheaper than AWS" line no longer holds at
the bottom of the range: a t4g.nano at $3.07 on-demand is cheaper in absolute
dollars than a CX23 at ~$6.49, though with 0.5 GiB instead of 4 GB and, per
section 4.1, too small to run zeropg.

The GCP Always Free e2-micro is the sharpest fact in the table. It is 1 GiB, which
is exactly one zeropg instance, and the allowance is "by time, not by instance"
per the free-tier page, so one VM running 24/7 is fully covered and two are not.

### 4.3 The comparison, on a model that reflects how billing actually works

"Idle 95% of the time" is the wrong axis, and
[../BREAK-EVEN.md](../BREAK-EVEN.md) §2 says why: **it is request spacing, not
request count, that bills.** Cloud Run reaps after roughly 15 idle minutes, so a
5-minute burst of traffic costs 20 minutes of instance time. A database touched
once every 15.1 minutes is awake 24/7 while doing nothing.

So the model here is: **200 sessions per month, each 5 minutes of activity**, one
cold start per session. That is a small internal tool or side project, roughly 6.7
sessions a day.

| stack | billable quantity | monthly, 1 DB |
|---|---|---|
| **Cloud Run** 1 vCPU / 2 GiB | 200 x (5 min + 15 min reaper) = **66.7 awake-hours** at $0.104/hr | $6.93 gross, **~$1.70** after the free grant (180,000 vCPU-s + 360,000 GiB-s) |
| **Lambda** 2,048 MB arm64 | 200 cold starts x ~12 s + 2,000 warm requests x 50 ms, all x 2 GB = **~5,000 GB-seconds** | $0.067 gross, **$0.00** (free tier is 400,000 GB-seconds) |
| **EC2 t4g.micro**, 1 GiB | 730 hours, always | **$6.77** |
| **GCP e2-micro Always Free** | 730 hours, always | **$0.00** |
| **Fargate ARM 0.25 vCPU / 2 GB** | you must keep it up, nothing wakes it | **$11.11** |
| **EKS + Knative** | control plane, always | **$73.00+** |

**The structural difference is the idle tail.** Cloud Run bills 20 minutes for a
5-minute session. Lambda bills the ~60 seconds it actually executed. That is a
200x gap on the same workload, and it is the single most interesting number in
this document. Lambda's weakness is the flip side of the same coin: it re-cold-
starts far more often, because the environment is reclaimed after an undocumented
idle period and, verbatim from the lifecycle page, "Lambda terminates execution
environments every few hours ... even for functions that are invoked
continuously". **Lambda trades user-visible latency for money, aggressively.**

### 4.4 Scaling to 10 and to 50 databases

Same model per database.

| fleet | Cloud Run | Lambda | one VM | notes |
|---|---|---|---|---|
| **1 DB** | ~$1.70 (mostly free grant) | **$0.00** | $0.00 on GCP Always Free, $6.77 on t4g.micro | everything is free; choose on latency and operations |
| **10 DBs** | 667 awake-hr x $0.104 = $69.4, less ~$5.2 grant = **~$64** | 50,000 GB-s, still free = **$0.00** | 1 x t4g.small 2 GiB = **$12.90** ($8.31 on a 1-yr RI); holds 3 to 4 concurrent, enough at 9% duty | VM beats Cloud Run 5x, loses to Lambda |
| **50 DBs** | 3,335 awake-hr x $0.104 = **~$342** | 250,000 GB-s, still free = **$0.00** | 1 x Hetzner CAX21 8 GB = **$12.49**, or t4g.large + 50 GB disk = **~$53**; holds 16 to 18 concurrent, needs a wake-on-demand supervisor | VM beats Cloud Run 6 to 27x; Lambda still free |
| **100 DBs** | ~$685 | 500,000 GB-s, 100,000 billable x $0.0000133334 = **$1.33** | needs 40 GB if all resident; with a supervisor, 2 x CAX21 = **$25** | you are now sharding VMs, i.e. building a control plane |
| **50 DBs, no supervisor** (all processes resident) | ~$342 | $0.00 | 50 x 400 MB = 20 GB, so r7g.xlarge at ~$156 or a 32 GB Hetzner box | **the VM's cost now scales with fleet size too** |

### 4.5 The crossover points, stated plainly

1. **At one database, cost is not the deciding factor and anyone who says
   otherwise is selling something.** Cloud Run's free grant, Lambda's free tier,
   GCP's Always Free e2-micro, and AWS's t4g.small free trial (through
   2026-12-31) all land at or near zero. The VM wins on latency, because it never
   cold-starts. Scale-to-zero wins on operations, because there is no box to
   patch, resize, or lose. **Pick on that, not on dollars.**

2. **Against Cloud Run, the VM wins from roughly the second or third database and
   never loses again**, because Cloud Run's cost scales linearly in fleet size
   (each database pays its own 15-minute idle tail) while a VM's cost is flat
   until RAM runs out. At 10 databases it is ~5x; at 50 it is 6 to 27x depending
   on whether you use Hetzner or AWS.

3. **Against Lambda, the VM never wins on cost below about 100 databases**,
   because 400,000 free GB-seconds a month is an enormous allowance for a workload
   that only executes during requests. The VM wins on cold start (zero versus 5 to
   15 seconds) and on the `Inactive`-after-weeks landmine.

4. **The VM's ceiling is real and it arrives early.** ~400 MB per awake instance
   means 2 GiB holds three to four and 8 GiB holds sixteen to eighteen. Past that
   you must build a wake-on-demand supervisor, at which point you have
   reimplemented the scheduler that Cloud Run and Lambda give you for free, on one
   box, without isolation. **The moment you write that supervisor, the "just use a
   VM" argument has conceded the design.**

5. **Where scale-to-zero wins on things a VM cannot buy at any price:**
   - **Isolation.** On a shared VM one tenant's runaway query OOM-kills its
     neighbours. Every zeropg instance being ~400 MB of WASM heap in one Linux
     memory cgroup is a real blast radius. On Cloud Run or Lambda each database is
     a separate sandbox.
   - **Peak concurrency.** A 8 GiB VM cannot serve 50 simultaneously-active
     databases at any price. Scale-to-zero does not care, because they are almost
     never simultaneously active, and it degrades to "pay for what you use"
     instead of "fail".
   - **The disk is not the database.** On a VM the datadir lives on an EBS volume
     you must snapshot, resize, and eventually lose. This is the actual claim
     zeropg makes, and it is a durability claim, not a cost claim.

6. **The honest summary of the premise.** For one to three databases the
   scale-to-zero machinery buys a hobbyist nothing they can measure, and an
   always-on VM is a completely reasonable answer that also has better latency.
   The pitch starts paying at fleet scale, at unpredictable duty cycles, and where
   isolation between databases matters. **The strongest version of the pitch is
   not "cheaper than a VM" - at small n it is not meaningfully cheaper, and at
   medium n a Hetzner box wins on raw dollars. It is "there is no box whose disk
   is the database".**

7. **And the shape this analysis actually argues for, which the project has never
   named: zeropg on an always-on VM.** Nothing about the engine requires
   scale-to-zero. Running `ZeroPGServer` on a t4g.small or an Always-Free e2-micro,
   with S3 or GCS as the durable home, gives bucket durability and zero cold start
   at the same time. You give up the "pay nothing while idle" line and keep
   everything else: no disk to manage, no snapshot job, restore-anywhere, and the
   lease still guards writership across a VM replacement. For one to ten databases
   that is probably the best configuration in this entire document, and it is
   currently undocumented.

---

## 5. Bottom line

**If you must run zeropg on AWS and want the Cloud Run experience, pick AWS
Lambda:** a container image, the Lambda Web Adapter as an external extension, a
Function URL, `ZeroPGServer` with `durability: 'strict'`, S3 as the store,
arm64, 2,048 MB of memory, and `/tmp` sized to roughly 3x the datadir.

Why, in order of decisiveness:

1. **It is the only AWS product that wakes on a request and holds it.** Fargate
   converts the first request after idle into a 503 and has done so for six years.
   Express Mode, Batch, Lightsail, and ECS Anywhere do not wake on requests at all.
   Only EKS with Knative or KEDA matches Lambda here, and it costs $73 per month
   to find out.
2. **It genuinely costs zero when idle**, which App Runner never did (`MinSize`
   minimum is 1, memory billed 24/7) and Fargate cannot (there is no idle state).
   On the model in section 4.3 it is free at 1, 10, and 50 databases.
3. **Our default durability mode already needs zero background CPU.** The freeze/
   thaw model that kills most stateful services is a non-issue for `strict`,
   because lease renewal is on the request path by design (`validateLease()`, "E4
   bet b: no background work") and WAL shipping is part of `commit()`.
4. **The pieces already exist.** `ZeroPGServer` is an HTTP server on `$PORT` with
   a `/ready` endpoint, which is LWA's contract verbatim. The S3 store is the
   existing `R2BlobStore` SigV4 driver with `AWS_ENDPOINT_URL_S3` and
   `AWS_REGION` set, since it already implements the conditional PUT
   (`If-None-Match: *` and `If-Match: <etag>`) the lease requires.

**The three things you must accept**, and they are not small:

- **`durability: 'strict'` only.** `interval` does not tick while frozen and
  `sleep` has a 300 ms shutdown budget. Every write pays an S3 round trip inline.
- **The lease is the sole writer guard, and takeover becomes routine.** Reserved
  concurrency 1 bounds in-flight requests, not environments, and AWS explicitly
  reserves the right to initialise environments speculatively. This is the biggest
  unvalidated correctness risk in the port.
- **A weekly keepalive is mandatory.** After "multiple weeks" without an
  invocation a container-image function goes `Inactive` and "Lambda rejects the
  first invocation". That is our exact target workload, so an EventBridge Scheduler
  ping is part of the recipe, not an optional extra.

**Runner-up: ECS on Fargate**, and only if you need a real `postgres://` TCP port.
The task's own ENI under `awsvpc` gives inbound raw TCP, which nothing else on
AWS offers us. You pay for it by writing the waker and by accepting that the first
request after idle fails.

**Explicitly out: App Runner** (closed to new customers as of 2026-03-31,
`MinSize` floor of 1, memory billed while idle, CPU throttled between requests,
two-writer window on every deploy). **Explicitly out: EKS** unless a cluster
already exists, on a $73 per month floor that never amortises against Lambda's
$0. **Explicitly out: Batch, Lightsail Containers, ECS Anywhere, App2Container,
Express Mode, Managed Instances**, each for the reasons in section 3.4.

**And the answer nobody asked for: for one to ten databases, an always-on
t4g.small or an Always-Free GCP e2-micro running `ZeroPGServer` against a bucket
is probably better than any of them.** Zero cold start, bucket durability, and
the lease still protects writership. The scale-to-zero pitch is an operations and
durability pitch, not a cost pitch, and it only becomes a cost pitch at fleet
sizes where one VM's RAM runs out.

---

## 6. Experiments worth running

Documentation cannot settle any of these. Each lists the setup and what result
decides what.

### E-A1: does Lambda actually freeze `setInterval`?

The doc says background callbacks "resume if Lambda reuses the execution
environment", which implies no wall-clock progress. Prove it, because it is the
one-line difference between `interval` being unusable and merely lossy.

```bash
# A container-image function whose handler returns the tick count and the
# wall-clock delta since the previous invoke.
#   let ticks = 0; setInterval(() => ticks++, 100)
#   handler: { ticks, nowMs: Date.now(), pid: process.pid, env: process.env.AWS_LAMBDA_LOG_STREAM_NAME }
aws lambda invoke --function-name zeropg-freeze-probe /dev/stdout
sleep 60
aws lambda invoke --function-name zeropg-freeze-probe /dev/stdout
```

**Decides:** if `ticks` advanced by roughly 600 across the 60-second gap, timers
run while "frozen" and `durability: 'interval'` is viable. If it advanced by
roughly 0 while `nowMs` advanced by 60,000, the freeze is total and `strict` is
mandatory. Also record whether `pid` and the log stream name are unchanged, which
tells you the environment was reused rather than replaced.

### E-A2: does the Init phase overrun, and does the restore run twice?

```bash
# Container image running ZeroPGServer at 2048 MB, /tmp 3072 MB, arm64,
# ZEROPG_POSTGREST=off, durability strict, a 500 MB datadir already in S3.
# Invoke once cold, then read the INIT_REPORT line:
aws logs filter-log-events \
  --log-group-name /aws/lambda/zeropg-init-probe \
  --filter-pattern 'INIT_REPORT'
```

Run it twice: once with `AWS_LWA_ASYNC_INIT` unset, once with
`AWS_LWA_ASYNC_INIT=true`. Count `GetObject` calls against the bucket prefix over
each cold start (S3 server access logging or a CloudTrail data event).

**Decides:** an `INIT_REPORT ... Status: timeout` line plus a doubled GetObject
count confirms the restore runs twice and is billed twice, which makes
`AWS_LWA_ASYNC_INIT=true` mandatory and makes the memory tier a correctness knob
rather than a performance one. If async init makes the timeout disappear, that is
the recipe. If async init causes LWA to forward requests before `/ready` returns
200, that is a bug we need to route around.

### E-A3: is reserved concurrency 1 any kind of writer fence?

The most important experiment in this document.

```bash
aws lambda put-function-concurrency \
  --function-name zeropg-fence-probe --reserved-concurrent-executions 1

# 1. Burst: 2 requests 50 ms apart, repeated for an hour. Log
#    AWS_LAMBDA_LOG_STREAM_NAME and the ZeroPG fencingToken from /metrics
#    on every response.
# 2. Idle: leave 20, 40, 60 minutes between single invocations for 12 hours.
# 3. Grep CloudWatch for distinct log streams and for 423 responses.
```

**Decides:** if two distinct log streams ever serve overlapping wall-clock
windows, reserved concurrency is not a fence and the lease is load-bearing on
Lambda in a way it has never been anywhere else. Count how often a 423
(`FencedError` / `LockedError`, `server.ts:439`) reaches a caller: if it is more
than a handful per day, the client library needs an automatic
re-wake-and-retry on 423 before Lambda can be recommended. If a *speculatively
initialised* environment ever appears with no request to explain it, record it,
because that environment ran a restore and took the lease for free.

### E-A4: the Lambda cold-start ladder

```bash
# For memory in 1024 1769 3538 5308, and datadir in 10MB 500MB:
#   publish a new version (forces a cold environment), then time
#   curl -w '%{time_total}' https://<url-id>.lambda-url.us-east-1.on.aws/sql
# 10 reps each. Read Init Duration and Duration from the REPORT lines.
```

**Decides:** the memory tier to recommend, and whether Lambda's cold start is
within a factor of two of our measured Cloud Run 3.5 to 12.3 s
([COLDSTART-MODEL.md](COLDSTART-MODEL.md)). Since 1,769 MB is one vCPU and the
restore is CPU-bound, expect the 3,538 MB tier to roughly halve the 500 MB restore
against the 1,769 MB tier; if it does not, the restore is S3-bandwidth-bound and
the memory dial is the wrong knob.

### E-A5: the `Inactive` state

Deploy a container-image function, invoke it once, then **do not touch it for four
weeks** (no monitoring, no keepalive, no console visit). Then invoke.

**Decides:** whether the first invocation is genuinely rejected and with what
error. If it is, a weekly EventBridge Scheduler ping is mandatory in the recipe
and must be documented as such. This costs nothing to run in parallel with
everything else; it only needs patience and a calendar reminder.

### E-A6: does Lambda's `/tmp` count against the memory limit?

```bash
# Memory 2048 MB, ephemeral storage 3072 MB, restore a 500 MB datadir into
# /tmp, then in the handler report:
#   process.memoryUsage().rss, and the output of statfs('/tmp'),
#   and the REPORT line's "Max Memory Used".
```

**Decides:** whether Lambda inherits Cloud Run's "datadir bytes are memory bytes"
rule or Fargate's "datadir is separate disk" rule. If `/tmp` is separate, database
size decouples from the memory tier and the whole memory-tier table in
[../BREAK-EVEN.md](../BREAK-EVEN.md) improves for AWS. This changes the
recommended sizing materially and is cheap to answer.

### E-B1: our own Fargate task-launch distribution

Settles the 20-to-60-second folklore with a number we own.

```bash
# Register a task definition with the zeropg image, 0.5 vCPU / 2 GB ARM,
# then 20 times:
aws ecs run-task --cluster zeropg-probe --task-definition zeropg-probe:1 \
  --launch-type FARGATE --network-configuration '...'
# and for each task ARN:
aws ecs describe-tasks --cluster zeropg-probe --tasks <arn> \
  --query 'tasks[0].{created:createdAt,pullStart:pullStartedAt,pullStop:pullStoppedAt,started:startedAt}'
```

**Decides:** the real distribution of `createdAt` to `startedAt`, split into pull
time and the rest. If pull dominates and the image is over 250 MiB compressed,
re-run with a SOCI index (ECR private, gzip or uncompressed layers, index manifest
v2) and report the delta. If the total is under 10 seconds, the previous
document's Fargate verdict needs softening on latency even though the
scale-from-zero gap stands.

### E-B2: confirm tmpfs is rejected on Fargate

```bash
aws ecs register-task-definition \
  --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 512 --memory 2048 \
  --container-definitions '[{"name":"db","image":"...","linuxParameters":{"tmpfs":[{"containerPath":"/data","size":1024}]}}]'
```

**Decides:** replaces the current three-pages-disagree situation with a real API
error string. Takes two minutes and settles a fact that three AWS doc pages
contradict each other on.

### E-B3: S3 conditional-PUT conformance against the existing driver

The lease needs `If-None-Match: *` and `If-Match: <etag>`. `R2BlobStore` already
implements both and is a generic SigV4 S3 client, so real S3 may need no driver
work at all.

```bash
AWS_ENDPOINT_URL_S3=https://s3.us-east-1.amazonaws.com \
AWS_REGION=us-east-1 \
AWS_BUCKET=zeropg-cas-probe \
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  <the existing CAS conformance suite that writes results/cas-conformance.jsonl>
```

**Decides:** whether the S3 path is free. Watch specifically for the R2 weak-etag
quirk documented at
[`../packages/blobstore/src/r2.ts:119`](../packages/blobstore/src/r2.ts): R2
returns `W/"<hash>"` on GET where LIST and PUT return `"<hash>"`, and the driver
strips the `W/` prefix. If real S3 returns strong etags everywhere, that stripping
is harmless; if S3 behaves differently on multipart-uploaded objects (whose ETags
are not MD5 and carry a `-<partcount>` suffix), the CAS path needs a look. Also
records whether S3's `casStrength` should stay `'etag'` or be upgraded now that S3
has native conditional writes.

### E-C1: real VM density

Section 4.1's density table is extrapolated from a 400 MB RSS measurement. Measure
it directly.

```bash
# On one t4g.small (2 GiB), start N ZeroPGServer processes, each with its own
# 50 MB datadir on the EBS volume, N = 1..8. After each start, record
# `free -m`, the per-process RSS, and whether any process was OOM-killed
# (dmesg | grep -i 'killed process'). Repeat with the datadirs on a tmpfs.
```

**Decides:** the numbers in section 4.4 and therefore the crossover points. If the
real density is materially better than 400 MB per instance (for example if the
WASM heap is largely shared or lazily committed), the VM argument gets stronger
and this document should say so. If it is worse, the fleet-on-a-VM idea dies at 2
GiB.

### E-C2: prove the in-process embed end to end

The single-container correction in section 1 is verified against the source but
has never been run.

```bash
# ~30 lines: import { ZeroPG } from '@zeropg/objectstore-fs', open it against an
# S3 bucket via R2BlobStore, and serve an Express app from the same process that
# queries it with db.query(). No second process, no TCP, no supervisord.
```

**Decides:** three things at once. Whether topology (a) actually works today;
whether the event-loop blocking documented in
[WIRE-AUTH-DECISION-2026-07-28.md](WIRE-AUTH-DECISION-2026-07-28.md) is severe
enough to make topology (b) the default recommendation; and whether
`connect('s3://...')`, which currently throws at
[`../packages/client/src/index.ts:92`](../packages/client/src/index.ts), is worth
wiring. It also produces the code snippet this document should ship, since the
single-container claim is currently a source-reading rather than a demo.
