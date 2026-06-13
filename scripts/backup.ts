// Track D cron target: take one cold backup of a primary bucket into a
// secondary (colder) bucket, then apply a retention policy. zeropg ships the
// mechanism, not the scheduler — wire this into a cron line / scheduled job.
//
//   tsx scripts/backup.ts <primaryPrefix> <secondaryPrefix> \
//     [--keep-last N] [--max-age-days N] \
//     [--gfs-daily N] [--gfs-weekly N] [--gfs-monthly N] \
//     [--no-min-storage-guard] [--dry-run] [--no-retention]
//
// Primary bucket = $ZEROPG_BUCKET; secondary bucket = $ZEROPG_BACKUP_BUCKET
// (defaults to the primary bucket, so distinct prefixes give a same-bucket
// demo). For a real second blast radius point ZEROPG_BACKUP_BUCKET at a bucket
// in another account/region/provider with least-privilege creds.

import { GcsBlobStore } from '@zeropg/blobstore'
import { ColdArchiver, type RetentionPolicy } from '@zeropg/objectstore-fs'

const primaryPrefix = process.argv[2]
const secondaryPrefix = process.argv[3]
if (!primaryPrefix || !secondaryPrefix || primaryPrefix.startsWith('--')) {
  console.error(
    'usage: tsx scripts/backup.ts <primaryPrefix> <secondaryPrefix> ' +
      '[--keep-last N] [--max-age-days N] [--gfs-daily N] [--gfs-weekly N] ' +
      '[--gfs-monthly N] [--no-min-storage-guard] [--dry-run] [--no-retention]',
  )
  process.exit(1)
}

function numFlag(name: string): number | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? Number(process.argv[i + 1]) : undefined
}

const dryRun = process.argv.includes('--dry-run')
const runRetention = !process.argv.includes('--no-retention')

const gfsDaily = numFlag('--gfs-daily')
const gfsWeekly = numFlag('--gfs-weekly')
const gfsMonthly = numFlag('--gfs-monthly')
const policy: RetentionPolicy = {
  keepLast: numFlag('--keep-last'),
  maxAgeDays: numFlag('--max-age-days'),
  ...(gfsDaily || gfsWeekly || gfsMonthly
    ? { gfs: { daily: gfsDaily, weekly: gfsWeekly, monthly: gfsMonthly } }
    : {}),
  respectMinStorageDuration: !process.argv.includes('--no-min-storage-guard'),
}

const primaryBucket = process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
const secondaryBucket = process.env.ZEROPG_BACKUP_BUCKET ?? primaryBucket
const primary = new GcsBlobStore({ bucket: primaryBucket, prefix: primaryPrefix })
const secondary = new GcsBlobStore({ bucket: secondaryBucket, prefix: secondaryPrefix })

const archiver = new ColdArchiver(primary, secondary)

const entry = await archiver.backupOnce()
if (!entry) {
  console.log('no backup taken (empty or migrated primary)')
} else {
  console.log(
    `backed up commitSeq=${entry.commitSeq} -> ${entry.key} ` +
      `(${(entry.sizeBytes / 1e6).toFixed(1)} MB, ${entry.codec})`,
  )
}

if (runRetention) {
  const hasPolicy =
    policy.keepLast !== undefined || policy.maxAgeDays !== undefined || policy.gfs !== undefined
  if (!hasPolicy) {
    console.log('no retention policy given (pass --keep-last / --max-age-days / --gfs-*); skipping sweep')
  } else {
    const r = await archiver.applyRetention(policy, { dryRun })
    console.log(
      `${dryRun ? '[dry-run] would delete' : 'deleted'} ${r.deleted.length} backups ` +
        `(${(r.bytesFreed / 1e6).toFixed(1)} MB), kept ${r.kept.length}` +
        (r.blocked.length ? `, blocked ${r.blocked.length} by min-storage-duration` : ''),
    )
    for (const b of r.deleted) console.log(`  - ${b.key}`)
  }
}
