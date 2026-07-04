// Open-breadcrumbs: every successful local datadir open appends ONE small
// line to ~/.zeropg/opens.jsonl so tooling (zeropg console / fleet) can later
// answer "where are all the databases I've created on this machine?". The
// natural hook is the same place the datadir lock is taken - one extra append
// next to I/O we already do per open.
//
// Contract, in order of importance:
//   - NEVER fails or slows an open: fire-and-forget append, every error
//     swallowed. ZEROPG_NO_BREADCRUMB=1 opts out entirely.
//   - Minimal data: {path, cwd, at} per line (~120 bytes). No query counts, no
//     durations, nothing sensitive beyond the paths themselves.
//   - Append-only writer (crash-safe, lock-free); the READER dedupes by path
//     (newest wins) and compacts the file when it grows past ~64KB, so the
//     file stays tiny without read-modify-write on the open path.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OpenBreadcrumb {
  /** Absolute datadir path. */
  path: string
  /** Directory the process ran from (usually the project). */
  cwd: string
  /** ISO timestamp of the open. */
  at: string
}

export function zeropgHome(): string {
  return process.env.ZEROPG_CONFIG_DIR || join(homedir(), '.zeropg')
}

function breadcrumbPath(): string {
  return join(zeropgHome(), 'opens.jsonl')
}

const COMPACT_THRESHOLD_BYTES = 64 * 1024

/** Best-effort: record that `absDataDir` was opened. Never throws. */
export function recordOpen(absDataDir: string): void {
  if (process.env.ZEROPG_NO_BREADCRUMB === '1') return
  try {
    mkdirSync(zeropgHome(), { recursive: true })
    const line = JSON.stringify({
      path: absDataDir,
      cwd: process.env.INIT_CWD || process.cwd(),
      at: new Date().toISOString(),
    } satisfies OpenBreadcrumb)
    appendFileSync(breadcrumbPath(), line + '\n')
  } catch {
    /* a breadcrumb must never break an open */
  }
}

/** Read breadcrumbs, newest-first, deduped by path. Compacts the file in
 *  passing when it has grown past the threshold. Never throws. */
export function readOpenBreadcrumbs(): OpenBreadcrumb[] {
  let raw: string
  try {
    raw = readFileSync(breadcrumbPath(), 'utf8')
  } catch {
    return []
  }
  const byPath = new Map<string, OpenBreadcrumb>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const b = JSON.parse(line) as OpenBreadcrumb
      if (typeof b.path === 'string' && typeof b.at === 'string') byPath.set(b.path, b)
    } catch {
      /* skip torn/corrupt lines */
    }
  }
  const list = [...byPath.values()].sort((a, b) => b.at.localeCompare(a.at))
  try {
    if (statSync(breadcrumbPath()).size > COMPACT_THRESHOLD_BYTES) {
      writeFileSync(breadcrumbPath(), list.map((b) => JSON.stringify(b)).join('\n') + '\n')
    }
  } catch {
    /* compaction is opportunistic */
  }
  return list
}
