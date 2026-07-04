// Local databases: the other half of the inventory. Sources the
// open-breadcrumbs that @zeropg/client drops in ~/.zeropg/opens.jsonl on every
// successful datadir open (see packages/client/src/breadcrumb.ts) and
// annotates each with what can be checked cheaply right now.

import { existsSync, statSync } from 'node:fs'
import { readOpenBreadcrumbs, lockPathFor } from '@zeropg/client'

export interface LocalDb {
  /** Absolute datadir path. */
  path: string
  /** Project dir the open ran from. */
  cwd: string
  /** Last opened (ISO). */
  lastOpened: string
  /** present = datadir exists; gone = breadcrumb points at a deleted dir. */
  status: 'present' | 'gone'
  /** True when a wrapper lock file sits next to the datadir right now -
   *  usually a live process (a dead holder's lock is reclaimed on next open). */
  lockPresent: boolean
}

export function listLocalDbs(): LocalDb[] {
  return readOpenBreadcrumbs().map((b) => {
    let status: LocalDb['status'] = 'gone'
    try {
      if (statSync(b.path).isDirectory()) status = 'present'
    } catch {
      /* gone */
    }
    return {
      path: b.path,
      cwd: b.cwd,
      lastOpened: b.at,
      status,
      lockPresent: status === 'present' && existsSync(lockPathFor(b.path)),
    }
  })
}
