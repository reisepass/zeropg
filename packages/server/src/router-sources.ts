// Ready-made `DatabaseSource`s for the wire router.
//
// A source is just "how do I bring this name into memory, flush it, and close
// it". The router does not care what is behind it, which is what keeps the
// local-only build and the local-plus-remote build one branch body apart
// (section 6 of docs/SPEC-wire-router.md).
//
// This module imports @zeropg/objectstore-fs and therefore PGlite, so it is a
// deep import rather than part of the wire-frontend barrel that @zeropg/client
// relies on staying PGlite-free.

import { ZeroPG, type Durability } from '@zeropg/objectstore-fs'
import type { BlobStore } from '@zeropg/blobstore'
import type { DatabaseSource, RoutedInstance } from './warm-set.js'

export interface ZeroPGSourceOptions {
  store: BlobStore
  durability?: Durability
  holder?: string
  leaseTtlMs?: number
  acquireTimeoutMs?: number
  seedSnapshot?: Uint8Array
  extensions?: Record<string, unknown>
  scratchDir?: string
  /** Idempotent schema SQL run once after the instance opens. */
  schemaSql?: string
}

/**
 * A database backed by a ZeroPG bucket: opening takes the lease and restores,
 * flushing commits to the object store, closing releases the lease.
 *
 * The flush contract matters more here than anywhere else in the stack. Raw-wire
 * writes reach PGlite directly, never passing through `ZeroPG.query()`/`exec()`,
 * so they never set the dirty flag that a durable commit is gated on. `flush()`
 * therefore calls `markDirty()` unconditionally before committing: if it trusted
 * the flag it would return success having written nothing, and the eviction
 * protocol - which treats a resolved flush as permission to release the lease -
 * would drop those writes silently.
 */
export function zeropgSource(opts: ZeroPGSourceOptions): DatabaseSource {
  return {
    async open(): Promise<RoutedInstance> {
      const db = await ZeroPG.open({
        store: opts.store,
        durability: opts.durability ?? 'sleep',
        holder: opts.holder,
        leaseTtlMs: opts.leaseTtlMs,
        acquireTimeoutMs: opts.acquireTimeoutMs,
        seedSnapshot: opts.seedSnapshot,
        extensions: opts.extensions,
        scratchDir: opts.scratchDir,
      })
      if (opts.schemaSql) await db.exec(opts.schemaSql)
      return {
        engine: db.raw as never,
        async flush() {
          // Unconditional markDirty: see the note above. A wire write leaves no
          // trace the engine's own dirty flag can see.
          db.markDirty()
          await db.commit()
        },
        async close() {
          await db.close()
        },
      }
    },
  }
}
