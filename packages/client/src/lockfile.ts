// E1, layer 1 — cross-process datadir lock.
//
// PGlite is single-connection / single-process and the NodeFS backend has no
// cross-process guard, so two processes (a hot-reloading dev server's old + new
// instance, two `tsx watch` runs, nodemon overlap) opening the same datadir tear
// the files. We own this in the connect() layer: a sibling `<datadir>.lock`
// file created with O_EXCL ('wx') holding the owner PID. This is the local
// analog of the remote single-writer lease (DESIGN §7) — `O_EXCL` and
// `If-None-Match: *` are the same atomic create-if-absent primitive in two
// media. We replicate upstream PGlite PR #892's `.lock` + takeover externally
// (no fork) and do not depend on it landing.
//
// Reclaim semantics mirror the lease's stale-holder takeover: if the recorded
// PID is dead (process.kill(pid, 0) -> ESRCH), the lock is stale and we take it
// over; if it is alive, we wait it out up to acquireTimeoutMs (the same boot-wait
// the Cloud Run revision-switch double-instance window already uses).

import { open, readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'

/** A held cross-process lock. Call release() exactly once when closing. */
export interface DatadirLock {
  /** Absolute path of the lock file. */
  readonly path: string
  release(): Promise<void>
}

interface LockRecord {
  pid: number
  host: string
  /** ISO time the lock was taken — for diagnostics only, never for liveness. */
  acquiredAt: string
}

export interface AcquireOptions {
  /** How long to wait out a live holder before giving up. Default 10s. */
  acquireTimeoutMs?: number
  /** Poll cadence while waiting out a live holder. Default 100ms. */
  pollIntervalMs?: number
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable liveness probe (tests). Default: process.kill(pid, 0). */
  isAlive?: (rec: LockRecord) => boolean
}

/** Thrown when a live holder did not release within acquireTimeoutMs. */
export class LockTimeoutError extends Error {
  constructor(path: string, holder: LockRecord, waitedMs: number) {
    super(
      `datadir lock ${path} held by live pid ${holder.pid} on ${holder.host} ` +
        `(since ${holder.acquiredAt}); waited ${waitedMs}ms`,
    )
    this.name = 'LockTimeoutError'
  }
}

const sameHost = (rec: LockRecord): boolean => rec.host === hostname()

/** A holder on THIS host is alive iff its PID exists. A holder on a DIFFERENT
 * host can't be probed with process.kill, so we conservatively treat it as
 * alive and wait it out (never steal another machine's lock on a PID guess). */
function defaultIsAlive(rec: LockRecord): boolean {
  if (!sameHost(rec)) return true
  try {
    process.kill(rec.pid, 0)
    return true
  } catch (e) {
    // ESRCH -> no such process (dead). EPERM -> exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readHolder(path: string): Promise<LockRecord | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const rec = JSON.parse(raw) as LockRecord
    if (typeof rec.pid === 'number' && typeof rec.host === 'string') return rec
    return null // unparseable contents — treat as a stale/corrupt lock
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Acquire the cross-process lock for `dataDir`. The lock file is a sibling
 * `<dataDir>.lock` so it never collides with PGlite's own files and works
 * whether or not the datadir exists yet. */
export async function acquireDatadirLock(
  dataDir: string,
  opts: AcquireOptions = {},
): Promise<DatadirLock> {
  const lockPath = `${dataDir.replace(/[/\\]+$/, '')}.lock`
  const timeoutMs = opts.acquireTimeoutMs ?? 10_000
  const pollMs = opts.pollIntervalMs ?? 100
  const now = opts.now ?? (() => Date.now())
  const isAlive = opts.isAlive ?? defaultIsAlive

  await mkdir(dirname(lockPath), { recursive: true })

  const record: LockRecord = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date(now()).toISOString(),
  }

  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx')
      try {
        await fh.writeFile(JSON.stringify(record))
      } finally {
        await fh.close()
      }
      return makeLock(lockPath)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }

    // The lock exists. Inspect the holder.
    const holder = await readHolder(lockPath)
    if (holder === null) {
      // Vanished between create and read (released), or corrupt — retry create.
      continue
    }
    if (!isAlive(holder)) {
      // Stale: holder is dead. Take it over. unlink then re-race the create;
      // a concurrent reclaimer that wins the create just sends us back to the
      // "lock exists, holder now live" branch, which waits correctly.
      await unlink(lockPath).catch(() => {})
      continue
    }
    // Live holder — wait it out (the hot-reload overlap / revision-switch window).
    if (now() >= deadline) throw new LockTimeoutError(lockPath, holder, timeoutMs)
    await sleep(pollMs)
  }
}

function makeLock(path: string): DatadirLock {
  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      // Only unlink if we still own it (defensive: a reclaimer may have stolen a
      // lock we thought was ours if our process stalled past the holder's view of
      // liveness). Best-effort; a stray lock is reclaimed by the next acquirer.
      const holder = await readHolder(path)
      if (holder && holder.pid === process.pid && holder.host === hostname()) {
        await unlink(path).catch(() => {})
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
