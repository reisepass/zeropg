// THE single implementation of "materialize a detached snapshot of a remote
// zeropg instance and serve it on a local Postgres wire". Used by:
//   - the local console (serve.ts serveReplica)
//   - the cloud inspector (examples/cloudrun/inspector - deploy.sh copies this
//     file into the image build context; edit HERE, never the copy)
//
// Plain .mjs on purpose: it must run under tsx (console) and plain node
// (inspector image) without a build step.
//
// A replica is a throwaway copy: NO lease, NO fencing, the live service is
// untouched; writes land in the copy and die with it. Re-open to refresh.

/**
 * @param {object} opts
 * @param {string} opts.bucket   GCS bucket name
 * @param {string} opts.prefix   instance prefix inside the bucket
 * @param {string} [opts.host]   wire bind host (default 127.0.0.1 - keep it)
 * @param {number} [opts.port]   wire port (default 0 = OS-assigned)
 * @param {number} [opts.maxConnections]
 * @returns {Promise<{ port: number, host: string, url: string, stop: () => Promise<void> }>}
 */
export async function openReplicaWire({ bucket, prefix, host = '127.0.0.1', port = 0, maxConnections = 10 }) {
  const [{ GcsBlobStore }, { ZeroPGReplica }, { PGLiteSocketServer }] = await Promise.all([
    import('@zeropg/blobstore'),
    import('@zeropg/objectstore-fs'),
    import('@electric-sql/pglite-socket'),
  ])
  const replica = await ZeroPGReplica.open({
    store: new GcsBlobStore({ bucket, prefix }),
    pollIntervalMs: 0, // fixed snapshot; re-open to refresh
  })
  // The replica pins its session read-only; the copy is throwaway, so let
  // tools write freely (scratch experiments, studio bootstrap schema).
  await replica.raw.exec('SET default_transaction_read_only = off')
  let boundPort = port
  if (!boundPort) {
    // PGLiteSocketServer needs a concrete port; mint an OS-assigned one.
    const { createServer } = await import('node:net')
    boundPort = await new Promise((res, rej) => {
      const srv = createServer()
      srv.once('error', rej)
      srv.listen(0, host, () => {
        const p = srv.address().port
        srv.close(() => res(p))
      })
    })
  }
  const wire = new PGLiteSocketServer({ db: replica.raw, host, port: boundPort, maxConnections })
  await wire.start()
  return {
    port: boundPort,
    host,
    url: `postgresql://postgres@127.0.0.1:${boundPort}/postgres?sslmode=disable`,
    stop: async () => {
      await wire.stop()
      await replica.close()
    },
  }
}

/**
 * Keyed manager with an LRU cap - each open replica is a full PGlite in
 * memory, so unbounded opens are an OOM (the inspector learned this first;
 * now both surfaces share the cap).
 * @param {{ maxOpen?: number, log?: (msg: string) => void }} [opts]
 */
export function createReplicaManager({ maxOpen = 3, log = () => {} } = {}) {
  /** @type {Map<string, { port: number, host: string, url: string, openedAt: number, stop: () => Promise<void> }>} */
  const open = new Map()
  return {
    list: () => [...open.entries()].map(([key, e]) => ({ key, port: e.port, openedAt: e.openedAt })),
    get: (key) => open.get(key),
    async ensure(key, opts) {
      const existing = open.get(key)
      if (existing) {
        existing.openedAt = Date.now()
        return existing
      }
      while (open.size >= maxOpen) {
        const [oldKey, oldest] = [...open.entries()].sort((a, b) => a[1].openedAt - b[1].openedAt)[0]
        log(`closing LRU replica ${oldKey}`)
        await oldest.stop().catch(() => {})
        open.delete(oldKey)
      }
      log(`materializing ${key} from gs://${opts.bucket}/${opts.prefix}`)
      const wire = await openReplicaWire(opts)
      const entry = { ...wire, openedAt: Date.now() }
      open.set(key, entry)
      return entry
    },
    async close(key) {
      const e = open.get(key)
      if (!e) return false
      open.delete(key)
      await e.stop()
      return true
    },
    async closeAll() {
      await Promise.allSettled([...open.values()].map((e) => e.stop()))
      open.clear()
    },
  }
}
