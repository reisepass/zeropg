// E1, layer 1 — cross-process datadir lock.
//
// PGlite is single-connection / single-process and the NodeFS backend has no
// cross-process guard, so two processes (a hot-reloading dev server's old + new
// instance, two `tsx watch` runs, nodemon overlap) opening the same datadir tear
// the files. We own this in the connect() layer: a sibling `<datadir>.lock`
// file created with O_EXCL ('wx') holding the owner PID. This is the local
// analog of the remote single-writer lease (DESIGN §7) — `O_EXCL` and
// `If-None-Match: *` are the same atomic create-if-absent primitive in two
// media.
//
// The canonical, battle-tested version of this protocol lives INSIDE PGlite's
// NodeFS in the fork at reisepass/pglite-kill-dash-9 (upstream PR #892), whose
// stress lab found three protocol bugs that naive lockfile code hits. This
// module is the wrapper-level guard for as long as zeropg consumes a stock
// PGlite (0.5.x ships no dataDir lock); it deliberately mirrors that protocol's
// two non-obvious fixes:
//
//   1. RECLAIM UNDER A CLAIM MUTEX, not read-then-unlink. Two processes that both
//      observe the same dead-holder record and each unlink+recreate can deadlock
//      into two owners (the loser unlinks the winner's FRESH lock). Reclaim is
//      serialized by an exclusive `mkdir(<lock>.claim)`; only the mutex holder
//      removes the stale lock, after re-validating it under the mutex.
//   2. A 'pending' CLASSIFICATION for an unparseable-but-recent lock. `wx` open
//      and the token write are two steps; a reader in between sees an empty file.
//      Treating "empty/garbage" as stale would steal a lock that is being born.
//      Recent-and-unparseable => pending (wait); old-and-unparseable => corrupt
//      (reclaimable).

import { open, readFile, unlink, mkdir, rmdir, stat } from 'node:fs/promises'
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
  /** Poll cadence while waiting out a live holder / a pending writer. Default 50ms. */
  pollIntervalMs?: number
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable liveness probe (tests). Default: process.kill(pid, 0). */
  isAlive?: (rec: LockRecord) => boolean
}

/** Thrown when a live holder did not release within acquireTimeoutMs. */
export class LockTimeoutError extends Error {
  constructor(path: string, detail: string, waitedMs: number) {
    super(`datadir lock ${path}: ${detail}; waited ${waitedMs}ms`)
    this.name = 'LockTimeoutError'
  }
}

// An unparseable lock younger than this is a writer mid-birth (between its `wx`
// open and its token write), not a corpse — wait for it, never steal it.
const PENDING_MS = 10_000
// A claim mutex (`<lock>.claim` dir) older than this belongs to a crashed
// claimer; the next reclaimer may remove it and proceed.
const CLAIM_STALE_MS = 5_000

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

type Inspection =
  | { state: 'gone' } // the lock vanished (released) — try to create it
  | { state: 'pending' } // unparseable but recent — a writer mid-birth; wait
  | { state: 'live'; rec: LockRecord } // a living holder — wait it out
  | { state: 'reclaimable'; rec: LockRecord | null } // dead holder or old corrupt — reclaim

async function inspect(
  path: string,
  now: () => number,
  isAlive: (rec: LockRecord) => boolean,
): Promise<Inspection> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'gone' }
    throw e
  }
  let rec: LockRecord | null = null
  try {
    const parsed = JSON.parse(raw) as LockRecord
    if (typeof parsed.pid === 'number' && typeof parsed.host === 'string') rec = parsed
  } catch {
    /* unparseable — fall through to the age check below */
  }
  if (rec) return isAlive(rec) ? { state: 'live', rec } : { state: 'reclaimable', rec }

  // Unparseable (empty mid-write, or garbage). Age decides pending vs corrupt.
  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'gone' }
    throw e
  }
  if (now() - mtimeMs < PENDING_MS) return { state: 'pending' }
  return { state: 'reclaimable', rec: null }
}

/** Remove a stale lock under an exclusive claim mutex so two reclaimers can
 * never both delete and recreate (the read-then-rename TOCTOU). Returns true if
 * THIS caller cleared the lock; false if it should just retry (someone else is
 * claiming, or the lock changed under us). */
async function tryReclaim(
  lockPath: string,
  now: () => number,
  isAlive: (rec: LockRecord) => boolean,
): Promise<boolean> {
  const claimPath = `${lockPath}.claim`
  try {
    await mkdir(claimPath) // atomic-exclusive: fails EEXIST if another claimer holds it
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    // Someone is claiming. If their mutex is stale (crashed mid-claim), clear it.
    try {
      const age = now() - (await stat(claimPath)).mtimeMs
      if (age > CLAIM_STALE_MS) await rmdir(claimPath).catch(() => {})
    } catch {
      /* claim dir vanished — fine, retry */
    }
    return false
  }
  try {
    // Re-validate UNDER the mutex: the lock may have been recreated by a live
    // owner between our inspect() and acquiring the claim. Only remove it if it
    // is still genuinely reclaimable.
    const again = await inspect(lockPath, now, isAlive)
    if (again.state === 'reclaimable') {
      await unlink(lockPath).catch(() => {})
      return true
    }
    return false
  } finally {
    await rmdir(claimPath).catch(() => {})
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
  const pollMs = opts.pollIntervalMs ?? 50
  const now = opts.now ?? (() => Date.now())
  const isAlive = opts.isAlive ?? defaultIsAlive

  await mkdir(dirname(lockPath), { recursive: true })

  const token = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date(now()).toISOString(),
  } satisfies LockRecord)

  const deadline = now() + timeoutMs
  let lastLive: LockRecord | null = null
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx')
      try {
        await fh.writeFile(token)
      } finally {
        await fh.close()
      }
      return makeLock(lockPath)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }

    // Decide how long to wait before the next create attempt. The deadline is
    // checked EVERY iteration below (including the fast-retry paths) so sustained
    // contention can never loop past the timeout, and contended reclaim backs off
    // instead of spinning the CPU between create and the claim mutex.
    const seen = await inspect(lockPath, now, isAlive)
    let waitMs: number
    switch (seen.state) {
      case 'gone':
        waitMs = 0 // genuinely free — race for it immediately
        break
      case 'reclaimable': {
        const won = await tryReclaim(lockPath, now, isAlive)
        waitMs = won ? 0 : reclaimBackoff() // lost the claim race -> back off, don't spin
        break
      }
      case 'live':
        lastLive = seen.rec
        waitMs = pollMs
        break
      case 'pending':
        waitMs = pollMs // a writer is mid-birth — wait and re-check
        break
    }

    if (now() >= deadline) {
      const detail = lastLive
        ? `held by live pid ${lastLive.pid} on ${lastLive.host} (since ${lastLive.acquiredAt})`
        : 'a writer is still initializing it'
      throw new LockTimeoutError(lockPath, detail, timeoutMs)
    }
    if (waitMs > 0) await sleep(waitMs)
  }
}

/** Small randomized backoff (jitter) so a stampede of reclaimers does not
 * thundering-herd the claim mutex or busy-spin between create attempts. */
function reclaimBackoff(): number {
  return 4 + Math.floor(Math.random() * 12)
}

function makeLock(path: string): DatadirLock {
  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      // Only unlink if we still own it — a reclaimer may have taken a lock we
      // believed was ours if our process stalled past the holder's liveness view.
      const seen = await inspect(path, () => Date.now(), defaultIsAlive)
      if (
        seen.state === 'live' &&
        seen.rec.pid === process.pid &&
        seen.rec.host === hostname()
      ) {
        await unlink(path).catch(() => {})
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
