// CLI for bucket garbage collection.
//
//   tsx scripts/gc.ts <prefix> [--dry-run] [--grace-minutes N]

import { GcsBlobStore } from '@zeropg/blobstore'
import { collectGarbage } from '@zeropg/objectstore-fs'

const prefix = process.argv[2]
if (!prefix) {
  console.error('usage: tsx scripts/gc.ts <prefix> [--dry-run] [--grace-minutes N]')
  process.exit(1)
}
const dryRun = process.argv.includes('--dry-run')
const gIdx = process.argv.indexOf('--grace-minutes')
const graceMs = gIdx > 0 ? Number(process.argv[gIdx + 1]) * 60_000 : undefined

const store = new GcsBlobStore({
  bucket: process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1',
  prefix,
})
const r = await collectGarbage(store, { dryRun, graceMs })
console.log(
  `${dryRun ? '[dry-run] would delete' : 'deleted'} ${r.deleted.length} objects ` +
    `(${(r.bytesFreed / 1e6).toFixed(1)} MB), kept ${r.kept.length}`,
)
for (const k of r.deleted) console.log(`  - ${k}`)
