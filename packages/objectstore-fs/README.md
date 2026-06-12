# @zeropg/objectstore-fs

The zeropg core: a real Postgres ([PGlite](https://pglite.dev)) whose durable
home is an object-storage bucket.

```ts
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG, ZeroPGReplica } from '@zeropg/objectstore-fs'

const store = new GcsBlobStore({ bucket: 'my-bucket', prefix: 'apps/mine' })
const db = await ZeroPG.open({ store, durability: 'sleep' })
await db.query('INSERT INTO t VALUES ($1)', ['hello'])
await db.close()
```

## What it does

- **Commits ship WAL byte-ranges** (`[lastShippedLsn, flushLsn)`) as immutable
  objects; one conditional PUT of the manifest IS the commit. ~134ms strict
  commits at any database size.
- **Snapshots are compaction**, rolled past a WAL threshold, with the previous
  snapshot kept as a manifest-pinned backup.
- **Durability modes**: `strict` (ack ⇒ in the bucket), `interval`
  (Litestream-style window), `sleep` (memory-speed writes, one flush when the
  platform reaps the instance).
- **Single-writer lease** with monotonic fencing tokens; takeovers fence-stamp
  the manifest; data-object keys embed the token so a zombie can never
  overwrite a winner's object.
- **Group commit** paced by the store's `CostModel` (GCS caps writes per
  object name at ~1/s; concurrent writes coalesce into one CAS).
- **`ZeroPGReplica`**: leaseless read-only followers that poll the manifest
  and converge within the poll interval.
- **Restore** streams snapshot + WAL overlay with O(1) heap; restored WAL
  files are padded to full segment size (Postgres treats a short page read as
  end-of-WAL — learned the hard way, see V1-WAL-SHIPPING.md).
- `collectGarbage()` deletes anything no manifest references.

## API surface

`ZeroPG.open(opts)` → `query/exec/transaction`, `flush()`, `close()`,
`raw` (the PGlite instance for ORMs), `bootTimings`, `currentManifest`,
`durabilityMode`, `pendingFlush`, `validateLease()`, `markDirty()`.
`ZeroPGReplica.open(opts)` → `query`, `refresh()`, `commitSeq`, `close()`.
`ZeroPG.buildEmptySnapshot()` → seed bytes that skip initdb on fresh boots.

Every consistency behavior here is backed by live-fire experiment harnesses
(crash matrices, handover races, zombie fencing) in the repo's
[`experiments/`](../../experiments) — see [STATUS.md](../../STATUS.md).
