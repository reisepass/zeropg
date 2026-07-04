// Serve manager + studio launcher for the console.
//
// serve:  turn a local datadir into a live postgres:// URL on demand
//         (serveWire), so any tool - psql, TablePlus, DataGrid - can open it.
// studio: launch zeroSupabaseStudio (BFF + postgres-meta in Docker) against
//         any wire the console can produce:
//           - a local datadir  -> its served wire (read-write, the real DB)
//           - a remote instance -> a ZeroPGReplica materialized from its
//             bucket: NO lease, NO fencing, the live service is untouched; a
//             detached throwaway copy, so poking at it is consequence-free.
//
// Studio lives in the repo (examples/cloudrun/supabase/studio), so studio
// launch works from a zeropg checkout; the error says so when it is missing.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer as createNetServer } from 'node:net'
import { serveWire, type WireServer } from '@zeropg/client'
import type { Instance } from '../fleet/types.js'

/** OS-assigned free TCP port (so parallel studio/pg-meta stacks - e.g. the
 *  studio's own up-local harness on 4321/4322 - are never trampled). */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => res(port))
    })
  })
}

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------- serving ----

export interface Served {
  kind: 'local' | 'replica'
  /** Datadir path (local) or context/service (replica). */
  id: string
  port: number
  url: string
  /** Copy of the wire host binding; 0.0.0.0 is needed for Docker (studio). */
  host: string
  stop(): Promise<void>
}

const served = new Map<string, Served>()

export function listServed(): Array<Omit<Served, 'stop'>> {
  return [...served.values()].map(({ stop: _stop, ...rest }) => rest)
}

/** Serve a local datadir on a loopback wire. Idempotent per path. */
export async function serveLocal(path: string, opts: { host?: string } = {}): Promise<Served> {
  const abs = resolve(path)
  const host = opts.host ?? '127.0.0.1'
  const existing = served.get(abs)
  if (existing) {
    // Re-serve on a wider binding when studio needs Docker to reach it.
    if (host === '0.0.0.0' && existing.host !== '0.0.0.0') await stopServed(abs)
    else return existing
  }
  const wire: WireServer = await serveWire({ dataDir: abs, host, port: 0 })
  const entry: Served = {
    kind: 'local',
    id: abs,
    port: wire.port,
    host,
    url: `postgresql://postgres@127.0.0.1:${wire.port}/postgres?sslmode=disable`,
    stop: async () => {
      served.delete(abs)
      await wire.stop()
    },
  }
  served.set(abs, entry)
  return entry
}

/** Serve a detached snapshot of a remote instance's bucket state. */
export async function serveReplica(inst: Instance, opts: { host?: string } = {}): Promise<Served> {
  if (!inst.bucket || !inst.prefix) throw new Error(`${inst.name}: no bucket/prefix on the service`)
  const key = `${inst.context}/${inst.name}`
  const existing = served.get(key)
  if (existing) return existing
  const host = opts.host ?? '127.0.0.1'
  const [{ GcsBlobStore }, { ZeroPGReplica }, { PGLiteSocketServer }] = await Promise.all([
    import('@zeropg/blobstore'),
    import('@zeropg/objectstore-fs'),
    import('@electric-sql/pglite-socket'),
  ])
  const replica = await ZeroPGReplica.open({
    store: new GcsBlobStore({ bucket: inst.bucket, prefix: inst.prefix }),
    pollIntervalMs: 0, // a fixed snapshot; relaunch to refresh
  })
  // The replica pins its session read-only; the scratch copy is throwaway, so
  // let studio write (its own bootstrap schema, scratch experiments) freely.
  await replica.raw.exec('SET default_transaction_read_only = off')
  const port = await freePort()
  const wire = new PGLiteSocketServer({ db: replica.raw, host, port, maxConnections: 10 })
  await wire.start()
  const entry: Served = {
    kind: 'replica',
    id: key,
    port,
    host,
    url: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    stop: async () => {
      served.delete(key)
      await wire.stop()
      await replica.close()
    },
  }
  served.set(key, entry)
  return entry
}

export async function stopServed(id: string): Promise<boolean> {
  const entry = served.get(resolve(id)) ?? served.get(id)
  if (!entry) return false
  await entry.stop()
  return true
}

export async function stopAllServed(): Promise<void> {
  await Promise.allSettled([...served.values()].map((s) => s.stop()))
}

// ---------------------------------------------------------------- studio ----

export interface StudioHandle {
  url: string
  adminPassword: string
  /** What the studio is looking at. */
  target: string
  kind: 'local' | 'replica'
  stop(): Promise<void>
}

let studio: StudioHandle | null = null

function studioDir(): string {
  // console/serve.ts -> packages/cli/src -> repo root
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', '..', '..', 'examples', 'cloudrun', 'supabase', 'studio')
}

export function currentStudio(): StudioHandle | null {
  return studio
}

/**
 * Launch (or relaunch) the studio against a wire. One studio at a time - a
 * new launch stops the previous one first.
 */
export async function launchStudio(target: { kind: 'local'; path: string } | { kind: 'replica'; inst: Instance }): Promise<StudioHandle> {
  const dir = studioDir()
  if (!existsSync(join(dir, 'lib', 'harness.mjs'))) {
    throw new Error('studio launch needs the zeropg repo checkout (examples/cloudrun/supabase/studio not found next to the CLI)')
  }
  await execFileAsync('docker', ['info']).catch(() => {
    throw new Error('studio needs Docker running (postgres-meta runs as a container)')
  })

  if (studio) {
    await studio.stop().catch(() => {})
    studio = null
  }

  // Docker's host.docker.internal cannot reach a 127.0.0.1-bound wire on
  // macOS; studio wires bind 0.0.0.0. LAN exposure of an unauthenticated wire
  // is the tradeoff - same as the studio's own local harness.
  const wire =
    target.kind === 'local' ? await serveLocal(target.path, { host: '0.0.0.0' }) : await serveReplica(target.inst, { host: '0.0.0.0' })

  const { bringUp } = (await import(join(dir, 'lib', 'harness.mjs'))) as {
    bringUp: (opts: Record<string, unknown>) => Promise<{ base: string; cfg: { adminPassword: string }; stop(): Promise<void> }>
  }
  const [metaPort, bffPort] = await Promise.all([freePort(), freePort()])
  const h = await bringUp({ existingWire: true, wirePort: wire.port, metaPort, bffPort, quiet: true, log: () => {} })
  const label = target.kind === 'local' ? target.path : `${target.inst.name} (detached snapshot)`
  studio = {
    url: `${h.base}/studio`,
    adminPassword: h.cfg.adminPassword,
    target: label,
    kind: target.kind,
    stop: async () => {
      studio = null
      await h.stop()
    },
  }
  return studio
}

export async function stopStudio(): Promise<boolean> {
  if (!studio) return false
  await studio.stop()
  return true
}
