// Track D disaster-recovery entry point: restore a cold backup into a local
// datadir and prove it boots. A backup is a self-contained, WAL-folded
// snapshot, so there is no chain to walk and no WAL to overlay — one object
// becomes one datadir.
//
//   tsx scripts/restore-backup.ts <secondaryPrefix> [--seq N] [--into DIR]
//
// Secondary bucket = $ZEROPG_BACKUP_BUCKET (defaults to $ZEROPG_BUCKET). With
// no --seq the newest backup is restored. The restored datadir is left in place
// (--into DIR, else a temp dir) so an operator can boot a writer against it or
// seed a fresh primary bucket from it.

import { PGlite } from '@electric-sql/pglite'
import { GcsBlobStore } from '@zeropg/blobstore'
import { ColdArchiver } from '@zeropg/objectstore-fs'

const secondaryPrefix = process.argv[2]
if (!secondaryPrefix || secondaryPrefix.startsWith('--')) {
  console.error('usage: tsx scripts/restore-backup.ts <secondaryPrefix> [--seq N] [--into DIR]')
  process.exit(1)
}
const seqIdx = process.argv.indexOf('--seq')
const seq = seqIdx > 0 ? Number(process.argv[seqIdx + 1]) : undefined
const intoIdx = process.argv.indexOf('--into')
const into = intoIdx > 0 ? process.argv[intoIdx + 1] : undefined

const bucket = process.env.ZEROPG_BACKUP_BUCKET ?? process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
// The primary is unused on restore; ColdArchiver only reads the secondary here.
const secondary = new GcsBlobStore({ bucket, prefix: secondaryPrefix })
const archiver = new ColdArchiver(secondary, secondary)

const { entry, dir, bytes } = await archiver.restoreFromBackup(seq, into)
console.log(
  `restored commitSeq=${entry.commitSeq} (committed ${entry.committedAt}) from ${entry.key} ` +
    `-> ${dir} (${(bytes / 1e6).toFixed(1)} MB)`,
)

// Prove it boots: open PGlite read-only and list user tables.
const pg = await PGlite.create({ dataDir: dir })
await pg.waitReady
const tables = await pg.query<{ schemaname: string; tablename: string }>(
  "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2",
)
console.log(`booted ok — ${tables.rows.length} user table(s):`)
for (const t of tables.rows) console.log(`  - ${t.schemaname}.${t.tablename}`)
await pg.close()
