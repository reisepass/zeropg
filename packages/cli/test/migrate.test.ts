// Run: tsx packages/cli/test/migrate.test.ts
//
// Full-loop test of `zeropg migrate` against a real Prisma fixture project, with
// no external Postgres. Proves: deploy applies the baseline; migrate dev authors
// a new migration from an edited schema (throwaway PGlite shadow) and applies it;
// the dev database actually gains the new column; idempotent when in sync.

import { mkdtemp, mkdir, readdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWire } from '@zeropg/client'
import { migrateDev, migrateDeploy, listMigrations } from '../src/migrate.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture')

let passed = 0
function ok(c: unknown, m: string): void {
  if (!c) throw new Error(`FAIL: ${m}`)
  passed++
  console.log(`  ok  ${m}`)
}

/** Reset the fixture's migrations dir to just the committed baseline (0001), in
 * case a prior run left generated migrations behind. */
async function resetMigrations(): Promise<void> {
  const dir = join(FIXTURE, 'prisma', 'migrations')
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (f !== '0001_init' && f !== 'migration_lock.toml') {
      await rm(join(dir, f), { recursive: true, force: true })
    }
  }
}

async function columns(dataDir: string, table: string): Promise<string[]> {
  const dev = await serveWire({ dataDir })
  try {
    const r = await dev.pglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
      [table],
    )
    return r.rows.map((x) => x.column_name)
  } finally {
    await dev.stop()
  }
}

async function main(): Promise<void> {
  await resetMigrations()
  const work = await mkdtemp(join(tmpdir(), 'cli-mig-'))
  const data = join(work, 'dev')
  const ctx = { cwd: FIXTURE, data, log: () => {} }

  console.log('deploy applies the committed baseline (0001_init)')
  const d1 = await migrateDeploy(ctx)
  ok(d1.applied === 1, `deploy applied the baseline (got ${d1.applied})`)
  ok((await columns(data, 'Item')).join(',') === 'createdAt,id,name', 'Item table created with baseline columns')

  console.log('migrate dev authors + applies a new migration from the edited schema')
  const res = await migrateDev('add_done', { ...ctx, schema: 'prisma/schema_v2.prisma' })
  ok(res.created !== null && /_add_done$/.test(res.created), `authored a migration: ${res.created}`)
  ok(res.applied === 1, `applied exactly the new migration (got ${res.applied})`)
  ok((await columns(data, 'Item')).includes('done'), 'dev DB Item gained the done column')

  console.log('the new migration is persisted on disk + recorded')
  const onDisk = await listMigrations(ctx)
  ok(onDisk.length === 2 && onDisk[0] === '0001_init' && /_add_done$/.test(onDisk[1]), 'two migrations on disk in order')

  console.log('idempotent: re-running migrate dev with no schema change authors nothing')
  const again = await migrateDev('noop', { ...ctx, schema: 'prisma/schema_v2.prisma' })
  ok(again.created === null, 'no migration authored when schema matches history')

  // cleanup generated migration so the fixture stays at baseline
  const gen = (await listMigrations(ctx)).filter((m) => m !== '0001_init')
  for (const m of gen) await rm(join(FIXTURE, 'prisma', 'migrations', m), { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
