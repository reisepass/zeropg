// Garbage collection (DESIGN.md 4.6): delete bucket objects no manifest
// references. Orphans come from three places: snapshots uploaded by a commit
// that was fenced at the manifest CAS, superseded snapshots whose best-effort
// delete failed, and whole generations left behind by reseeds.
//
// Safety rules:
//   - The object the current manifest references is never touched.
//   - Anything younger than graceMs is kept: a commit may have uploaded its
//     snapshot but not yet CAS'd the manifest. The default (15 min) is far
//     beyond any realistic upload-to-CAS window.
//   - lease.json and manifest.json are never touched.

import { type BlobStore } from '@zeropg/blobstore'
import { MANIFEST_KEY, decodeManifest } from './manifest.js'

export interface GcOptions {
  /** Don't delete objects younger than this. Default 15 minutes. */
  graceMs?: number
  /** Report what would be deleted without deleting. */
  dryRun?: boolean
  /** Injectable clock (tests). */
  now?: () => number
}

export interface GcResult {
  kept: string[]
  deleted: string[]
  bytesFreed: number
}

export async function collectGarbage(store: BlobStore, opts: GcOptions = {}): Promise<GcResult> {
  const graceMs = opts.graceMs ?? 15 * 60_000
  const dryRun = opts.dryRun ?? false

  const manifestObj = await store.get(MANIFEST_KEY)
  if (!manifestObj) {
    // No manifest at all: nothing is safe to judge, so do nothing.
    return { kept: [], deleted: [], bytesFreed: 0 }
  }
  const manifest = decodeManifest(manifestObj.bytes)
  const referenced = new Set<string>([
    manifest.snapshot,
    ...manifest.walSegments.map((s) => s.key),
    ...(manifest.previousSnapshot ? [manifest.previousSnapshot] : []),
  ])

  const kept: string[] = []
  const deleted: string[] = []
  let bytesFreed = 0

  for await (const entry of store.list('generations/')) {
    if (referenced.has(entry.key)) {
      kept.push(entry.key)
      continue
    }
    // GCS generation doubles as a create-timestamp in microseconds; fall back
    // to keeping the object if it does not parse.
    const createdUs = Number(entry.etag)
    const ageMs = Number.isFinite(createdUs)
      ? (opts.now ?? Date.now)() - createdUs / 1000
      : -1
    if (ageMs >= 0 && ageMs < graceMs) {
      kept.push(entry.key)
      continue
    }
    if (!dryRun) await store.delete(entry.key)
    deleted.push(entry.key)
    bytesFreed += entry.size
  }
  return { kept, deleted, bytesFreed }
}
