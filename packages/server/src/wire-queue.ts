// Per-instance serialized query queue.
//
// PGlite is ONE Postgres session shared by every connection routed to it. That
// is not a pooling detail, it is a correctness constraint: if two connections'
// protocol messages interleave, a `BEGIN` from one lands inside the other's
// transaction and both see the wrong snapshot.
//
// The rule, ported from @electric-sql/pglite-socket's QueryQueueManager because
// it is the piece that makes transactions work at all:
//
//   - Messages execute strictly one at a time, in arrival order.
//   - EXCEPT while the backend reports it is inside a transaction, in which
//     case only messages from the handler that opened it are eligible. Every
//     other handler waits. Without this, `BEGIN; UPDATE; COMMIT` from one
//     client and a concurrent `INSERT` from another produce a transaction that
//     silently contains the other client's write.
//   - A handler that disconnects mid-transaction leaves the shared session in
//     an open transaction that would block the whole database forever, so its
//     departure issues a ROLLBACK.
//
// Fairness caveat, inherited and deliberate: a handler that opens a transaction
// and then goes quiet stalls every other handler until it commits, rolls back,
// or disconnects. That is the price of one session, and it is why section 7 of
// the router spec says this is not a connection pooler.

/** The subset of PGlite the wire path drives. Kept structural so this module
 *  never imports @electric-sql/pglite, which is an optional peer. */
export interface ProtocolEngine {
  execProtocolRawStream(
    message: Uint8Array,
    options: { onRawData: (data: Uint8Array) => void; syncToFs?: boolean },
  ): Promise<void>
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  isInTransaction(): boolean
  exec(sql: string): Promise<unknown>
}

interface QueueItem {
  handlerId: number
  message: Uint8Array
  onData: (data: Uint8Array) => void
  resolve: (bytes: number) => void
  reject: (err: unknown) => void
}

/** Thrown into a handler's pending messages when it is dropped (disconnect, or
 *  an eviction failing in-flight work). */
export class HandlerGoneError extends Error {
  constructor(handlerId: number, reason: string) {
    super(`wire handler #${handlerId} dropped: ${reason}`)
    this.name = 'HandlerGoneError'
  }
}

export class QueryQueue {
  private readonly queue: QueueItem[] = []
  private processing = false
  /** The handler whose message ran last. Only meaningful while the backend
   *  reports an open transaction, where it identifies the transaction's owner. */
  private lastHandlerId: number | null = null

  constructor(private readonly engine: ProtocolEngine) {}

  get length(): number {
    return this.queue.length
  }

  /** True when nothing is queued and nothing is executing. */
  get idle(): boolean {
    return !this.processing && this.queue.length === 0
  }

  /**
   * Resolve once the queue is drained and no message is executing.
   *
   * Eviction needs this: a message already inside `execProtocolRawStream`
   * cannot be cancelled, and flushing while it runs would race a write that is
   * still being applied. Rejects on timeout so a wedged backend turns into
   * "refuse to evict this database" rather than an eviction that hangs the
   * router.
   */
  async whenIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.idle) {
      if (Date.now() >= deadline) {
        throw new Error(`queue did not go idle within ${timeoutMs}ms`)
      }
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  /** True when the shared session is inside a transaction owned by `handlerId`. */
  ownsOpenTransaction(handlerId: number): boolean {
    return this.engine.isInTransaction() && this.lastHandlerId === handlerId
  }

  /** Queue one frontend message. Resolves with the number of backend bytes the
   *  engine produced for it (all of which were already handed to `onData`). */
  enqueue(
    handlerId: number,
    message: Uint8Array,
    onData: (data: Uint8Array) => void,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.queue.push({ handlerId, message, onData, resolve, reject })
      if (!this.processing) void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const item = this.take()
        // Only reachable when a transaction is open and its owner has nothing
        // queued: every other item must wait, so there is nothing to run now.
        // The owner's next message (or its disconnect ROLLBACK) restarts us.
        if (!item) break
        let bytes = 0
        try {
          await this.engine.runExclusive(async () => {
            await this.engine.execProtocolRawStream(item.message, {
              onRawData: (d) => {
                bytes += d.length
                item.onData(d)
              },
            })
          })
        } catch (e) {
          item.reject(e)
          // Keep draining: one handler's protocol error must not wedge the
          // database for every other connection.
          continue
        }
        this.lastHandlerId = item.handlerId
        item.resolve(bytes)
      }
    } finally {
      this.processing = false
    }
  }

  private take(): QueueItem | null {
    if (this.engine.isInTransaction() && this.lastHandlerId !== null) {
      const i = this.queue.findIndex((q) => q.handlerId === this.lastHandlerId)
      return i === -1 ? null : this.queue.splice(i, 1)[0]!
    }
    return this.queue.shift() ?? null
  }

  /** Drop every queued message belonging to a handler, rejecting its waiters. */
  clearForHandler(handlerId: number, reason = 'disconnected'): number {
    let dropped = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.handlerId === handlerId) {
        this.queue.splice(i, 1)[0]!.reject(new HandlerGoneError(handlerId, reason))
        dropped++
      }
    }
    return dropped
  }

  /** Drop EVERY queued message. Used when a database is being evicted: its
   *  in-flight work is failed rather than executed against an instance that is
   *  about to close. */
  clearAll(reason: string): number {
    const n = this.queue.length
    while (this.queue.length) {
      const item = this.queue.pop()!
      item.reject(new HandlerGoneError(item.handlerId, reason))
    }
    return n
  }

  /**
   * If `handlerId` owns an open transaction on the shared session, roll it
   * back. A disconnect inside `BEGIN` would otherwise leave the session in a
   * transaction that no live handler can ever end, and the affinity rule above
   * would then starve every other connection permanently.
   */
  async rollbackIfOwned(handlerId: number): Promise<boolean> {
    if (!this.ownsOpenTransaction(handlerId)) return false
    try {
      await this.engine.exec('ROLLBACK')
    } catch {
      // Best effort. If the engine is already gone there is nothing to unwind.
    }
    this.lastHandlerId = null
    if (!this.processing) void this.drain()
    return true
  }
}
