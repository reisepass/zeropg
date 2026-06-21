// The Prisma-migration workflow for zeropg/PGlite, with NO external Postgres and
// without the native `prisma migrate dev` engine (which can't drive single-session
// PGlite — see ORM-ADAPTER-NOTES.md). `migrate dev` is really two steps bundled
// with a shadow/advisory-lock orchestration PGlite can't satisfy; each step works
// on PGlite on its own, so we run them ourselves:
//
//   GENERATE  `prisma migrate diff --from-migrations <dir> --to-schema <schema>
//             --script --exit-code` replays history into a THROWAWAY in-process
//             PGlite shadow (sequential, single session) and emits the new SQL.
//   APPLY     `prisma migrate deploy` applies committed migrations over the wire.
//
// Requires a Prisma 7 project whose prisma.config.ts reads the datasource url /
// shadowDatabaseUrl from process.env (so we can inject throwaway wire URLs).

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { serveWire } from '@zeropg/client'

// Resolve the LOCAL prisma CLI entry and run it via node. `npx prisma` resolves
// ambiguously (it failed to find the project's prisma.config.ts); invoking the
// resolved bin directly is deterministic.
const req = createRequire(import.meta.url)
function prismaBin(): string {
  const pkgPath = req.resolve('prisma/package.json')
  const pkg = req('prisma/package.json') as { bin: string | Record<string, string> }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.prisma
  return join(dirname(pkgPath), bin)
}

export interface MigrateContext {
  /** Project dir prisma runs in (contains prisma.config.ts). Default process.cwd(). */
  cwd?: string
  /** schema.prisma path (relative to cwd or absolute). Default prisma/schema.prisma. */
  schema?: string
  /** migrations dir (relative to cwd or absolute). Default prisma/migrations. */
  migrations?: string
  /** dev database datadir (relative to cwd or absolute). Default .zeropg/dev. */
  data?: string
  /** Sink for human-facing progress (default: console.log). */
  log?: (msg: string) => void
}

export interface MigrateDevResult {
  /** Created migration folder name, or null if the schema was already in sync. */
  created: string | null
  /** Number of migrations applied to the dev database by the deploy step. */
  applied: number
}

interface Resolved {
  cwd: string
  schema: string
  migrations: string
  data: string
  log: (msg: string) => void
}

function resolveCtx(ctx: MigrateContext): Resolved {
  const cwd = ctx.cwd ?? process.cwd()
  const abs = (p: string): string => (isAbsolute(p) ? p : join(cwd, p))
  return {
    cwd,
    schema: abs(ctx.schema ?? 'prisma/schema.prisma'),
    migrations: abs(ctx.migrations ?? 'prisma/migrations'),
    data: abs(ctx.data ?? '.zeropg/dev'),
    log: ctx.log ?? ((m) => console.log(m)),
  }
}

function prisma(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [prismaBin(), ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 0, out }))
  })
}

// PGlite is single-connection; the JS pg driver pg-gateway/pglite-socket needs
// connection_limit=1. sslmode=disable: the native engine defaults to prefer.
const wireUrl = (base: string): string =>
  base.replace('postgres://', 'postgres://postgres@') + '?sslmode=disable&connection_limit=1'

function cleanSql(out: string): string {
  return out.split('\n').filter((l) => !l.startsWith('Loaded Prisma config')).join('\n').trim()
}

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  )
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function ensureMigrationsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const lock = join(dir, 'migration_lock.toml')
  if (!(await exists(lock))) await writeFile(lock, 'provider = "postgresql"\n')
}

/** `zeropg migrate dev`: author the next migration from the edited schema (using a
 * throwaway PGlite shadow), write it, and apply it to the dev database. */
export async function migrateDev(name: string, ctx: MigrateContext = {}): Promise<MigrateDevResult> {
  const r = resolveCtx(ctx)
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`migrate dev: invalid --name "${name}" (use [a-zA-Z0-9_-])`)
  await ensureMigrationsDir(r.migrations)

  // 1. GENERATE against a throwaway in-process PGlite shadow.
  r.log('· generating migration (diff schema vs history on a throwaway PGlite shadow)')
  const shadowDir = await mkdtemp(join(tmpdir(), 'zpg-shadow-'))
  const shadow = await serveWire({ dataDir: join(shadowDir, 'db') })
  let sql: string | null = null
  try {
    const url = wireUrl(shadow.url)
    const gen = await prisma(
      ['migrate', 'diff', '--from-migrations', r.migrations, '--to-schema', r.schema, '--script', '--exit-code'],
      { DATABASE_URL: url, SHADOW_DATABASE_URL: url },
      r.cwd,
    )
    if (gen.code === 0) {
      r.log('· schema already in sync — nothing to migrate')
    } else if (gen.code === 2) {
      sql = cleanSql(gen.out)
    } else {
      throw new Error(`prisma migrate diff failed (exit ${gen.code}):\n${gen.out}`)
    }
  } finally {
    await shadow.stop()
    await rm(shadowDir, { recursive: true, force: true })
  }

  if (sql === null) {
    const applied = await deploy(r)
    return { created: null, applied }
  }

  // 2. WRITE the migration into history.
  const folder = `${stamp(new Date())}_${name}`
  const dir = join(r.migrations, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'migration.sql'), sql + '\n')
  r.log(`· wrote ${join('prisma/migrations', folder, 'migration.sql')}`)

  // 3. APPLY to the dev database.
  const applied = await deploy(r)
  return { created: folder, applied }
}

/** `zeropg migrate deploy`: apply all pending committed migrations to the dev
 * database (PGlite at the data datadir) over the wire. */
export async function migrateDeploy(ctx: MigrateContext = {}): Promise<{ applied: number }> {
  const r = resolveCtx(ctx)
  await ensureMigrationsDir(r.migrations)
  const applied = await deploy(r)
  return { applied }
}

async function deploy(r: Resolved): Promise<number> {
  await mkdir(r.data, { recursive: true })
  const before = await countApplied(r)
  const dev = await serveWire({ dataDir: r.data })
  try {
    // No SHADOW_DATABASE_URL: deploy uses no shadow, and shadow==main trips a guard.
    const dep = await prisma(['migrate', 'deploy'], { DATABASE_URL: wireUrl(dev.url) }, r.cwd)
    if (dep.code !== 0) throw new Error(`prisma migrate deploy failed (exit ${dep.code}):\n${dep.out}`)
  } finally {
    await dev.stop()
  }
  const after = await countApplied(r)
  const n = Math.max(0, after - before)
  r.log(`· applied ${n} migration${n === 1 ? '' : 's'} to ${r.data}`)
  return n
}

/** How many migrations are recorded as applied in the dev database. */
async function countApplied(r: Resolved): Promise<number> {
  const dev = await serveWire({ dataDir: r.data })
  try {
    const res = await dev.pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = '_prisma_migrations'`,
    )
    if (!res.rows[0] || res.rows[0].n === 0) return 0
    const c = await dev.pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    )
    return c.rows[0]?.n ?? 0
  } finally {
    await dev.stop()
  }
}

/** Count migration folders on disk (for `migrate status`). */
export async function listMigrations(ctx: MigrateContext = {}): Promise<string[]> {
  const r = resolveCtx(ctx)
  const entries = await readdir(r.migrations, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}
