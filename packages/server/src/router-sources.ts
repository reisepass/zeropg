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
      // Hand over to the wire with a CLEAN dirty flag, always.
      //
      // Not tidiness. `exec()` sets the flag and, under sleep durability, does
      // not commit, so a leftover flag from schema setup makes `close()` commit
      // on its way out - and that commit sweeps up every raw-wire write made
      // since, which have no flag of their own. The database then looks durable
      // for a reason that has nothing to do with the eviction protocol having
      // flushed it. Caught exactly that way: an evictor with its flush deleted
      // still passed a survive-the-eviction test, because setup had armed
      // close() to commit. Clearing here makes the flag mean what the wire path
      // needs it to mean, and makes a missing flush actually lose data.
      await db.flush()

      // Cumulative row-modification count Postgres itself reports. It advances
      // only on real data changes, never on reads and never on this query, so
      // it is a clean "did the wire write anything?" signal for a path that
      // leaves no other trace. Same technique as ZeroPGServer's wireFlushTimer
      // (packages/server/src/server.ts).
      const writeCount = async (): Promise<number> => {
        const r = await db.raw.query<{ w: string }>(
          'SELECT COALESCE(tup_inserted + tup_updated + tup_deleted, 0)::text AS w ' +
            'FROM pg_stat_database WHERE datname = current_database()',
        )
        return Number(r.rows[0]?.w ?? 0)
      }
      let flushedAt = await writeCount()

      return {
        engine: db.raw as never,
        async pendingWrites() {
          try {
            return (await writeCount()) > flushedAt
          } catch {
            // Cannot tell. Say yes: an unnecessary commit costs an object-store
            // write, a wrong "no" loses the writes.
            return true
          }
        },
        async flush() {
          // Read the counter BEFORE committing. Reading it after would credit
          // this flush with writes that landed while it ran, and the next flush
          // would skip them.
          const at = await writeCount().catch(() => flushedAt + 1)
          // Unconditional markDirty: see the note above. A wire write leaves no
          // trace the engine's own dirty flag can see, so trusting the flag here
          // would return success having written nothing, and the eviction
          // protocol reads a resolved flush as permission to release the lease.
          db.markDirty()
          await db.commit()
          flushedAt = at
        },
        async close() {
          await db.close()
        },
      }
    },
  }
}
