// Local single-writer Postgres, addressable by a plain postgres:// URL so ANY
// ORM or tool (Drizzle, Prisma, drizzle-kit, psql) uses it with no special
// driver. This is what makes the laptop->remote move a pure DATABASE_URL change.
//
//   resolve(DATABASE_URL):
//     postgres://… / postgresql://…   -> returned unchanged (remote / real PG)
//     file:<path>  / file://<path>    -> a LOCAL in-process Postgres over <path>:
//     pglite:<path>                       the FIRST process to open <path> becomes
//                                         the LEADER (opens PGlite + an in-process
//                                         pglite-socket wire on a free port, and
//                                         records {pid,host,port} in the datadir
//                                         lock file). Later processes are
//                                         FOLLOWERS: they read the port and connect
//                                         over loopback. One writer, many clients.
//
// The lock file is the existing `<datadir>.zeropg.lock`, now also carrying the
// leader's port so followers can discover it. Dead-leader reclaim is the same
// liveness-probed protocol as the embedded lock, so a crashed leader is taken
// over by the next caller rather than wedging the datadir.

import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { acquireDatadirLock, lockPathFor, type DatadirLock } from './lockfile.js'
import { serveWire, type WireServer } from './wire.js'

/** A resolved database endpoint. `url` is always a real postgres:// URL. */
export interface LocalHandle {
  /** A postgres:// URL any ORM / pg client can connect to. */
  readonly url: string
  /** True if THIS process is the leader hosting the engine (vs a follower/remote). */
  readonly leader: boolean
  /** Leader: stop the wire + release the lock. Follower / remote: no-op. */
  close(): Promise<void>
}

export interface ResolveOptions {
  /** Max time to wait out a starting leader / election race (ms). Default 15s. */
  timeoutMs?: number
}

interface LeaderRecord {
  pid: number
  host: string
  /** Present once the leader's wire is listening; absent during mid-start. */
  port?: number
  acquiredAt: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const urlFor = (port: number): string => `postgres://127.0.0.1:${port}/postgres`

/** A leader on THIS host is alive iff its PID exists; a leader on another host
 * can't be probed, so assume alive (never steal another machine's datadir). */
function isAlive(rec: LeaderRecord): boolean {
  if (rec.host !== hostname()) return true
  try {
    process.kill(rec.pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLeader(lockPath: string): Promise<LeaderRecord | null> {
  try {
    const rec = JSON.parse(await readFile(lockPath, 'utf8')) as LeaderRecord
    return typeof rec.pid === 'number' && typeof rec.host === 'string' ? rec : null
  } catch {
    return null
  }
}

function schemeOf(url: string): string {
  return (/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '').toLowerCase()
}

/**
 * Resolve a DATABASE_URL to a concrete `postgres://` URL. For `file:`/`pglite:`
 * targets this elects or attaches a local in-process Postgres; for `postgres:`
 * it is a passthrough. Reads `process.env.DATABASE_URL` when no argument given.
 */
export async function resolveDatabaseUrl(
  databaseUrl?: string,
  opts: ResolveOptions = {},
): Promise<LocalHandle> {
  const target = databaseUrl ?? process.env.DATABASE_URL
  if (!target) {
    throw new Error('resolveDatabaseUrl: no argument and process.env.DATABASE_URL is unset')
  }
  const scheme = schemeOf(target)
  if (scheme === 'postgres' || scheme === 'postgresql') {
    return { url: target, leader: false, close: async () => {} }
  }
  if (scheme === 'file' || scheme === 'pglite') {
    const path = target
      .replace(/^file:/i, '')
      .replace(/^pglite:/i, '')
      .replace(/^\/\//, '')
    if (!path) throw new Error(`resolveDatabaseUrl: ${target} has no path (use file:./pgdata)`)
    return electLocal(resolvePath(path), opts)
  }
  throw new Error(`resolveDatabaseUrl: unsupported scheme '${scheme}:' in ${target}`)
}

/** Alias matching the discussed `zeropg.resolve(...)` surface. */
export const resolve = resolveDatabaseUrl

async function electLocal(dataDir: string, opts: ResolveOptions): Promise<LocalHandle> {
  const lockPath = lockPathFor(dataDir)
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)

  for (;;) {
    // 1. Follower fast-path: a live leader already serves this datadir.
    const rec = await readLeader(lockPath)
    if (rec && isAlive(rec)) {
      if (rec.port) return { url: urlFor(rec.port), leader: false, close: async () => {} }
      // Lock held but no port yet -> leader is mid-start. Wait and re-check.
      if (Date.now() > deadline) throw new Error(`resolveDatabaseUrl: timed out waiting for the leader to start on ${dataDir}`)
      await sleep(40)
      continue
    }

    // 2. No live leader (free or dead lock). Try to become the leader.
    let lock: DatadirLock
    try {
      lock = await acquireDatadirLock(dataDir, { acquireTimeoutMs: 2_000 })
    } catch {
      // Lost the race to another would-be leader; loop and read its port.
      if (Date.now() > deadline) throw new Error(`resolveDatabaseUrl: timed out racing for the leader on ${dataDir}`)
      continue
    }

    // 3. We won. Start the in-process wire (skip its lock; we already hold it).
    let wire: WireServer
    try {
      wire = await serveWire({ dataDir, nativeDatadirLock: true })
    } catch (e) {
      await lock.release()
      throw e
    }

    // 4. Publish the port into the lock record so followers can find us. Keep
    //    pid/host so the lock's ownership-checked release still matches.
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        port: wire.port,
        acquiredAt: new Date().toISOString(),
      } satisfies LeaderRecord),
    )

    return makeLeader(lock, wire)
  }
}

function makeLeader(lock: DatadirLock, wire: WireServer): LocalHandle {
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await wire.stop() // stops the socket server + closes PGlite
    await lock.release()
  }
  // Best-effort: a Ctrl-C / SIGTERM frees the lock + port for the next leader,
  // instead of leaving a stale record the successor has to reclaim.
  const onSignal = (): void => {
    void close().finally(() => process.exit(0))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return { url: urlFor(wire.port), leader: true, close }
}
