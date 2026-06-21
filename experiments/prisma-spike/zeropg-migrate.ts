// A homegrown `prisma migrate dev` for Prisma-on-zeropg, with NO external
// Postgres and NONE of the broken native migrate-dev engine path.
//
// Native `migrate dev` = generate-new-migration (diff schema vs migration
// history, via a shadow DB) + apply-to-dev, bundled with a concurrent
// shadow/advisory-lock orchestration that PGlite (single session) can't satisfy.
// But each half works on PGlite on its own:
//   - GENERATE: `migrate diff --from-migrations <dir> --to-schema <schema>`
//     replays history into a THROWAWAY in-process PGlite shadow (sequential,
//     single session) and emits the new SQL. ✅ verified.
//   - APPLY: `migrate deploy` applies committed migrations over the wire. ✅ verified.
// So we just call the two halves ourselves. The result is the same DX: edit
// schema.prisma -> get a timestamped migration -> applied to the dev database.

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveWire } from '../../packages/client/src/wire.js'

export interface MigrateDevOptions {
  /** Working dir prisma runs in (must contain prisma.config.ts whose datasource
   *  reads DATABASE_URL/SHADOW_DATABASE_URL from env). */
  cwd: string
  /** Path to the edited schema.prisma (relative to cwd or absolute). */
  schemaPath: string
  /** Path to the migrations directory (relative to cwd or absolute). */
  migrationsDir: string
  /** Datadir of the dev database to apply the new migration to. */
  devDataDir: string
  /** Migration name (e.g. "add_note"). */
  name: string
  /** Timestamp prefix for the migration folder (caller supplies; keeps this pure). */
  timestamp: string
}

export interface MigrateDevResult {
  /** The created migration folder name, or null if the schema was already in sync. */
  created: string | null
  sql?: string
}

function prisma(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['prisma', ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 0, out }))
  })
}

const wireUrl = (base: string): string =>
  base.replace('postgres://', 'postgres://postgres@') + '?sslmode=disable&connection_limit=1'

function cleanSql(out: string): string {
  return out.split('\n').filter((l) => !l.startsWith('Loaded Prisma config')).join('\n').trim()
}

/** The migrate-dev replacement: generate (against a throwaway PGlite shadow) then
 * apply (migrate deploy) to the dev database. */
export async function migrateDev(opts: MigrateDevOptions): Promise<MigrateDevResult> {
  // 1. GENERATE: diff the migration history against the edited schema, using a
  //    throwaway in-process PGlite as the shadow.
  const shadowDir = await mkdtemp(join(tmpdir(), 'zpg-shadow-'))
  const shadow = await serveWire({ dataDir: join(shadowDir, 'db') })
  let sql: string
  try {
    const url = wireUrl(shadow.url)
    // --exit-code: 0 = no diff (already in sync), 2 = has changes, 1 = error.
    const gen = await prisma(
      ['migrate', 'diff', '--from-migrations', opts.migrationsDir, '--to-schema', opts.schemaPath, '--script', '--exit-code'],
      { DATABASE_URL: url, SHADOW_DATABASE_URL: url },
      opts.cwd,
    )
    if (gen.code === 0) return { created: null } // schema already in sync
    if (gen.code !== 2) throw new Error(`migrate diff failed (exit ${gen.code}):\n${gen.out}`)
    sql = cleanSql(gen.out)
  } finally {
    await shadow.stop()
    await rm(shadowDir, { recursive: true, force: true })
  }

  // 2. WRITE the migration file into history.
  const folder = `${opts.timestamp}_${opts.name}`
  const dir = join(opts.migrationsDir, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'migration.sql'), sql + '\n')

  // 3. APPLY to the dev database with migrate deploy (works over the wire).
  const dev = await serveWire({ dataDir: opts.devDataDir })
  try {
    const url = wireUrl(dev.url)
    // No SHADOW_DATABASE_URL: deploy doesn't use one, and setting it == main trips
    // prisma's "shadow same as main" guard.
    const dep = await prisma(['migrate', 'deploy'], { DATABASE_URL: url }, opts.cwd)
    if (dep.code !== 0) throw new Error(`migrate deploy failed:\n${dep.out}`)
  } finally {
    await dev.stop()
  }

  return { created: folder, sql }
}
