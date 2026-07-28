// Transaction-affinity queue, ported literally from @electric-sql/pglite-socket
// 0.2.2 `class QueryQueueManager` (src/index.ts, recovered from the shipped
// dist/chunk-TORNJX5U.js.map sourcesContent - see vendor/pglite-socket-0.2.2.src.ts).
//
// This is the ONLY thing in pglite-socket worth taking, and it is the thing
// pg-gateway does not have. pg-gateway serializes nothing across connections:
// each onMessage independently calls runExclusive, which orders individual
// protocol messages but knows nothing about transaction boundaries. So while
// connection A sits inside BEGIN..COMMIT, connection B's messages interleave
// into A's open transaction on the single shared PGlite backend.
//
// The rule this class adds: while db.isInTransaction() is true, only dequeue
// messages from the handler that opened the transaction (lastHandlerId).
//
// PORTED DELIBERATELY UNCHANGED, stall behaviour and all:
//
//   `query = null` then `if (!query) break` on line "no query from the same
//   handler found" is LOAD-BEARING. When a transaction is open but its owning
//   connection has nothing queued, the loop must STOP rather than fall through
//   to another connection's message. It exits the drain loop, sets
//   processing=false, and the next enqueue() restarts processing. Replacing the
//   break with `continue` spins forever; replacing it with "serve someone else"
//   reintroduces exactly the isolation bug this class exists to prevent.
//
// Changes from upstream, both deliberate:
//   1. `private` -> readable field names kept, but the class is exported.
//   2. Local type import instead of pglite-socket's internal one.
// No behavioural change.

import type { PGlite } from '@electric-sql/pglite'

interface QueuedQuery {
  handlerId: number
  message: Uint8Array
  resolve: (resultSize: number) => void
  reject: (error: Error) => void
  timestamp: number
  onData: (data: Uint8Array) => void
}

export class QueryQueueManager {
  private queue: QueuedQuery[] = []
  private processing = false
  private db: PGlite
  private debug: boolean
  private lastHandlerId: null | number = null

  constructor(db: PGlite, debug = false) {
    this.db = db
    this.debug = debug
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.debug) {
      console.log(`[QueryQueueManager] ${message}`, ...args)
    }
  }

  async enqueue(
    handlerId: number,
    message: Uint8Array,
    onData: (data: Uint8Array) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const query: QueuedQuery = {
        handlerId,
        message,
        resolve,
        reject,
        timestamp: Date.now(),
        onData,
      }

      this.queue.push(query)
      this.log(`enqueued query from handler #${handlerId}, queue size: ${this.queue.length}`)

      // Process queue if not already processing
      if (!this.processing) {
        void this.processQueue()
      }
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return
    }

    this.processing = true

    while (this.queue.length > 0) {
      let query: QueuedQuery | null | undefined

      if (this.db.isInTransaction() && this.lastHandlerId) {
        const i = this.queue.findIndex((q) => q.handlerId === this.lastHandlerId)
        if (i === -1) {
          // we didn't find any other query from the same client!
          this.log(
            'transaction started, but no query from the same handler id found in queue',
            this.lastHandlerId,
          )
          query = null
        } else {
          query = this.queue.splice(i, 1)[0]
        }
      } else {
        query = this.queue.shift()
      }
      // load-bearing: see the header comment. Do not turn this into `continue`.
      if (!query) break

      const waitTime = Date.now() - query.timestamp
      this.log(`processing query from handler #${query.handlerId} (waited ${waitTime}ms)`)

      let result = 0
      try {
        // Execute the query with exclusive access to PGlite
        await this.db.runExclusive(async () => {
          return await this.db.execProtocolRawStream(query.message, {
            onRawData: (data: Uint8Array) => {
              result += data.length
              query.onData(data)
            },
          })
        })
      } catch (error) {
        this.log(`query from handler #${query.handlerId} failed:`, error)
        query.reject(error as Error)
        return
      }

      this.log(`query from handler #${query.handlerId} completed, ${result} bytes`)
      this.lastHandlerId = query.handlerId
      query.resolve(result)
    }

    this.processing = false
    this.log('queue processing complete, queue length is', this.queue.length)
  }

  getQueueLength(): number {
    return this.queue.length
  }

  clearQueueForHandler(handlerId: number): void {
    const before = this.queue.length
    this.queue = this.queue.filter((q) => {
      if (q.handlerId === handlerId) {
        q.reject(new Error('Handler disconnected'))
        return false
      }
      return true
    })
    const removed = before - this.queue.length
    if (removed > 0) {
      this.log(`cleared ${removed} queries for handler #${handlerId}`)
    }
  }

  async clearTransactionIfNeeded(handlerId: number): Promise<void> {
    if (this.db.isInTransaction() && this.lastHandlerId === handlerId) {
      await this.db.exec('ROLLBACK')
      this.lastHandlerId = null
      await this.processQueue()
    }
  }
}
