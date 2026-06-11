# blob-pglite: PGlite on Object Storage

**Postgres for the long tail.** Run a real Postgres database on serverless compute (Cloudflare Workers, Google Cloud Run, AWS Lambda) with the data living in object storage (R2, GCS, S3). No database server, no volume, no managed Postgres bill. Built on [PGlite](https://pglite.dev) (Postgres compiled to WASM, by ElectricSQL in collaboration with Neon).

Think of it as: **Litestream, but for Postgres, and built into the database's own filesystem layer.**

## 1. Problem statement

There is a huge class of applications that:

- have one user, or a handful of users, and effectively zero concurrent writes
- run on the cheapest possible compute: a single Cloudflare Worker, one Cloud Run instance scaling to zero, a single tiny container
- still deserve a real SQL database with real durability

Today these apps either pay for a managed Postgres that idles at 0.01% utilization, or they use SQLite-on-object-storage tooling (Litestream, turbolite) and give up Postgres. PGlite removes the "Postgres needs a server" constraint, but it currently has no object storage backend and no protection against two serverless instances corrupting the same data.

The target guarantee:

> A single writer at a time can safely run PGlite against a bucket. A second concurrent writer is cleanly rejected with an error rather than corrupting anything. Zombie writers (instances that lost their lease but keep running) physically cannot commit.

We explicitly do NOT target: multi-writer, high TPS, low write latency, read replicas at scale. Those are Neon's job. This is the radically simplified, self-hostable, single-writer version of the same separation-of-storage-and-compute idea, for the long tail.

## 2. Why a naive approach fails

**Mounting the bucket as a filesystem does not work.**

- Cloudflare Workers have no filesystem at all. R2 is only reachable through the binding API (get / put / conditional put). FUSE-style approaches are dead on arrival.
- Cloud Run can mount GCS via FUSE volumes, but gcsfuse stages writes locally and uploads whole objects on close/fsync. Postgres WAL correctness depends on small ordered appends with real fsync barriers. A crash mid-upload can tear `pg_wal` relative to `pg_control`. It would mostly work, then corrupt at the worst possible moment.
- Object stores have no byte-range writes and no POSIX locks. Every "make the bucket look like a disk" design fights this and loses.

**The insight: do not give Postgres a remote disk. Give it a local (in-memory) disk, and build replication and commit on top, using the object store's one strong primitive: atomic conditional writes.**

All three major object stores now support conditional writes:

- R2: conditional PUT with etag preconditions
- GCS: `ifGenerationMatch` / `ifGenerationMatch=0` (create-if-absent)
- S3: `If-Match` / `If-None-Match`

One primitive gives us both a distributed lock and an atomic commit point. No socket, no shared network, no coordination service.

## 3. Prior art (and what we take from each)

### Litestream (SQLite)

[Litestream](https://litestream.io/how-it-works/) is the proven blueprint for "embedded DB + object storage":

- Holds a long-running read transaction on SQLite so nobody else can checkpoint and reset the WAL ("checkpoint hijacking").
- Copies WAL frames into its own staging sequence ("shadow WAL": `00000000.wal`, `00000001.wal`, ...).
- **Generations**: a random ID bundling one snapshot plus all contiguous WAL segments after it. On any continuity break, abandon the generation, take a fresh snapshot, start a new one. Restore is always: download snapshot, replay contiguous WAL.
- Periodic snapshots plus retention GC cap restore time.
- It is asynchronous (up to ~1s of loss on crash) and has NO writer lock on the bucket: two Litestream instances replicating to the same path is a documented corruption scenario. Generations detect divergence after the fact; they do not prevent it.
- v0.5+ replaced raw generations with LTX files and multi-level compaction (from LiteFS) for fast point-in-time restore. Good v2 material for us.

**We take**: generations, snapshot + shipped WAL segments, retention model. **We add**: the writer lease Litestream never had.

**Our structural advantage over Litestream**: Litestream sits outside SQLite as a separate process, which is why it needs the read-lock hack and shadow WAL. We own PGlite's filesystem layer. Every write Postgres makes to `pg_wal/` and the heap files passes through our VFS. Litestream's hardest engineering problem does not exist for us.

### turbolite (SQLite on S3)

[turbolite](https://github.com/russellromney/turbolite) is the closest existing system to this design, for SQLite:

- Pages batched into ~16MB "page groups" as single S3 objects (lesson: batch, never one-object-per-page; sqlite-s3vfs does one PUT per 4KB page and it is slow and expensive).
- zstd compression + AES-256-GCM, seekable frames, range GETs.
- **Manifest file as the single source of truth and atomic commit point**: upload immutable page objects, then swap the manifest. Old versions become garbage, collected later.
- Explicit single-writer model with the same caveat we refuse to accept: "two machines writing directly to the same prefix will corrupt the manifest."
- Cold-start point lookups ~77ms on S3 Express; 1.5GB full scan ~586ms. This is the realistic performance envelope.

**We take**: manifest-swap commit, immutable objects, batching, the performance expectations. **We add**: the lease.

### SQLite in Durable Objects (rkusa) and Cloudflare's own SQLite-in-DO

[rkusa's experiments](https://ma.rkusa.st/store-sqlite-in-cloudflare-durable-objects) built a custom SQLite VFS over Durable Object storage, fighting the sync-VFS-over-async-storage problem with Asyncify. Cloudflare later shipped [SQLite in Durable Objects natively](https://blog.cloudflare.com/sqlite-in-durable-objects/). The lesson: **a Durable Object is the platform-native single-writer container on Cloudflare**. PGlite has already solved the sync-WASM-to-async-storage bridge (see the OPFS AHP filesystem), so we start ahead of where rkusa did.

### Neon, OrioleDB, WAL-G (Postgres at the big end)

- [Neon](https://neon.com/docs/introduction/architecture-overview): compute ships WAL to a Paxos quorum of safekeepers; pageservers materialize pages and upload to S3 as the source of truth. Our design is Neon with the safekeeper quorum replaced by a conditional-write lease, which is appropriate because we explicitly do not need multi-writer or HA. (Full circle: PGlite itself came out of the ElectricSQL/Neon collaboration.)
- [OrioleDB decoupled storage](https://www.orioledb.com/docs/usage/decoupled-storage): experimental S3-backed tables for full Postgres. Validates demand; not applicable to the WASM build.
- [WAL-G](https://wal-g.readthedocs.io/PostgreSQL/) / wal-e / pgBackRest: decades of production validation that "base backup + WAL segments on object storage, restore replays" is the correct recovery model for Postgres.

### PGlite today

- Official backends: `memory://`, `file://` (Node/Bun), IndexedDB, OPFS AHP. No object storage. The official [pglite-cloudflare-worker-example](https://github.com/electric-sql/pglite-cloudflare-worker-example) is in-memory only, data lost on every isolate recycle.
- **Nobody has shipped writable PGlite on S3/R2. The niche is open.**

Every writable system above independently converged on the same three pillars: **immutable page/WAL objects, a manifest swap as the atomic commit, single writer enforced by lease or platform.** Nobody has assembled them for PGlite. The differentiator most of them punt on is the lease with fencing tokens, and conditional writes make that tractable today.

## 4. Architecture

### 4.1 Where it plugs in

PGlite's `Filesystem` interface (`packages/pglite/src/fs/base.ts` in the pglite repo) is the extension point:

```
init(pg, emscriptenOptions)        // mount
initialSyncFs()                    // cold start: hydrate from durable storage
syncToFs(relaxedDurability?)       // called after every committing query
dumpTar(dbname)                    // whole-datadir snapshot (already exists)
closeFs()
```

PGlite calls `syncToFs()` after DML/DDL by default, and `relaxedDurability` already exists as a per-instance/per-query knob. The OPFS AHP backend (`opfs-ahp.ts`) demonstrates the in-tree pattern for a custom VFS with its own metadata WAL, checkpointing, and dirty-handle tracking. We implement a new backend, `ObjectStoreFS`, with a pluggable transport:

```
interface BlobStore {
  get(key, opts?: { range? }): Promise<Bytes | null>
  put(key, bytes, opts?: { ifMatch?, ifNoneMatch? }): Promise<{ etag }>   // conditional
  list(prefix): AsyncIterable<{ key, etag, size }>
  delete(key): Promise<void>
}
```

Transports: R2 binding, GCS JSON API, S3 API. Conditional `put` is the only strong primitive we require; everything else is plain GET/PUT/LIST.

### 4.2 Data layout in the bucket

```
<prefix>/
  lease.json                         # writer lease (see 4.4)
  manifest.json                      # THE commit point. Conditional-PUT only.
  generations/
    <genId>/
      snapshot-<lsn>.tar.zst         # base snapshot (dumpTar output, compressed)
      wal/
        <fencingToken>-<seq>.seg.zst # immutable WAL segment objects, in order
```

`manifest.json` (small, single object):

```json
{
  "version": 1,
  "generation": "9f3ac41e8d27b06a",
  "fencingToken": 17,
  "snapshot": "snapshot-0_2F000158.tar.zst",
  "walSegments": ["17-00000000.seg.zst", "17-00000001.seg.zst"],
  "lsn": "0/2F0001A8",
  "committedAt": "2026-06-11T18:00:00Z"
}
```

### 4.3 Read path (cold start)

1. GET `manifest.json`. If absent: fresh database, run initdb into MemoryFS, take snapshot, write manifest with create-if-absent.
2. Download snapshot, decompress into the in-memory FS.
3. Download and append the listed WAL segments into `pg_wal/`.
4. Boot PGlite. Postgres's own crash recovery replays the WAL. We never reimplement WAL replay; Postgres does it, exactly as a `litestream restore` lets SQLite do it.

Cold start cost is dominated by snapshot size. For the target use case (databases in the MB to low hundreds of MB), this is one ranged/streamed GET. v2 can do lazy page fetch (turbolite-style page groups) if cold start ever matters more.

### 4.4 The lease (the part Litestream never built)

Goal: at most one committing writer, zombie-proof, with no coordination service.

- **Acquire**: conditional create of `lease.json` (GCS `ifGenerationMatch=0`, S3 `If-None-Match: *`, R2 etag precondition). Body: `{ holder, fencingToken, expiresAt }`. `fencingToken` is the previous token + 1, taken from the manifest.
- **If the lease exists and is unexpired**: fail immediately with a clean, descriptive error ("database is locked by writer X until T"). This is the accepted UX: the second worker just errors.
- **If expired**: take over with a conditional PUT against the lease's current etag/generation (so two takeover attempts cannot both win), incrementing the fencing token.
- **Heartbeat**: renew before `expiresAt` (conditional on own etag). Failure to renew means: stop committing, become a zombie by definition.
- **Fencing**: every WAL segment object name embeds the fencing token, and every `manifest.json` write is a conditional PUT against the manifest etag the writer last saw AND records the writer's token. A zombie holding token 16 cannot overwrite a manifest advanced by token 17: its conditional PUT fails on the etag, and even its orphaned `16-*.seg.zst` uploads are ignorable garbage because no manifest references them. **A stale writer physically cannot commit.** This upgrades Litestream's "detect divergence via generations" to "prevent divergence."
- Clock skew only affects how aggressively expired leases are taken over, never correctness; correctness comes from the conditional writes, not the clock.

### 4.5 Write path (commit)

On `syncToFs()`:

1. The VFS classifies dirty writes by path. `pg_wal/*` is an append-only byte stream; everything else (`base/`, `pg_control`, ...) is the base image and is NOT shipped per-commit, only at snapshot time.
2. Newly appended WAL bytes are cut into an immutable segment object and PUT (plain PUT, unique name, fencing token embedded). Batched if multiple commits are in flight.
3. Conditional PUT of `manifest.json` appending the new segment(s). This single operation IS the commit. Precondition failure means lease lost: surface a fatal "writer fenced" error, never retry blindly.
4. A crash at any point before step 3 leaves the old manifest intact. Torn states are impossible by construction. No fsync semantics required from the object store, ever.

Durability modes, mapped onto the existing `relaxedDurability` flag:

- **Strict** (`relaxedDurability: false`): the query promise resolves only after the manifest PUT. An acknowledged transaction is durable in the bucket. Cost: ~10-50ms added write latency. Litestream cannot offer this; we can because we sit inside the commit path.
- **Relaxed** (`true`): segments and manifest updates are batched and flushed every N ms / N bytes, plus on `waitUntil`/shutdown. Litestream-equivalent semantics (bounded loss window on crash), much lower latency.

### 4.6 Snapshots, generations, GC

- Periodically (size threshold on accumulated WAL, or a timer, or detection of a Postgres checkpoint via `pg_wal` recycling writes), take a new snapshot: `dumpTar()` the data dir, upload, write a manifest that references the new snapshot and an empty WAL list. Same conditional-PUT commit.
- Any continuity doubt (lost lease, failed precondition, missing segment on restore) starts a **new generation** with a fresh snapshot rather than risking repair logic. Old generations are retained per policy then garbage collected, always keeping at least one restorable snapshot. Straight from Litestream.
- Free side effects: point-in-time restore (replay fewer segments), trivially cheap backups (the bucket IS the backup), and database branching (copy a manifest, new prefix) as a Neon-flavored party trick later.

### 4.7 Platform notes

**Cloudflare Workers**: two tiers.

- *v1, recommended*: a **Durable Object per database** owns the PGlite instance and the `ObjectStoreFS`, persisting to R2. The platform guarantees single-threaded, globally unique execution, so the lease is belt-and-suspenders rather than load-bearing. Workers anywhere RPC the DO. Use `waitUntil` + DO alarms for relaxed-mode flushes and snapshot timers. This ships soonest and is the safest.
- *Generic tier*: plain Workers talking straight to R2 with the lease doing the real work. Needed anyway for the S3/GCS story, so the DO path is an optimization, not a dependency.

**Google Cloud Run**: do NOT use the GCS FUSE volume mount for the live data dir (see section 2). Run MemoryFS + `ObjectStoreFS` over the GCS JSON API with `ifGenerationMatch`. With `min-instances=0..1` and `max-instances=1` the platform already approximates single-writer; the lease makes it actually safe across deploys, rollouts, and the brief double-instance windows Cloud Run creates during revision switches.

**Anything with a real disk** (Fly, VPS, laptop): NodeFS as the working dir instead of MemoryFS, same replication layer on top. That is the literal Litestream deployment model and gives fast restarts.

### 4.8 Failure matrix

| Failure | Outcome |
|---|---|
| Crash before manifest PUT | Old state intact. Orphan segments are unreferenced garbage, GC'd later. |
| Crash after manifest PUT | Commit is durable. Next cold start restores it. |
| Two workers start simultaneously | One wins the conditional lease create; the other gets a clean lock error. |
| Zombie writer (lease expired, still running) | Manifest conditional PUT fails (etag + fencing token). Fatal "fenced" error. No corruption possible. |
| Worker evicted mid-upload | Same as crash-before-manifest. `waitUntil` reduces the window in relaxed mode. |
| Missing/corrupt segment on restore | Fall back to previous generation snapshot; start new generation. |
| Clock skew | Affects takeover aggressiveness only; correctness is carried by conditional writes. |

## 5. Client SDK: outgrowing the bucket is an env var

The core promise is that PGlite is full Postgres, so the day your app outgrows blob storage you move to an always-on Postgres instance without touching application code. The SDK has to make that switch literally a configuration change:

```
DATABASE_URL=s3://my-bucket/myapp        # blob-pglite (also r2://, gs://)
DATABASE_URL=postgres://host:5432/myapp  # real Postgres server
```

- One client factory reads the URL scheme and returns either an embedded blob-backed PGlite or a normal socket client (pg/postgres.js) behind the same query interface (`query`, `transaction`, tagged-template sugar). The app never imports either driver directly.
- The common-interface problem is mostly solved already: PGlite's API is deliberately close to node-postgres, and the ORM ecosystem (Drizzle, Prisma via adapter, Kysely) supports both PGlite and pg drivers - so the SDK can also just hand the right driver to an ORM.
- Migration of the data itself is a one-shot CLI: `blob-pglite migrate-out --to postgres://...`. It acquires the writer lease (so writes are cleanly frozen, not raced), restores the latest manifest into PGlite, streams a dump into the target, verifies row counts, and writes a tombstone into the manifest (`movedTo: postgres://...`) so any instance still booting from the bucket fails with a pointer to the new home instead of silently resurrecting stale data.
- The same works in reverse for dev: point `DATABASE_URL` at a local file or memory PGlite, deploy with an `s3://` URL, graduate to `postgres://` later. Three stages, one variable, all real Postgres.

On Cloud Run specifically this means moving off the bucket is: run `migrate-out`, update the env var on the service, deploy a new revision. The lease protocol also covers the rollout window - old revisions still pointing at the bucket cannot commit once the tombstone lands.

## 6. What this is NOT

- Not multi-writer. Ever, by design. The second writer errors.
- Not low-latency at strict durability (~10-50ms per commit round trip). Relaxed mode exists for everything else.
- Not high TPS. The target is the database that gets tens of writes per minute, not per millisecond.
- Not Neon. Neon solves HA, branching at scale, multi-tenant storage, bottomless size. We solve "I want a real Postgres for $0.02/month and I can host it myself."

## 7. Relationship to upstream PGlite

**Decision: no fork.** Build as a companion package (working name `@blob-pglite/objectstore`, product name TBD) with `@electric-sql/pglite` as a peer dependency.

Reasons:

- The `Filesystem` interface is a public extension point, and PGlite's monorepo already ships sibling packages (`pglite-socket`, `pglite-sync`). An object storage VFS is architecturally the same kind of thing: it consumes the engine, it does not modify it.
- A fork inherits the WASM build burden (the patched postgres-pglite fork + Emscripten toolchain + keeping pace with Postgres releases) and orphans us from upstream crash-safety fixes. All of our actual value lives in the VFS/replication layer.
- Litestream is the precedent: it became the canonical "SQLite on S3" answer without forking SQLite. Name the product, credit the engine loudly.
- If we need small upstream hooks (finer dirty-file tracking, a WAL-append notification in the FS layer), those are focused PRs, not forks. Open a discussion on electric-sql/pglite early, linking the working prototype: informing, not asking permission. The package can be donated upstream later far more easily than a fork could be merged back.
- Full-circle framing for the README and the upstream discussion: PGlite came from the ElectricSQL/Neon collaboration; Neon is Postgres-on-S3 for the high end; this is the simple, self-hostable, single-writer version for the long tail. (A hosted version competing in the small-database segment is a possible later chapter; the architecture does not preclude it and the self-hostable story is the differentiator either way.)

## 8. Roadmap

**v0: proof of correctness (days)**
- `ObjectStoreFS` over MemoryFS, S3-compatible transport (works against R2 and MinIO).
- Whole-datadir snapshot on every `syncToFs` (`dumpTar` + conditional manifest PUT). Crude, correct, fine for MB-scale DBs.
- Lease with TTL + fencing token. Second-writer rejection.
- Port the crash-safety harness (`tests/crash-safety/` in the pglite fork: spawn worker, SIGKILL at a message, reopen, verify integrity) to: kill mid-upload, kill mid-manifest, concurrent open, zombie-after-expiry. MinIO in CI.

**v1: WAL shipping (the real thing)**
- Classify `pg_wal/` writes in the VFS; ship segments incrementally; snapshot on threshold/timer; generations + retention GC.
- Strict vs relaxed durability wired to `relaxedDurability`.
- GCS transport (`ifGenerationMatch`), R2-binding transport.
- Cold-start restore = snapshot + segments + let Postgres recover.

**v1.5: Cloudflare polish**
- Durable Object wrapper class (DO owns the instance, alarm-driven flush/snapshot, RPC interface).
- Cloud Run recipe + docs (max-instances=1, revision-switch behavior).
- Client SDK: `DATABASE_URL`-scheme-switching client factory + `migrate-out` CLI with manifest tombstone (section 5).

**v2: speed and size**
- Incremental snapshots / page-group layout with range GETs (turbolite-style) for larger DBs and lazy cold start.
- LTX-style compaction levels for fast point-in-time restore (Litestream v0.5's evolution).
- Read-only replicas serving straight from the bucket (no lease needed).
- Branching: copy manifest to a new prefix.

## 9. Open questions

- WAL segment cut size and PGlite's configured `wal_segment_size`: verify what the WASM build uses and whether shipping sub-segment deltas is needed to keep relaxed-mode flushes small.
- Detecting Postgres checkpoints from inside the VFS (WAL recycling pattern) vs just using size/time thresholds for snapshots: thresholds are probably enough for v1.
- `dumpTar` currently targets a running instance; confirm it is callable at the right moments for snapshotting, or snapshot by walking the FS directly.
- Encryption at rest (turbolite does AES-256-GCM client-side): probably a v2 flag, buckets have SSE anyway.
- How Workers' CPU time limits interact with initdb on a truly fresh database (initdb is the most expensive cold path; may need to seed from a prebuilt empty snapshot instead, which also makes "create database" a pure bucket write).

## 10. References

- PGlite: https://pglite.dev / https://github.com/electric-sql/pglite (filesystems: https://pglite.dev/docs/filesystems)
- Litestream how-it-works: https://litestream.io/how-it-works/
- turbolite: https://github.com/russellromney/turbolite
- sqlite-s3vfs: https://github.com/simonw/sqlite-s3vfs (one object per page; the anti-pattern to avoid)
- SQLite in Durable Objects (rkusa): https://ma.rkusa.st/store-sqlite-in-cloudflare-durable-objects
- Cloudflare native SQLite-in-DO: https://blog.cloudflare.com/sqlite-in-durable-objects/
- Neon architecture: https://neon.com/docs/introduction/architecture-overview (analysis: https://jack-vanlightly.com/analyses/2023/11/15/neon-serverless-postgresql-asds-chapter-3)
- OrioleDB decoupled storage: https://www.orioledb.com/docs/usage/decoupled-storage
- WAL-G: https://wal-g.readthedocs.io/PostgreSQL/
- PGlite standalone-file discussion: https://github.com/electric-sql/pglite/discussions/662
