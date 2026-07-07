# Fleet admin: every zeropg you have, from one CLI (and a local console)

`zeropg fleet` manages all your Postgres instances - deployed scale-to-zero
services across any number of cloud accounts, plus the local datadirs on this
machine - from your laptop. `zeropg console` puts the same inventory in a
browser tab on localhost, and can launch the zeroSupabaseStudio admin UI
against any of them.

Design stance (the constraints came first):

- **No hosted service, ever.** Nothing here is run *for* you. The CLI and the
  console are code you run yourself, against your own cloud credentials. There
  is no account, no signup, no maintainer-operated anything.
- **No registry.** The clouds themselves are the source of truth. Fleet state
  is *discovered live*: any Cloud Run service carrying `ZEROPG_BUCKET` /
  `ZEROPG_PREFIX` env vars (or a `zeropg` label - `scripts/deploy.sh` now sets
  one) is a zeropg instance. Nothing is stored that can drift. The motivating
  bug: the nightly-reset job hardcodes an 11-service inventory while `fleet ls`
  discovers 17 live services in the same project.
- **The orchestrator is your local agent.** The original idea sketch had an
  "infrastructure orchestrator node" holding cloud service-account keys that a
  local CLI talks to. We deliberately did not build it: it is a second trust
  boundary, a credential store to secure, and a service someone must keep up -
  and it adds nothing an AI agent with a local CLI and ambient credentials
  (`gcloud auth`) does not already have. Every command takes `--json` so an
  agent can operate the whole fleet with shell calls.
- **Migration is a connection string, not a vendor API.** `fleet migrate`
  streams `pg_dump | psql` into any Postgres you provisioned (Cloud SQL, Neon,
  Supabase, RDS, a box under your desk). No provisioning SDKs to maintain, no
  vendor keys to hold. See [GRADUATION.md](GRADUATION.md) for the underlying
  runbook and caveats.

## Contexts: places to look, not a database list

```
zeropg fleet context add gcp-main --project my-project --region europe-west1
zeropg fleet context add gcp-side --project other-account-project --region us-central1
```

Saved in `~/.config/zeropg/contexts.json` (override the directory with
`$ZEROPG_CONFIG_DIR`). A context is provider + project + region; credentials
come from the ambient `gcloud` auth (ADC). Aggregating "multiple free-tier
cloud accounts" is just adding more contexts. One-off scans need no config:
every command accepts `--project X --region Y` directly.

Provider support today: GCP Cloud Run. The provider surface is deliberately
narrow (list services, read env, wake a URL, roll a revision), so IBM Code
Engine / Fly.io ports are additive work, not a redesign.

## Commands

All take `--json` (agent-friendly: the output includes ready-to-use endpoint
URLs, not just names) and `--context <name>` or `--project/--region`.

```
zeropg fleet ls                       every instance, live-discovered; never wakes anything
zeropg fleet local                    local datadirs this machine has opened
zeropg fleet inspect <service>        bucket manifest: last commit, count, stored bytes - NO wake
zeropg fleet peek <service>           table-name hints + exact size from a bucket snapshot - NO wake
zeropg fleet status <service>         health probe + IAM exposure posture (wakes it)
zeropg fleet wake <service>           wake and wait until ready
zeropg fleet url <service>            all endpoints (base, /sql, /rest, /wake, bucket)
zeropg fleet export <service> --out dump.sql
zeropg fleet migrate <service> --to <postgres-url> --yes
zeropg console [--port 4900]          local web view over the same inventory
```

## Learn about a db without starting it, and remember it

Everything durable is in the bucket, so you can learn a lot without waking the
Cloud Run service (no cost on the service, no cold start):

- **`fleet inspect`** / console **"learn more (no wake)"**: one GET of
  `manifest.json` plus a `list()` of the prefix - last commit time, commit
  count, generation, and total bytes stored. Cheap.
- **`fleet peek`** / console **"peek tables (no wake)"**: materialize a
  read-only `ZeroPGReplica` from the bucket (local restore, seconds; the remote
  service is never touched) and read exact db size + public table-name hints
  (by `pg_class` oid order, a proxy for creation order). A badly named db still
  shows what it holds - `privatebin-zeropg` -> `privatebin_paste`,
  `privatebin_comment`, `privatebin_config`.

The console **remembers** what it learns in `~/.zeropg/instance-stats.json`
(keyed by the durable bucket/prefix): last known size, last probe/wake time,
last startup duration, and the table hints. Each card shows it as a grey
`memory:` / `tables:` line straight from cache - visible before you touch
anything - and probe/wake/inspect/peek refresh it. All best-effort: a stats
failure never breaks an action.

App services fronting zeropg (PrivateBin, NocoDB, ...) serve their own app on
the public port, not the zeropg control face, so `fleet status` reports them as
"serving (app service)" rather than pretending to read DB metrics over HTTP -
use `inspect`/`peek`/the studio snapshot to see inside their data.

## Local databases: open-breadcrumbs

Local zeropg databases are PGlite datadirs scattered across project folders
(`.zeropg/dev`, `pgdata`, ...) - historically unfindable once you forget where.
Now every successful local open (`connect('file:...')`, `serveWire`, `zeropg
run`) drops ONE line into `~/.zeropg/opens.jsonl`:
`{"path": "...", "cwd": "...", "at": "..."}` - the same moment the datadir lock
is taken, so it adds no new I/O class. Contract (see
`packages/client/src/breadcrumb.ts`): it can never fail or slow an open (every
error swallowed), `ZEROPG_NO_BREADCRUMB=1` opts out, the writer only appends
(crash-safe), and the reader dedupes by path and compacts the file past ~64KB
so it stays tiny forever.

`zeropg fleet local` and the console's "local" group list these with
last-opened time, the project dir they were used from, and whether the datadir
still exists. In the console every present local DB has two one-click actions:

- **serve**: stands up a loopback wire (`serveWire`) on the datadir and shows a
  **direct connections** block - the same live endpoint in every format a tool
  wants: `uri`, a ready-to-paste `psql "..."` command, a `jdbc:postgresql://...`
  URL, and a `DATABASE_URL=...` line for a `.env`. Each has its own copy
  button. Stop it from the same card.
- **open in studio**: see below.

`~/.zeropg` is now the single zeropg home dir; `contexts.json` moved there
(the old `~/.config/zeropg/contexts.json` is still read as a fallback).

## Studio bridge: inspect any database in one click

zeropg Console (`examples/cloudrun/supabase/studio` - table editor, SQL
editor) attaches to a Postgres wire. The console can mint a wire for anything
it lists, so every row has an "open in studio" button:

- **local datadir** - served via `serveWire`; studio edits the real database.
- **remote instance** - a `ZeroPGReplica` materialized from the instance's
  bucket: **no lease, no fencing, the live service is untouched** (verified:
  the live demo kept answering writes while its snapshot was open). It is a
  detached throwaway copy, so poking at it - even writing - is
  consequence-free; relaunch to refresh the snapshot.

**No Docker, at all.** The whole studio stack is plain node processes on
loopback: the wire, postgres-meta, and the studio BFF. postgres-meta runs from
the npm `@supabase/postgres-meta` package - but via `lib/meta-server.mjs`,
which `build()`s and listens the package's **main introspection app only**.
The package's own `server.js` also starts an "admin" app on `PG_META_PORT+1`
and `process.exit(1)`s if that port is taken (harmless as root on `:1` inside
the Docker image, a landmine as a node child); the studio never calls it, so
skipping it removes both the second process-killer and the need to reserve a
`+1` port. Ports are OS-assigned per launch, so a concurrently running
up-local studio stack is never trampled. Launch is ~0.85-1.3s; cost while a
studio is open is ~200 MB postgres-meta + ~100 MB BFF (both Node), torn down
on stop.

One studio at a time; the console banner shows the URL + admin password and a
stop button. Requirement: a zeropg repo checkout (studio is not shipped in the
npm CLI).

Footprint note: the ~200 MB is postgres-meta (a Node/fastify service) - the one
heavy dependency here. A future direction for a genuinely tiny inspector is to
drop postgres-meta and run the handful of introspection queries directly (the
BFF already only forwards SQL), which also opens the door to a Go/Rust rewrite.
postgres-meta *can* serve any wire via a per-request `pg` connection header
(which would let one instance be reused across launches), but its introspection
endpoints error on that header today, so the reuse path is not wired up.

`status` prominently reports exposure: zeropg has **no built-in auth** (the
protection model is platform ingress/IAM), so a service with an `allUsers`
invoker binding is an open SQL endpoint. The console shows the same warning.

## How export/migrate work (and the write-loss trap they avoid)

The Postgres wire port is loopback-only on Cloud Run, so dumps do not go
through the service. Instead the CLI boots the database *locally* from its
bucket - the same lease-takeover mechanism the nightly reset uses - serves a
loopback wire, and runs a stock `pg_dump` (>= the PGlite major) against it.
`migrate` pipes the dump straight into `psql --set ON_ERROR_STOP=1` toward the
target URL; nothing is buffered on disk. Afterwards the service is rolled so
the fenced cloud instance restarts cleanly (`--no-roll` to skip).

The trap (live-verified while building this): with `sleep` durability an awake
instance holds committed writes in memory, and its lease lapses while idle -
there is no background renewal. Taking the lease in that window fences the
instance, its eventual shutdown flush is rejected (`shutdown-flush-failed`,
`lostPendingWrites=True` in the logs), and those writes are gone. Rolling
first does not help: the new revision boots and steals the lease before the
old instance's SIGTERM flush runs (also verified). Note this window is not
specific to the fleet CLI - any redeploy of a sleep-durability service that is
awake with unflushed writes drops them.

So the CLI **quiesces first**: `POST /flush` on the live instance commits its
pending state to the bucket before the takeover (verified: a row inserted
seconds before an export shows up in the dump). On images that predate
`/flush`, the CLI refuses to proceed while `/metrics` reports
`pendingFlush: true` rather than silently dropping writes -
`--accept-data-loss` is the explicit override, and sleeping or still-booting
instances are safe by construction.

## The console is localhost-only, on purpose

`zeropg console` binds `127.0.0.1` and there is no flag to widen it. It can
wake and inspect every database your credentials reach, and zeropg instances
have no auth layer of their own - a network-exposed console would need a real
auth/RBAC story, which is product territory this research project deliberately
stays out of. If you want it on another machine, that is what `ssh -L` is for.

Data browsing / SQL editing is out of scope for the console (separate work).

## Not built, on purpose

- Stored inventory/registry (drifts; discovery is the truth)
- Hosted control plane or "orchestrator node" (second trust boundary, someone
  must run it)
- Vendor provisioning APIs for Neon/Supabase/Cloud SQL (maintenance treadmill;
  `--to <url>` is universal)
- Password/token rotation - zeropg has no auth to rotate yet; if bearer-token
  auth lands on the HTTP face later, `fleet rotate-token` becomes a small env
  var update + roll via the already-present provider surface

## Console/inspector unification (decided 2026-07-07, step 1 done)

The cloud inspector (`examples/cloudrun/inspector`) and the local console grew
the same organs independently. Direction: the inspector should become
`zeropg console --inspector` - one codebase, two trust modes - rather than a
separate app.

- **Done (step 1):** the replica-wire manager is ONE implementation,
  `packages/cli/src/console/replica-wire.mjs` (openReplicaWire +
  createReplicaManager with the LRU memory cap). The console's serveReplica
  and the inspector both use it; the inspector's deploy.sh vendors the file
  into its build context (the copy is gitignored - edit the source only).
- **Pending (the mode merge):** auth as pluggable middleware (none/loopback ->
  bearer token -> IAP), live fleet discovery in the cloud instead of the
  baked targets secret, pgweb + Adminer adapters available on both surfaces,
  and a STRUCTURAL capability matrix - inspector mode never registers
  write/wake/export routes (not if-guards inside handlers). Read-write local
  serving must never ship in any wide-bound mode.
- Deploy gotcha captured in deploy.sh: `gcloud run services replace` with an
  unchanged `:latest` spec does NOT roll a revision - images are pinned by
  digest at deploy time (same lesson as the zeropocket demo).
