// Full-loop proof of the homegrown migrate-dev: edit schema -> our migrateDev()
// generates a migration + applies it to a PGlite dev DB -> the new column is live
// and queryable. No external Postgres, no native `prisma migrate dev`.
//
// Run: tsx experiments/prisma-spike/migrate-dev-tool.test.ts

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client as Pg } from 'pg'
import { serveWire } from '../../packages/client/src/wire.js'
import { migrateDev } from './zeropg-migrate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let passed = 0
function ok(c: unknown, m: string): void {
  if (!c) throw new Error(`FAIL: ${m}`)
  passed++
  console.log(`  ok  ${m}`)
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'mdev-'))
  const migrationsDir = join(HERE, 'prisma', 'migrations') // has 0001_init
  const devDataDir = join(work, 'dev')

  // clean slate: keep only the 0001 baseline + lock (drop any leftover generated migrations)
  for (const f of await readdir(migrationsDir).catch(() => [] as string[])) {
    if (f !== '0001_init' && f !== 'migration_lock.toml') {
      await rm(join(migrationsDir, f), { recursive: true, force: true })
    }
  }
  const before = await readdir(migrationsDir).catch(() => [] as string[])
  ok(before.some((f) => f === '0001_init'), 'baseline migration 0001_init present')

  console.log('edit schema (schema_v2 adds Poll.note) -> migrateDev generates + applies')
  const res = await migrateDev({
    cwd: HERE,
    schemaPath: 'prisma/schema_v2.prisma',
    migrationsDir,
    devDataDir,
    name: 'add_note',
    timestamp: '0002',
  })
  ok(res.created === '0002_add_note', `a migration was authored: ${res.created}`)
  ok(/ADD COLUMN\s+"note"/i.test(res.sql ?? ''), 'authored SQL adds the note column')

  console.log('verify the dev database actually has the new column')
  const dev = await serveWire({ dataDir: devDataDir })
  const c = new Pg({ connectionString: dev.url })
  await c.connect()
  const cols = await c.query(
    `select column_name from information_schema.columns where table_name='Poll' order by column_name`,
  )
  const names = cols.rows.map((r: { column_name: string }) => r.column_name)
  ok(names.includes('note'), `dev DB Poll has the note column (cols: ${names.join(',')})`)
  // and the migration is recorded
  const applied = await c.query(`select migration_name from _prisma_migrations order by migration_name`)
  const am = applied.rows.map((r: { migration_name: string }) => r.migration_name)
  ok(am.includes('0001_init') && am.includes('0002_add_note'), 'both migrations recorded in _prisma_migrations')
  await c.end()
  await dev.stop()

  console.log('idempotent: re-running with no schema change authors nothing')
  const again = await migrateDev({
    cwd: HERE,
    schemaPath: 'prisma/schema_v2.prisma',
    migrationsDir,
    devDataDir,
    name: 'noop',
    timestamp: '0003',
  })
  ok(again.created === null, 'no migration authored when schema matches history')

  // cleanup the generated 0002 so the spike repo stays clean (gitignored anyway)
  await rm(join(migrationsDir, '0002_add_note'), { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
