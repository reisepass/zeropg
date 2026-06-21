// Run: tsx experiments/prisma-spike/run.ts
//
// The make-or-break experiment for "existing Prisma apps work on zeropg".
//
// FINDING (recorded): Prisma's native MIGRATE engine does NOT work against the
// pglite-socket wire. It gets through SSL (with sslmode=disable) and auth (user
// postgres), then the engine's migration workflow — multiple sessions, advisory
// locks, a shadow-DB reset, introspection — trips pglite-socket's single-backend
// multiplexing and the connection drops (P1017). This matches ORM-ADAPTER-NOTES:
// the migrate engine is the blocker, the query path is not.
//
// RESOLUTION (proven here): the ORM-notes pattern. Prisma AUTHORS the schema
// offline (`migrate diff --script`, no DB connection), zeropg's single writer
// APPLIES that SQL itself, and the Prisma CLIENT then queries over the wire via
// the JS pg driver adapter — which does work. End to end, no native migrate
// engine involved.

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client as Pg } from 'pg'
import { serveWire } from '../../packages/client/src/wire.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(HERE, 'prisma', 'schema.prisma')

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 0, out }))
  })
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'prisma-spike-'))
  const wire = await serveWire({ dataDir: join(dir, 'main') })
  const url = wire.url.replace('postgres://', 'postgres://postgres@') + '?sslmode=disable'
  // prisma.config.ts resolves env() at load time, so the CLI needs these set even
  // for the offline diff (which never connects).
  const env = { DATABASE_URL: url, SHADOW_DATABASE_URL: url }

  try {
    // 1. Prisma AUTHORS the migration SQL — purely from the schema, no DB needed.
    console.log('1. prisma migrate diff --script  (offline: schema -> SQL)')
    const diff = await run(
      'npx',
      ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema', SCHEMA, '--script'],
      env,
    )
    ok(diff.code === 0, 'migrate diff succeeded with no database connection')
    const sql = diff.out
      .split('\n')
      .filter((l) => !l.startsWith('Loaded Prisma config'))
      .join('\n')
      .trim()
    ok(/CREATE TABLE\s+"Poll"/i.test(sql) && /CREATE TABLE\s+"Option"/i.test(sql), 'generated SQL has both tables')
    ok(/FOREIGN KEY/i.test(sql), 'generated SQL has the foreign key')

    // 2. zeropg's writer APPLIES the SQL itself (here, straight over the wire).
    console.log('2. apply the generated SQL via our wire (the single-writer applies it)')
    const applier = new Pg({ connectionString: url })
    await applier.connect()
    await applier.query(sql)
    await applier.end()
    ok(true, 'DDL applied cleanly to zeropg')

    // 3. The Prisma CLIENT queries over the wire via the pg driver adapter.
    console.log('3. prisma generate + client CRUD over the adapter')
    const gen = await run('npx', ['prisma', 'generate', '--schema', SCHEMA], env)
    ok(gen.code === 0, `prisma generate succeeded (exit ${gen.code})`)

    const { PrismaClient } = (await import('@prisma/client')) as unknown as { PrismaClient: new (o: unknown) => any }
    const { PrismaPg } = (await import('@prisma/adapter-pg')) as unknown as { PrismaPg: new (o: unknown) => any }
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    const poll = await prisma.poll.create({
      data: { title: 'lunch?', options: { create: [{ label: 'mon' }, { label: 'tue' }] } },
      include: { options: true },
    })
    ok(poll.id && poll.options.length === 2, 'prisma client created a poll + 2 options (nested write)')
    const back = await prisma.poll.findMany({ include: { options: true } })
    ok(back.length === 1 && back[0].options.length === 2, 'prisma client read it back with the relation')
    const onlyTue = await prisma.option.findMany({ where: { label: 'tue' } })
    ok(onlyTue.length === 1, 'prisma client filtered query works')
    await prisma.$disconnect()

    console.log('\nRESULT: Prisma WORKS on zeropg via author-offline + we-apply + client-over-adapter ✅')
    console.log(`PASS — ${passed} assertions`)
  } finally {
    await wire.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
