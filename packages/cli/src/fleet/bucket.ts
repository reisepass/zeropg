// Learn about a database WITHOUT starting its service. Everything durable lives
// in the bucket, so we can read a lot straight from object storage - no Cloud
// Run wake, no lease, no cost on the service:
//
//   inspectManifest: one GET (manifest.json) + one list() of the prefix ->
//     when it was last written, how many commits, generation, and total bytes
//     stored. Cheap; safe to run on demand.
//
//   peekTables: materialize a read-only ZeroPGReplica from the bucket (local
//     compute, seconds; NO remote wake) and read exact size + table-name hints.
//     Heavier than the manifest read, still never touches the live service.

import type { Instance } from './types.js'
import { captureDbStats, type InstanceStats } from './stats.js'

export interface ManifestInfo {
  committedAt: string | null
  commitSeq: number | null
  generation: string | null
  version: number | null
  /** Total bytes stored under the prefix (all generations/WAL) - what you pay
   *  to keep this db at rest. A superset of the live snapshot. */
  bucketBytes: number
  objectCount: number
  /** Set if the db was migrated out (booting it would refuse). */
  movedTo: string | null
}

/** Read the manifest + object sizes from the bucket. No service wake. */
export async function inspectManifest(inst: Instance): Promise<ManifestInfo> {
  if (!inst.bucket || !inst.prefix) throw new Error(`${inst.name}: no bucket/prefix on the service`)
  const [{ GcsBlobStore }, { decodeManifest, MANIFEST_KEY }] = await Promise.all([
    import('@zeropg/blobstore'),
    import('@zeropg/objectstore-fs'),
  ])
  const store = new GcsBlobStore({ bucket: inst.bucket, prefix: inst.prefix })

  const info: ManifestInfo = {
    committedAt: null,
    commitSeq: null,
    generation: null,
    version: null,
    bucketBytes: 0,
    objectCount: 0,
    movedTo: null,
  }

  const got = await store.get(MANIFEST_KEY)
  if (got) {
    const m = decodeManifest(got.bytes)
    info.committedAt = m.committedAt ?? null
    info.commitSeq = m.commitSeq ?? null
    info.generation = m.generation ?? null
    info.version = m.version ?? null
    info.movedTo = m.movedTo ?? null
  }

  for await (const entry of store.list('')) {
    info.bucketBytes += entry.size
    info.objectCount++
  }
  return info
}

/**
 * Materialize a read-only replica from the bucket and read exact db size +
 * public table-name hints. No remote wake; local restore cost scales with db
 * size. Returns a stats patch to cache.
 */
export async function peekTables(inst: Instance): Promise<InstanceStats> {
  if (!inst.bucket || !inst.prefix) throw new Error(`${inst.name}: no bucket/prefix on the service`)
  const [{ GcsBlobStore }, { ZeroPGReplica }] = await Promise.all([
    import('@zeropg/blobstore'),
    import('@zeropg/objectstore-fs'),
  ])
  const replica = await ZeroPGReplica.open({
    store: new GcsBlobStore({ bucket: inst.bucket, prefix: inst.prefix }),
    pollIntervalMs: 0,
  })
  try {
    return await captureDbStats({ query: (sql: string) => replica.query(sql) })
  } finally {
    await replica.close()
  }
}
