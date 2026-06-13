# zeropg

**Postgres that costs zero when nobody's using it.**

A real Postgres database ([PGlite](https://pglite.dev) — Postgres compiled to WASM) running on scale-to-zero compute, with the data living in an object-storage bucket. No database server, no volume, no managed-Postgres bill. A single writer is enforced by a lease built on the bucket's own conditional writes, with fencing tokens making zombie writers physically unable to commit. When the app outgrows it, graduation to an always-on Postgres is `pg_dump | pg_restore` — it was real Postgres all along.

Think: **Litestream, but for Postgres** — and durability semantics you can pick per workload.

## See it live (scale-to-zero, real cold starts)

| demo | database | cold start (p50 / p99, measured) |
|---|---|---|
| [zeropg-demo-1mb](https://zeropg-demo-1mb-71428757273.europe-west1.run.app) | 10 MB | 3.8s / 4.7s |
| [zeropg-demo-50mb](https://zeropg-demo-50mb-71428757273.europe-west1.run.app) | 52 MB | 3.5s / 4.3s |
| [zeropg-demo-500mb](https://zeropg-demo-500mb-71428757273.europe-west1.run.app) | 501 MB | 11.2s / 12.3s |

Each page tells you whether it was served cold (instance woke from zero and restored Postgres from the bucket) or warm, with the full boot breakdown. Leave a note — it persists in the bucket across scale-to-zero. Two buttons let you drive it yourself: **put to sleep** streams the flush + lease-release steps (with per-step object-storage timing) and exits the instance so your next reload is a real cold start; **run TPC-C benchmark** streams a standard OLTP benchmark live against the database (single-writer tpmC, self-capping its size, then cleaning up). The instances are also reaped after ~15 idle minutes; come back later and you'll catch a cold start.

Numbers from 20 forced cold starts per size on Cloud Run (1 vCPU + startup boost, europe-west1, same-region GCS), end-to-end from the client. The split: ~2s container start (the platform's floor — it dominates for small DBs), restore pipeline scaling with size (1.3s @ 10MB → 9.1s @ 500MB), and ~0.7s PGlite open regardless of size. Memory floor: the 500MB database runs even in a 1GiB container (datadir on tmpfs ~535MB + ~430MB RSS — tight but 5/5 stable); 2GiB is the comfortable tier, and 4GiB changes nothing because restore is bandwidth-bound, not memory-bound.

## How a database with no server works

```
            ┌────────────── Cloud Run / Workers / Lambda ──────────────┐
   request →│  your app ── SQL ──> PGlite (Postgres-in-WASM, in-proc)  │
            │                        │ datadir on /tmp                 │
            └────────────────────────┼──────────────────────────────────┘
                 boot: restore       │ commit: snapshot
                 (streamed)          ▼ (streamed)
            ┌───────────────── GCS / R2 / S3 bucket ───────────────────┐
            │  manifest.json   ← conditional PUT = THE commit          │
            │  lease.json      ← single writer, fencing tokens         │
            │  generations/<id>/snapshot-N.tar[.gz]   (immutable)      │
            └───────────────────────────────────────────────────────────┘
```

- **Cold start**: stream the snapshot out of the bucket — parallel ranged GETs → (gunzip) → untar → `/tmp` — and open PGlite on it. Nothing is buffered in memory: a 500 MB database restores with ~23 MB of JS heap. PGlite faults pages lazily, so "open" is ~0.7s at any size.
- **Commit**: `CHECKPOINT`, stream `tar(datadir)` → (gzip) → chunked PUT, then one conditional PUT of `manifest.json`. That CAS **is** the commit: crash anywhere before it and the old state is untouched; after it, the new state is durable. Torn states are impossible by construction.
- **Single writer**: `lease.json` is created with if-absent semantics and carries a monotonic fencing token. Every commit CASes the manifest, and takeovers stamp their token into it immediately — a zombie's next commit fails instantly. Verified live with two competing Cloud Run services.
- **Adaptive codec**: if a sample of the data doesn't compress (media, encrypted blobs), snapshots ship as raw tar — a serverless vCPU gzips at ~12 MB/s while the NIC moves 100+ MB/s.

## Durability is a dial

| mode | write latency (measured, 50 MB DB) | loss window on crash |
|---|---|---|
| `strict` | **~0.2s** — ships only the WAL bytes the commit appended | zero — ack ⇒ in the bucket |
| `interval` | ~0.15s | ≤ flush interval (Litestream-style) |
| `sleep` *(demo default)* | **~0.15s** | since last flush; flushes on SIGTERM + after 25s idle |

Commits are **incremental WAL shipping** (Litestream's trick, Postgres edition): each commit uploads one immutable object holding the LSN range it appended — a few hundred bytes for a one-row insert, measured live at scan 1.3ms + upload 79ms + manifest CAS 97ms on the 50MB demo. The full snapshot is now a *compaction* artifact: when accumulated WAL passes 16MB, the next commit rolls a fresh snapshot and keeps the previous one as a backup pointer in the manifest. Flat cost at any database size — v0's full-snapshot-per-commit was 7.8s on the same database.

Two provider realities are engineered around (see [COST-MODEL.md](COST-MODEL.md)): GCS caps sustained writes per object name at ~1/s (measured: 2.4/s with 52% rejections), so back-to-back strict commits **group-commit** — concurrent writes coalesce into one manifest CAS (measured: 10 concurrent writes → 1 commit) and sustained writers pace at the cap; and clean 429/5xx rejections retry with backoff in the driver.

`sleep` is the serverless-native mode: writes run at memory speed while traffic flows, and one flush happens when the platform puts the instance to sleep. The demo pages show the per-step timing of the last write (SQL exec / lease check / WAL scan / upload / manifest CAS) — and a "durable now" checkbox to feel the difference per write.

## The first write after a cold start (and why it must be async)

There is exactly one write per instance life that costs more than the others: the **first** one. When an instance wakes from zero it inherits a WAL position from whatever instance ran last, and that hand-off can't be spliced — the dead writer's recorded flush LSN sits a record-header past the last replayable record, so a successor that just appended to it could ship a torn tail and silently lose a committed write (the full reasoning, and the live byte-level forensics behind it, are in [V1-WAL-SHIPPING.md](V1-WAL-SHIPPING.md)). Litestream solves this by starting a new *generation* — a fresh full snapshot — on every restart that can't prove WAL continuity.

zeropg does the cheaper, equivalent thing: the first commit of each life **re-baselines just the WAL** since the current snapshot, read from the new instance's own coherent on-disk stream between two clean boundaries, never the predecessor's ragged tail. The existing database snapshot is reused untouched. So the one-time cost is bounded by the WAL since the last compaction (≤16 MB), not by database size: on the 500 MB demo the first durable write after a cold start is **~350 ms / 3 MB**, where a full re-snapshot would be **~18 s / 533 MB**. Every write after it in that life is a plain incremental WAL ship of a few hundred bytes.

**But cheap is not the point — off the request path is.** A one-time, per-instance housekeeping cost should never land on a *user's* click. It is the wrong thing to make a person wait on, and it is avoidable: the durability dial exists precisely so the first write (and every write) can return at memory speed and let the baseline ride a **background** flush. In `sleep` or `interval` mode the user's write acknowledges in ~150 µs–ms from memory; the re-baseline happens on the idle-flush timer, on `waitUntil`, or on the SIGTERM that puts the instance to sleep — never blocking the response. Only `strict` mode puts durability (and therefore the first-write baseline) on the critical path, and that is a deliberate choice you make for a workload that needs ack-equals-durable, not the default for an interactive page.

This is the same bargain Litestream and every object-storage-backed database make: a bucket round-trip is 50–150 ms and the cold-start baseline is a one-off on top of that, so for anything user-facing you **ack from memory and persist in the background**, accepting a bounded, well-defined loss window instead of taxing the interactive path. zeropg makes that window explicit (the table above), makes the baseline cheap, and — most importantly — keeps it asynchronous by default.

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

Runnable versions in [`examples/`](examples/) (guestbook writer + replica
reader). Operational tools: `scripts/branch.ts` (server-side database fork —
500MB in 0.34s), `scripts/gc.ts` (delete unreferenced objects),
`scripts/deploy.sh` (the Cloud Run recipe behind the live demos).

## Status

Working v0 on real infrastructure (GCS + Cloud Run). Experiment-driven; every claim above has a JSONL of evidence in [`results/`](results/).

| experiment | claim | result |
|---|---|---|
| E0 primitives | GCS conditional writes are a correct CAS | ✅ 0 double-winners in 2,000 races |
| E1 lease | acquire/renew/takeover/fencing correct under contention | ✅ |
| E2 round-trip | reopen is byte-identical at 1/10/100 MB | ✅ |
| E2b crash matrix | SIGKILL at every commit fault point → never torn | ✅ (re-passed on incremental commits) |
| E2c incremental | WAL shipping: byte-identical reopens, compaction, group commit | ✅ strict commit p50 134ms |
| E2d replicas | leaseless followers converge across segments + compactions | ✅ |
| E3 cold start | distributions above, boot-path split | ✅ |
| E3b memory tiers | smallest container per DB size | ✅ 500MB DB runs in **1GiB** (5/5, tight); 2GiB comfortable; 4GiB buys nothing |
| E4 lifecycle | revision switches, SIGTERM flush, zombie fencing — live | ✅ |
| E5 soak + cost | 72h realistic traffic, billed cost | pending |

Hard-won platform facts: Postgres silently keeps up to 1 GB of recycled WAL in the datadir (`max_wal_size` default) — a 500 MB DB once shipped 969 MB snapshots until we pinned the WAL GUCs; Postgres preallocates WAL segment files at full size and fills them by overwrite, so incremental capture must be LSN-based, never file-size-based; GCS rate-caps writes to a single object name at ~1/s — fast commits must group-commit; Cloud Run rate-limits crash-looping containers (exit 0 on purpose-restarts); revision switches run two instances against one lease (boot must wait it out, not fail).

## Layout

- [`packages/blobstore`](packages/blobstore) — GCS JSON-API transport: GET/PUT/LIST/DELETE + conditional PUT (`ifGenerationMatch`), parallel-range streaming GET, chunked streaming PUT. The only strong primitive the whole design needs is the conditional PUT, so S3/R2 transports are small.
- [`packages/lease`](packages/lease) — the writer lease: conditional-create, CAS renew/takeover, fencing tokens, zero clock-dependence for correctness.
- [`packages/objectstore-fs`](packages/objectstore-fs) — ZeroPG itself: streaming restore/commit, durability modes, manifest-swap commits, adaptive codec, fence-stamping, GC.
- [`experiments/`](experiments/) — the E0–E5 harnesses; [`scripts/deploy.sh`](scripts/deploy.sh) builds and ships the demo service.

- [DESIGN.md](DESIGN.md) — full architecture: prior art, lease/fencing protocol, manifest-swap commits, generations, platform notes.
- [V1-WAL-SHIPPING.md](V1-WAL-SHIPPING.md) — incremental commits, including the three design corrections live testing forced.
- [STATUS.md](STATUS.md) — the experiment scoreboard and the full bug ledger.
- [COST-MODEL.md](COST-MODEL.md) — provider cost/limit tables driving commit pacing and compaction policy.
- [docs/ROADMAP.md](docs/ROADMAP.md) + [docs/RESEARCH-NOTES.md](docs/RESEARCH-NOTES.md) — what's next, grounded in a survey of Litestream/LTX, LiteFS, SlateDB, Neon, and D1.
- [EXPERIMENTS.md](EXPERIMENTS.md) — the ordered experiment plan and kill criteria.
- [pglite-stream.md](pglite-stream.md) — the "Litestream for Postgres" framing memo.
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · MIT licensed.

## What this is not

Not multi-writer (one writer + any number of bucket-fed read replicas), and not for databases that don't fit in instance memory. It is for the enormous class of apps that are read-mostly, single-region, and idle 95% of the day: side projects, internal tools, per-tenant databases, preview environments. For those, the math is a bucket bill measured in cents — and when an app outgrows all of it, `pg_dump | pg_restore` into any managed Postgres, because it was real Postgres the whole time.
