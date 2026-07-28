// The warm set: which databases are resident in this process right now.
//
// CAPACITY IS COUNTED IN INSTANCES, NOT BYTES. Measured resident memory per
// PGlite instance is roughly CONSTANT and nearly independent of database size:
// about 400 MB on Linux for a 7.7 MB database and about 420-440 MB for a 509 MB
// one. The footprint is PGlite's WASM heap, not the data. So a small database
// costs nearly as much as a big one, `maxWarm` is a flat instance count, and
// "this database is tiny, keep one more" is not a real argument.
//
// This module owns admission only. Eviction (the part that can lose data) is
// section 5 of docs/SPEC-wire-router.md and lands with the warm-set > 1 step.

/** A live, resident database instance the router can route connections to. */
export interface RoutedInstance {
  /** PGlite (or anything that speaks its raw-protocol surface). */
  readonly engine: import('./wire-queue.js').ProtocolEngine &
    import('./handshake.js').HarvestableEngine
  /**
   * Flush every pending write and CONFIRM it committed. Must reject if the
   * commit did not land. The eviction protocol treats a rejection as "refuse to
   * evict this database", so a flush that silently no-ops here becomes silent
   * data loss there.
   */
  flush(): Promise<void>
  /** Release the lease and free the memory. Called only after a confirmed flush. */
  close(): Promise<void>
  /**
   * Optional: are there writes the object store does not have yet?
   *
   * Only used to keep the background wire-flush timer from committing on an
   * idle database. Answering `true` conservatively (or not implementing this at
   * all, which is read as `true`) costs an object-store write; answering `false`
   * when writes are in fact pending loses them, so when in doubt say true.
   */
  pendingWrites?(): Promise<boolean>
}

/** How a named database is brought into memory. */
export interface DatabaseSource {
  open(): Promise<RoutedInstance>
}

/** Resolve a database name to its source, or null when no such database exists
 *  (which the router answers with 3D000 invalid_catalog_name). */
export type Catalog = (name: string) => DatabaseSource | null

/** Build a Catalog from a plain object of named sources. */
export function catalogFrom(sources: Record<string, DatabaseSource>): Catalog {
  return (name) => Object.prototype.hasOwnProperty.call(sources, name) ? sources[name]! : null
}

/** Raised when the warm set is full and nothing could be made room for. Carries
 *  the SQLSTATE the router puts on the wire. */
export class WarmSetFullError extends Error {
  readonly sqlstate = '53400' // configuration_limit_exceeded
  constructor(name: string, maxWarm: number, detail: string) {
    super(
      `cannot start database "${name}": this zeropg router keeps at most ${maxWarm} database` +
        `${maxWarm === 1 ? '' : 's'} resident and ${detail}`,
    )
    this.name = 'WarmSetFullError'
  }
}

/** One resident database plus the bookkeeping the router needs. */
export class WarmEntry {
  readonly name: string
  readonly instance: RoutedInstance
  readonly queue: import('./wire-queue.js').QueryQueue
  readonly handshake: import('./handshake.js').Handshake
  /** Connections currently attached. An entry with refs > 0 is in use. */
  refs = 0
  /** Monotonic clock reading at the last attach or detach, for LRU. */
  lastUsedAt: number
  /**
   * Step 1 of the eviction protocol: stop accepting NEW connections for this
   * database. Set before anything destructive happens, so a connection that
   * arrives mid-eviction waits for a fresh instance instead of attaching to one
   * whose lease is about to be released.
   */
  evicting = false
  /**
   * Set when a flush failed during eviction. Section 5 of the spec: refusing to
   * evict is always better than losing writes, so a database that could not be
   * flushed stays warm and the evictor picks a different one. Recorded rather
   * than merely returned so the same database is not retried on every admission
   * until its flush starts working again.
   */
  lastFlushError: string | null = null

  constructor(
    name: string,
    instance: RoutedInstance,
    queue: import('./wire-queue.js').QueryQueue,
    handshake: import('./handshake.js').Handshake,
    now: () => number,
  ) {
    this.name = name
    this.instance = instance
    this.queue = queue
    this.handshake = handshake
    this.lastUsedAt = now()
  }
}
