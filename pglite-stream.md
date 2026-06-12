# PGlite-Stream: Litestream for Postgres

A design for a Postgres database that runs in-process for local development, scales to zero on serverless infrastructure, and migrates to a standard Postgres server when it outgrows the model — with **no schema changes** along the way, because it is Postgres the whole time.

## Motivation

Litestream made SQLite viable for real applications by continuously shipping the write-ahead log to object storage. You get a single-file database, durable backups, and scale-to-zero economics, all without running a database server. The catch is that it is SQLite. When you outgrow a single node, you face a migration to Postgres that means rewriting schema, types, and queries against a different SQL dialect and concurrency model.

PGlite-Stream applies the same WAL-shipping idea to **Postgres** instead of SQLite. The engine is [PGlite](https://pglite.dev), a build of Postgres compiled to WASM that runs in-process. Because it is genuinely Postgres, the migration path at the top end is a `pg_dump`/`pg_restore` (or logical replication) into a managed Postgres instance — same dialect, same types, same queries. The database grows with you from `localhost` to serverless to a dedicated server without ever changing the SQL.

## How it works

The model has three states, and the same database file/WAL moves between them unchanged.

**Local development.** PGlite runs in-process inside your application (Node, Bun, or any WASM host). Queries hit an in-memory Postgres with no separate server to install or manage. This is already a supported PGlite use case and is wired into ORMs (see Related work).

**Serverless, scale-to-zero.** The application plus PGlite is deployed as a container on a scale-to-zero platform (e.g. Google Cloud Run). The lifecycle per instance:

1. **Cold start** — the instance boots, PGlite initializes in memory, and the WAL is read from object storage (S3, R2, GCS) and replayed to reconstruct current state before serving traffic.
2. **Serving** — all reads and writes happen in memory. New writes append to a WAL buffer.
3. **Checkpoint / shutdown** — the WAL delta since the last checkpoint is flushed to object storage as an append. Periodic background snapshots bound recovery cost and replay time.

A single instance is the sole writer, which gives the single-writer guarantee Postgres needs without an external coordinator — the serverless platform's per-instance isolation provides it. This mirrors how Litestream is fundamentally a single-node tool: writes go through one application, reads can fan out to replicas ([Litestream docs](https://litestream.io/how-it-works/)).

**Graduation to managed Postgres.** When the database outgrows the in-memory model, the data moves into a standard Postgres server (self-hosted, Neon, Cloud SQL, RDS, etc.). No schema translation is required because the source was already Postgres.

## Design constraints

These are the boundaries of the model, stated plainly.

**Size ceiling.** The whole database is held in the instance's memory and must transfer from object storage on cold start. Realistically this caps the comfortable working set in the low hundreds of MB — a useful target is **~500 MB**, beyond which cold-start transfer and replay time, and instance RAM limits, push you toward graduating to a server. A 500 MB database over same-region object storage plus replay is in the multi-second range end-to-end.

**Cold start.** End-to-end cold start is the sum of: container start, WASM/PGlite init, WAL transfer from object storage, and WAL replay. Keeping the image slim and snapshotting regularly (so the WAL stays short) keeps this in the low single-digit seconds for small databases. For comparison, Neon's scale-to-zero resume is roughly 1–3 seconds and Aurora Serverless v2's scale-to-zero resume is documented at up to ~15 seconds ([Aurora Serverless v2 scale-to-zero](https://aws.amazon.com/blogs/database/introducing-scaling-to-0-capacity-with-amazon-aurora-serverless-v2/)).

**Concurrency.** A single instance serializes writes. One long-running write transaction can block others on that instance. This is acceptable for the target workloads (dev databases, small production apps) and is the same fundamental trade-off SQLite/Litestream accept.

**Durability.** Like Litestream, replication is asynchronous: a crash can lose writes that were committed in memory but not yet flushed to object storage. Litestream replicates on an interval and notes this explicitly ([Litestream tips & caveats](https://litestream.io/tips/)). Checkpoint frequency trades durability against object-storage write volume. WAL writes must be validated with checksums so a crash mid-flush cannot corrupt the replayable history.

## WAL handling

The append-only WAL is the unit of replication, exactly as in Postgres log shipping and in Litestream's shadow-WAL approach. Litestream takes over SQLite's checkpoint process to capture every WAL frame before it is recycled, ships frames to object storage, and compacts older segments into tiered files ([Litestream how-it-works](https://litestream.io/how-it-works/)). The analogous pieces here:

- **Append on commit** — committed WAL is appended to the in-memory buffer and flushed to object storage on the checkpoint interval or on shutdown.
- **Snapshot + prune** — a periodic full snapshot lets you discard old WAL so replay on cold start stays short. Retention is a tunable, just as Litestream exposes snapshot and retention intervals.
- **Generations / resync** — if continuity is ever broken, you start a fresh snapshot rather than trusting a discontiguous WAL, mirroring Litestream's "generations."

The deeper version of this — materializing pages lazily so you never replay the whole WAL, and serving page reads from object storage on demand — is exactly what Neon's pageserver does ([Neon architecture](https://neon.com/docs/introduction/architecture-overview)) and what Litestream's read-replica VFS does for SQLite ([Litestream VFS](https://litestream.io/how-it-works/vfs/)). For small databases it is unnecessary; full snapshot + replay is simpler and fast enough.

## Storage layout

Object storage holds, per database:

- A base **snapshot** at a known log position.
- Append-only **WAL segments** since that snapshot.
- Optional **compacted** segments merging older WAL to bound segment count.

Any S3-compatible store works (S3, R2, GCS, MinIO, Scaleway/UpCloud/DigitalOcean object storage). Encryption at rest comes from the object store; using a customer-managed key (KMS) that the instance fetches on cold start gives a stronger "we can't read your data at rest" posture, since each instance is single-tenant.

## Related work

- **Litestream** — streaming WAL replication for SQLite to object storage; the direct inspiration. Single-node, asynchronous replication, snapshot + WAL generations, and a read-replica VFS that fetches pages on demand. <https://litestream.io/how-it-works/>
- **LiteFS** — FUSE-based, transaction-aware SQLite replication from the same lineage. <https://fly.io/blog/all-in-on-sqlite-litestream/>
- **PGlite** — Postgres compiled to WASM, running in-process in Node/Bun/browser; the engine used here. <https://pglite.dev>
- **Neon** — serverless Postgres that separates compute from storage, ships WAL to a consensus WAL service (safekeepers), and materializes pages lazily in a pageserver backed by object storage; scale-to-zero compute. The full architecture is open source. <https://github.com/neondatabase/neon>, <https://neon.com/docs/introduction/architecture-overview>
- **Prisma Postgres** — uses PGlite for local development and runs production Postgres as unikernel microVMs for fast scale-to-zero. <https://www.prisma.io/postgres>
- **Aurora Serverless v2 scale-to-zero** — managed Postgres/MySQL with pause-and-resume; documents the resume-latency trade-off of scale-to-zero. <https://aws.amazon.com/blogs/database/introducing-scaling-to-0-capacity-with-amazon-aurora-serverless-v2/>
- **ORM support** — Prisma and Drizzle both support PGlite, so the same application code runs against the in-process engine and against a graduated Postgres server. <https://pglite.dev/docs/orm-support>

## Summary

PGlite-Stream is "Litestream, but the engine is Postgres." You develop locally in-process, deploy to a scale-to-zero container with the WAL shipped to object storage, and — because it was Postgres all along — graduate to a managed Postgres server with no schema rewrite when you cross the size or concurrency ceiling. The hard parts are well-trodden: the WAL-shipping mechanics come from Litestream, the lazy-page and storage-separation ideas come from Neon, and the engine comes from PGlite.
