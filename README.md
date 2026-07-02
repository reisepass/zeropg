# zeropg

**Postgres that costs zero when nobody's using it.**

zeropg is a **research project** built to spread one idea:

> **You can have a real Postgres database with zero idle cost today, if you accept
> migrating to a normal Postgres once you outgrow it.** And because it is real Postgres
> the whole time, "migrating" is `pg_dump | pg_restore` and one connection-string change.

No database server, no volume, no managed-Postgres bill. A real Postgres
([PGlite](https://pglite.dev): Postgres compiled to WASM) runs on scale-to-zero compute
(Cloud Run, Code Engine, anything similar) and its durable home is a plain
object-storage bucket. A single writer is enforced by a lease built on the bucket's own
conditional writes, with fencing tokens making zombie writers physically unable to
commit. While idle, the whole thing costs the bucket bill: cents per month.

Think: **Litestream, but for Postgres**, with durability semantics you pick per workload.

This is not a product. It is working code, live demos, and a JSONL of evidence for every
number below, so you can judge the idea for yourself and steal any part of it.

## Why (the default-database problem)

New projects default to SQLite because Postgres means a server, and a server means a
bill and an ops surface. But the day the project grows, the SQLite dialect, types, and
single-file model have to be translated away. zeropg is the experiment in removing that
trade-off:

```
memory://          in-process Postgres, for tests
file://./dev.db    local Postgres in a directory, for dev (cross-process lockfile included)
gs://my-bucket     scale-to-zero Postgres in YOUR bucket, for the idle-95%-of-the-day phase
postgres://...     a normal always-on Postgres, when you outgrow all of this
```

One `connect(DATABASE_URL)` interface ([`@zeropg/client`](packages/client), on npm)
covers the whole ladder; only the URL changes. The rungs that matter here are the middle
ones. When to step off the ladder, and how: [docs/GRADUATION.md](docs/GRADUATION.md)
(roughly: at ~0.5GB of data, sustained concurrent writes, or >4-5 awake-hours/day).

## See it live (real cold starts, scale to zero)

Every service below runs with `min-instances=0`. First load after ~15 idle minutes is a
**real cold start**: the instance wakes from literal zero, restores Postgres out of a
bucket, and serves. Each demo page shows whether your request hit cold or warm and the
full boot breakdown.

### The database alone

| demo | platform + storage | DB size | cold start (measured) |
|---|---|---|---|
| [zeropg-demo-1mb](https://zeropg-demo-1mb-71428757273.europe-west1.run.app) | Cloud Run + GCS | 10 MB | 3.8s / 4.7s (p50 / p99, 20 forced cold starts) |
| [zeropg-demo-50mb](https://zeropg-demo-50mb-71428757273.europe-west1.run.app) | Cloud Run + GCS | 52 MB | 3.5s / 4.3s |
| [zeropg-demo-500mb](https://zeropg-demo-500mb-71428757273.europe-west1.run.app) | Cloud Run + GCS | 501 MB | 11.2s / 12.3s |
| [zeropg-demo-tigris](https://zeropg-demo-tigris-4sowr32yyq-ew.a.run.app) | Cloud Run + Tigris | ~5 MB | ~3.9s |
| [zeropg-demo-r2](https://zeropg-demo-r2-4sowr32yyq-lm.a.run.app) | Cloud Run + Cloudflare R2 | ~5 MB | ~5.4s |
| [zeropg-demo (IBM)](https://zeropg-demo.2b2pxs7e2mxy.eu-de.codeengine.appdomain.cloud) | IBM Code Engine + COS | ~5 MB | ~15s (Code Engine's scheduling floor) |
| [zeropg-standalone](https://zeropg-standalone.2b2pxs7e2mxy.eu-de.codeengine.appdomain.cloud) | IBM Code Engine + COS | ~5 MB | dedicated Postgres + PostgREST auto-API over HTTP |

Same codebase, one S3 transport, four object-storage backends live behind it (GCS, IBM
COS, Tigris, R2), selected by environment at boot with no per-provider code. The lease,
fencing, manifest-CAS commit, and streaming restore are identical on all four.

Two buttons on the demo pages let you drive it: **put to sleep** streams the flush +
lease-release steps and exits the instance so your next reload is a guaranteed cold
start; **run TPC-C benchmark** streams a standard OLTP benchmark live against the
database. Leave a note; it persists in the bucket across scale-to-zero.

### Real apps on it (unmodified, DB in a GCS bucket)

The finding that surprised us most, quantified in
[docs/COLDSTART-MODEL.md](docs/COLDSTART-MODEL.md):
**cold start ≈ zeropg restore (~3.5-5s for small DBs) + the app's own boot weight.**
A static Go binary boots in milliseconds, so its cold start IS the restore. Heavy Node
frameworks pay their own 20-35s on top. The fast tier:

| app | what it is | cold start | live | source |
|---|---|---|---|---|
| **webhookx** | webhook gateway (Go), first needs-Redis app: valkey sidecar scales to zero with it | ~4-5s | (not public) | [examples/cloudrun/webhookx](examples/cloudrun/webhookx) |
| **httpbin + requestbin** | our own request-echo + capture bins (Go), TTL retention built in | Go-tier | [httpbin-ui-scale-to-zero.0rs.org](https://httpbin-ui-scale-to-zero.0rs.org) | [examples/cloudrun/httpbin](examples/cloudrun/httpbin) |
| **cocoon** | a Bluesky-compatible AT Protocol PDS (Go, GORM+pgx). Your own PDS, DB in a bucket | ~5s (rarely cold: real AT-Proto traffic keeps it warm) | [pds-scale-to-zero.0rs.org](https://pds-scale-to-zero.0rs.org) | [examples/cloudrun/pds](examples/cloudrun/pds) |
| **PrivateBin** | encrypted pastebin (PHP) | ~5s | [privatebin-scale-to-zero.0rs.org](https://privatebin-scale-to-zero.0rs.org) | [examples/cloudrun/privatebin](examples/cloudrun/privatebin) |
| **supabase (stripped)** | self-hosted PostgREST + GoTrue + RLS on the zeropg wire, driven by supabase-js | ~5-8s | [supabase-scale-to-zero.0rs.org](https://supabase-scale-to-zero.0rs.org) | [examples/cloudrun/supabase](examples/cloudrun/supabase) |
| **airtable-style** | rows-as-JSONB grid app (Go + tiny SPA) | ~8s | [airtable-scale-to-zero.0rs.org](https://airtable-scale-to-zero.0rs.org) | [examples/cloudrun/airtable](examples/cloudrun/airtable) |
| **znostr-relay** | our ~330-line NIP-01 nostr relay, no Redis, DB is the only state | fast (Go-tier) | wss://znostr-zeropg-71428757273.europe-west1.run.app | [examples/cloudrun/nostr](examples/cloudrun/nostr) |

And the "it also runs" tier: heavyweight Node/Next.js apps that work unmodified but pay
their own boot on every wake. They are compatibility proof, not showcases:
**NocoDB** (~34s cold, 124 self-bootstrapped tables,
[live](https://nocodb-scale-to-zero.0rs.org)), **Rallly** (21-36s, 130 Prisma
migrations, [live](https://rallly-scale-to-zero.0rs.org)), **Documenso** (~30s, 162
migrations, Prisma native query engine, [live](https://documenso-scale-to-zero.0rs.org)),
**nostream** (~14.5s, with a scale-to-zero Redis sidecar). Cal.com ran too but was
dropped from the live set (>120s cold start; code stays in
[examples/cloudrun/calcom](examples/cloudrun/calcom)).

**The only change per app** (the app image is the official one, untouched):

1. Replace the `postgres:` service with the **`zeropg-db` sidecar**: a
   [22-line Dockerfile](examples/cloudrun/zeropg-db/Dockerfile) +
   [server.mjs](examples/cloudrun/zeropg-db/server.mjs) serving the Postgres wire on
   `127.0.0.1:5432` with the bucket as its durable home
   ([zeropg-db](examples/cloudrun/zeropg-db), or
   [zeropg-db-migrate](examples/cloudrun/zeropg-db-migrate) to also apply the app's real
   migrations on first boot).
2. Point the app's `DATABASE_URL` at `127.0.0.1:5432`.
3. Check [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for your driver (one DSN param for
   Go pgx apps; Rust sqlx/Diesel are blocked; Prisma runs but its migrate engine must
   let the sidecar own migrations).

Full compatibility findings across 880 real migrations and 8+ apps:
[docs/POSTGRES-APP-COMPAT.md](docs/POSTGRES-APP-COMPAT.md).

## How a database with no server works

```
            ┌────────────── Cloud Run / Code Engine / etc ──────────────┐
   request →│  your app ── SQL ──> PGlite (Postgres-in-WASM, in-proc)   │
            │                        │ datadir on /tmp                  │
            └────────────────────────┼───────────────────────────────────┘
                 boot: restore       │ commit: WAL ship / snapshot
                 (streamed)          ▼ (streamed)
            ┌───────────────── GCS / R2 / S3 / COS bucket ──────────────┐
            │  manifest.json   ← conditional PUT = THE commit           │
            │  lease.json      ← single writer, fencing tokens          │
            │  generations/<id>/…  WAL segments + snapshots (immutable) │
            └────────────────────────────────────────────────────────────┘
```

- **Cold start**: stream the snapshot out of the bucket (parallel ranged GETs → gunzip →
  untar → `/tmp`) and open PGlite on it. Nothing buffers in memory: a 500 MB database
  restores with ~23 MB of JS heap. PGlite faults pages lazily, so "open" is ~0.7s at any size.
- **Commit**: ship only the WAL byte range the commit appended (Litestream's trick,
  Postgres edition): one immutable object, a few hundred bytes for a one-row insert,
  then one conditional PUT of `manifest.json`. That CAS **is** the commit: crash anywhere
  before it and the old state is untouched; after it, the new state is durable. Torn
  states are impossible by construction. Measured live: WAL scan 1.3ms + upload 79ms +
  manifest CAS 97ms. Full snapshots are just a compaction artifact (and a rolling backup).
- **Single writer**: `lease.json` is created with if-absent semantics and carries a
  monotonic fencing token. Takeovers stamp their token into the manifest immediately, so
  a zombie's next commit fails instantly. Verified live with two rival Cloud Run services
  fighting over one bucket.
- **Adaptive codec**: if a sample of the data doesn't compress (media, encrypted blobs),
  snapshots ship as raw tar. A serverless vCPU gzips at ~12 MB/s while the NIC moves
  100+ MB/s.

## Durability is a dial

| mode | write latency (measured, 50 MB DB) | loss window on crash |
|---|---|---|
| `strict` | ~0.2s (ships only the WAL bytes the commit appended) | zero: ack ⇒ in the bucket |
| `interval` | ~0.15s | ≤ flush interval (Litestream-style) |
| `sleep` *(demo default)* | ~0.15s | since last flush; flushes on SIGTERM + after 25s idle |

`sleep` is the serverless-native mode: writes run at memory speed while traffic flows,
and one flush happens when the platform puts the instance to sleep. This is the same
bargain Litestream and every object-storage-backed database makes; zeropg makes the
window explicit and keeps durability work off the request path by default (the one
per-instance-life expensive write, the post-cold-start WAL re-baseline, rides a
background flush too: [V1-WAL-SHIPPING.md](V1-WAL-SHIPPING.md) has the byte-level
forensics of why cross-life WAL splicing is unsound).

Two provider realities are engineered around (see [COST-MODEL.md](COST-MODEL.md)): GCS
caps sustained writes per object name at ~1/s (measured: 52% rejections beyond it), so
back-to-back strict commits group-commit (measured: 10 concurrent writes → 1 manifest
CAS); and clean 429/5xx rejections retry with backoff in the driver.

## Use it

```ts
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, ZeroPGReplica } from '@zeropg/objectstore-fs'

const store = new GcsBlobStore({ bucket: 'my-bucket', prefix: 'apps/guestbook' })

// The writer: holds the lease, owns the commit path.
const db = await ZeroPG.open({ store, durability: 'sleep' })
await db.exec('CREATE TABLE IF NOT EXISTS notes (id serial, body text)')
await db.query('INSERT INTO notes (body) VALUES ($1)', ['hello bucket'])
await db.close() // flushes + releases the lease

// A read replica: leaseless, polls the manifest, converges in seconds.
const replica = await ZeroPGReplica.open({ store, pollIntervalMs: 5000 })
const { rows } = await replica.query('SELECT * FROM notes')
```

All packages are on npm (`@zeropg/client`, `@zeropg/server`, `@zeropg/blobstore`,
`@zeropg/lease`, `@zeropg/objectstore-fs`). Runnable examples in
[`examples/`](examples/). Operational tools: `scripts/branch.ts` (server-side database
fork: 500MB in 0.34s), `scripts/backup.ts` / `scripts/restore-backup.ts` (cold backups
to a second bucket), `scripts/gc.ts`, `scripts/deploy.sh` (the Cloud Run recipe behind
the live demos).

## Status: research, evidence-first

This is a working v0 on real infrastructure, built experiment-first: every claim above
traces to a JSONL in [`results/`](results/). It is not a managed service and nobody
should run their checkout path on it. The full scoreboard and the 14-bug live-fire
ledger (including a silent-data-loss WAL continuity bug found and regression-tested) are
in [STATUS.md](STATUS.md).

| experiment | claim | result |
|---|---|---|
| E0 primitives | GCS conditional writes are a correct CAS | ✅ 0 double-winners in 2,000 races |
| E1 lease | acquire/renew/takeover/fencing correct under contention | ✅ |
| E2/E2b/E2c | byte-identical reopen; SIGKILL at every commit fault point → never torn; incremental WAL shipping | ✅ strict commit p50 134ms |
| E2d replicas | leaseless followers converge across segments + compactions | ✅ |
| E3/E3b | cold-start distributions; memory tiers (500MB DB runs in 1GiB) | ✅ |
| E4 | live lifecycle hazards: revision switches, SIGTERM flush, zombie fencing | ✅ |
| E6 | cold-backup disaster matrix (crash mid-backup, full primary wipe → byte-identical rebuild) | ✅ |
| E5 soak + cost | 72h realistic traffic, reconciled against the real bill | pending (cost numbers are modeled from measured constants) |

## Limits, cost, exit

- **[docs/LIMITATIONS.md](docs/LIMITATIONS.md)**: the one-page truth table. One writer;
  single-session wire (sqlx/Diesel blocked, pgx needs one DSN param, Prisma migrate
  can't run); must fit in memory; extensions must be preloaded; cold starts are real.
- **[BREAK-EVEN.md](BREAK-EVEN.md)**: when the bucket bill beats managed Postgres.
  Rule of thumb on GCP: zeropg wins below ~4-5 awake-hours/day; an app idle 80%+ of the
  day is 5-20x cheaper. It is request spacing, not request count, that bills.
- **[docs/GRADUATION.md](docs/GRADUATION.md)**: the exit runbook. `pg_dump` over the
  wire, restore into any managed Postgres, change one connection string. The exit being
  boring is the whole point.

## Docs index

- [DESIGN.md](DESIGN.md): full architecture (lease/fencing protocol, manifest-swap commits, generations, platform notes)
- [V1-WAL-SHIPPING.md](V1-WAL-SHIPPING.md): incremental commits + the three design corrections live testing forced
- [docs/COLDSTART-MODEL.md](docs/COLDSTART-MODEL.md): cold ≈ restore + app boot, measured across 13 services
- [docs/POSTGRES-APP-COMPAT.md](docs/POSTGRES-APP-COMPAT.md): compatibility evidence, 8+ real apps
- [docs/STORAGE-BACKENDS.md](docs/STORAGE-BACKENDS.md): per-provider atomic-primitive survey (GCS / R2 / S3 / IBM COS / ...)
- [docs/D-COLD-BACKUP.md](docs/D-COLD-BACKUP.md): secondary cold backups + the E6 disaster matrix
- [COST-MODEL.md](COST-MODEL.md) · [docs/ROADMAP.md](docs/ROADMAP.md) · [EXPERIMENTS.md](EXPERIMENTS.md) · [STATUS.md](STATUS.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · MIT licensed

## What this is not

Not multi-writer (one writer + any number of bucket-fed read replicas). Not for
databases that don't fit in instance memory. Not a managed service, and not trying to
be Neon or Supabase: those are excellent when you want someone else to run Postgres for
you. This is for the enormous class of apps that are read-mostly, single-region, and
idle 95% of the day: side projects, internal tools, per-tenant databases, preview
environments, agent-spawned databases. For those, the math is a bucket bill measured in
cents. And when an app outgrows all of it: `pg_dump | pg_restore`, because it was real
Postgres the whole time.
