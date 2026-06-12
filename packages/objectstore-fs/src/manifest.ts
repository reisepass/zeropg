// The manifest is THE commit point (DESIGN.md 4.2). It is a single small JSON
// object, written only via conditional PUT. Swapping it atomically is what
// makes a commit a commit; everything else in the bucket is immutable data the
// manifest points at.

export interface Manifest {
  version: 1
  /** Random id bundling one snapshot + the WAL segments after it (Litestream). */
  generation: string
  /** The lease fencing token of the writer that produced this commit. */
  fencingToken: number
  /** Object key of the base snapshot for this generation. */
  snapshot: string
  /** Immutable WAL segment object keys after the snapshot (empty in v0). */
  walSegments: string[]
  /** Monotonic commit counter (stands in for the LSN in v0). */
  commitSeq: number
  committedAt: string
  /** Set by `migrate-out`: any instance booting from the bucket should refuse
   * and point users at the new home instead of resurrecting stale data. */
  movedTo?: string
}

export const MANIFEST_KEY = 'manifest.json'

export function encodeManifest(m: Manifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m, null, 2))
}

export function decodeManifest(bytes: Uint8Array): Manifest {
  return JSON.parse(new TextDecoder().decode(bytes)) as Manifest
}
