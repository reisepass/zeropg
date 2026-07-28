// Shared harness for the pg-gateway experiments.
//
// Two server shapes over ONE PGlite instance, so the only variable between them
// is how concurrent connections are serialized:
//
//   'naive'    - what the existing spike does: db.runExclusive(execProtocolRaw)
//                per message, with no cross-connection ordering.
//   'affinity' - the transaction-affinity queue ported from pglite-socket 0.2.2
//                (QueryQueueManager), which is what actually preserves isolation.
//
// Everything else (handshake, auth, framing) is pg-gateway in both cases.

import { createServer, type Server, type Socket } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from 'pg-gateway/node'
import { QueryQueueManager } from './query-queue.ts'

export type Serialization = 'naive' | 'affinity'

export interface GatewayOptions {
  serialization: Serialization
  db: PGlite
  debug?: boolean
  /** Passed straight through to pg-gateway (tls, auth, ...). */
  gatewayOptions?: Record<string, unknown>
  /** Rewrite/inspect each inbound message before it reaches PGlite. */
  onRaw?: (data: Uint8Array, connId: number) => Uint8Array
  /** Inspect/rewrite each outbound chunk before it reaches the client. */
  onOut?: (data: Uint8Array, connId: number) => Uint8Array
  /** Called when a connection closes, for per-connection cleanup. */
  onClose?: (connId: number) => void
}

export interface Gateway {
  url: string
  port: number
  db: PGlite
  queue?: QueryQueueManager
  connections: () => number
  stop: () => Promise<void>
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(p))
    })
  })
}

export async function serve(opts: GatewayOptions): Promise<Gateway> {
  const { db, serialization, debug = false } = opts
  const port = await freePort()
  const sockets = new Set<Socket>()
  const queue = serialization === 'affinity' ? new QueryQueueManager(db, debug) : undefined
  let connSeq = 0

  const server: Server = createServer((socket) => {
    const connId = ++connSeq
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      queue?.clearQueueForHandler(connId)
      void queue?.clearTransactionIfNeeded(connId)
      opts.onClose?.(connId)
    })
    socket.on('error', () => {
      /* client RST during a torn-down transaction is expected in some tests */
    })

    fromNodeSocket(socket, {
      serverVersion: '16.3',
      auth: { method: 'trust' },
      ...(opts.gatewayOptions ?? {}),
      async onStartup() {
        await db.waitReady
      },
      async onMessage(data: Uint8Array, { isAuthenticated }: { isAuthenticated: boolean }) {
        if (!isAuthenticated) return
        const msg = opts.onRaw ? opts.onRaw(data, connId) : data
        const emit = (chunk: Uint8Array): Uint8Array =>
          opts.onOut ? opts.onOut(chunk, connId) : chunk

        if (queue) {
          const chunks: Uint8Array[] = []
          await queue.enqueue(connId, msg, (chunk) => chunks.push(emit(chunk)))
          return chunks
        }
        // naive shape, exactly as experiments/prisma-spike/pggw.ts does it
        const out = await db.runExclusive(() => db.execProtocolRaw(msg))
        return emit(out)
      },
    }).catch((e: unknown) => {
      if (debug) console.error(`[conn#${connId}] ${e instanceof Error ? e.message : e}`)
      socket.destroy()
    })
  })

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))

  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    port,
    db,
    queue,
    connections: () => sockets.size,
    async stop() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
