// Branch a database: copy its current committed state to a new prefix.
//
//   tsx scripts/branch.ts <src-prefix> <dest-prefix>
//
// The copy is server-side (GCS rewrite), so no snapshot bytes flow through
// this machine — branching a 500MB database takes about a second. The branch
// gets the source's snapshot + a fresh manifest (commitSeq continues, new
// writers start with a clean lease). The source is never touched, and the
// destination must not already exist (create-if-absent on its manifest).

import { GcsBlobStore } from '@zeropg/blobstore'
import { MANIFEST_KEY, decodeManifest, encodeManifest } from '@zeropg/objectstore-fs'

const [src, dest] = [process.argv[2], process.argv[3]]
if (!src || !dest || src === dest) {
  console.error('usage: tsx scripts/branch.ts <src-prefix> <dest-prefix>')
  process.exit(1)
}
const bucket = process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
// One store, no prefix: we address both sides with explicit full keys.
const store = new GcsBlobStore({ bucket })

const t0 = performance.now()
const manifestObj = await store.get(`${src}/${MANIFEST_KEY}`)
if (!manifestObj) {
  console.error(`no database at ${src} (missing manifest.json)`)
  process.exit(1)
}
const manifest = decodeManifest(manifestObj.bytes)
if (manifest.movedTo) {
  console.error(`source database was migrated out to ${manifest.movedTo}; refusing to branch`)
  process.exit(1)
}

// Copy the snapshot + any WAL segments (server-side), then commit the branch
// by create-if-absent of its manifest. If a writer commits on the source
// mid-branch, we still copied a consistent state: the manifest we read.
for (const key of [manifest.snapshot, ...manifest.walSegments]) {
  await store.copy(`${src}/${key}`, `${dest}/${key}`)
}
await store.put(`${dest}/${MANIFEST_KEY}`, encodeManifest(manifest), {
  ifNoneMatch: true,
  contentType: 'application/json',
})
console.log(
  `branched ${src} -> ${dest} at commitSeq=${manifest.commitSeq} ` +
    `(generation ${manifest.generation}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`,
)
