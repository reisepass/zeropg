// Seed a bucket prefix with a zeropg database of ~N MB of INCOMPRESSIBLE data,
// so cold-start measurements and the demo apps reflect honest snapshot sizes
// (random bytea does not shrink under gzip the way filler text would).
//
//   tsx experiments/seed-db.ts <prefix> <targetMB>

import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { randomBytes } from 'node:crypto'
import { BUCKET, round } from './_util.js'

const prefix = process.argv[2]
const targetMB = Number(process.argv[3] ?? '1')
if (!prefix) {
  console.error('usage: tsx seed-db.ts <prefix> <targetMB>')
  process.exit(1)
}

async function main() {
  const store = new GcsBlobStore({ bucket: BUCKET, prefix })
  const seed = await ZeroPG.buildEmptySnapshot()
  const db = await ZeroPG.open({ store, holder: 'seeder', seedSnapshot: seed, durability: 'sleep' })
  await db.raw.exec('CREATE TABLE IF NOT EXISTS filler (id serial primary key, blob bytea not null)')
  await db.raw.exec(
    'CREATE TABLE IF NOT EXISTS notes (id serial primary key, body text not null, created_at timestamptz default now())',
  )

  const ROW_BYTES = 8 * 1024 // 8KB random per row
  const targetBytes = targetMB * 1_000_000
  let dbBytes = 0
  let rows = 0
  const t0 = performance.now()
  while (dbBytes < targetBytes) {
    // Insert a batch of random rows.
    const BATCH = 256
    const values: string[] = []
    for (let i = 0; i < BATCH; i++) {
      values.push(`('\\x${randomBytes(ROW_BYTES).toString('hex')}')`)
    }
    await db.raw.exec(`INSERT INTO filler (blob) VALUES ${values.join(',')}`)
    rows += BATCH
    const sz = await db.raw.query<{ b: string }>('SELECT pg_database_size(current_database())::text b')
    dbBytes = Number(sz.rows[0]?.b ?? '0')
    if (rows % 2560 === 0) {
      console.log(`  ${round(dbBytes / 1e6)}MB / ${targetMB}MB (${rows} rows)`)
    }
  }
  // Force a durable commit of the whole dataset.
  db.markDirty()
  const commit = await db.commit()
  const m = db.currentManifest
  await db.close()
  console.log(
    `seeded ${prefix}: ${round(dbBytes / 1e6)}MB db, ${rows} filler rows, ` +
      `snapshot=${commit ? round(commit.snapshotBytes / 1e6) : '?'}MB, ` +
      `gen=${m.generation}, took ${round((performance.now() - t0) / 1000)}s`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
