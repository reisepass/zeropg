// Run: tsx experiments/prisma-spike/migrate-dev.ts
//
// Tests the Prisma maintainer's prescription for `prisma migrate dev` against
// PGlite (jacek-prisma in prisma/prisma#29366): a SEPARATE PGlite instance as
// the shadow database + connection_limit=1, because PGlite is single-connection.
// My first spike failed (P1017) precisely because it never set connection_limit=1.
//
// Also checks the commands the issue says already work over PGlite: `db push`
// and `migrate deploy`. Reports exactly which Prisma migration commands work over
// our pglite-socket wire.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWire } from '../../packages/client/src/wire.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, 'prisma', 'migrations')

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['prisma', ...args], {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 0, out }))
  })
}

const url = (base: string, limit = true): string =>
  base.replace('postgres://', 'postgres://postgres@') + `?sslmode=disable${limit ? '&connection_limit=1' : ''}`

async function main(): Promise<void> {
  // --- Test 1: migrate dev with a separate shadow + connection_limit=1 ---
  console.log('=== migrate dev (separate PGlite shadow + connection_limit=1) ===')
  await rm(MIGRATIONS_DIR, { recursive: true, force: true }) // clean slate
  let dir = await mkdtemp(join(tmpdir(), 'pmig-'))
  let main = await serveWire({ dataDir: join(dir, 'main') })
  let shadow = await serveWire({ dataDir: join(dir, 'shadow') })
  const devEnv = { DATABASE_URL: url(main.url), SHADOW_DATABASE_URL: url(shadow.url) }
  const dev = await run(['migrate', 'dev', '--name', 'init'], devEnv)
  const created = await readdir(MIGRATIONS_DIR).catch(() => [] as string[])
  const devOk = dev.code === 0 && created.some((f) => f.includes('init'))
  console.log(dev.out.trim().split('\n').slice(-12).join('\n'))
  console.log(`\n[migrate dev exit=${dev.code}] migration created: ${devOk}\n`)
  await main.stop()
  await shadow.stop()
  await rm(dir, { recursive: true, force: true })

  // --- Test 2: db push (no shadow, no history) on a fresh datadir ---
  console.log('=== db push (no shadow DB) ===')
  dir = await mkdtemp(join(tmpdir(), 'ppush-'))
  main = await serveWire({ dataDir: join(dir, 'main') })
  const push = await run(['db', 'push', '--skip-generate'], { DATABASE_URL: url(main.url), SHADOW_DATABASE_URL: url(main.url) })
  console.log(push.out.trim().split('\n').slice(-8).join('\n'))
  console.log(`\n[db push exit=${push.code}]\n`)
  await main.stop()
  await rm(dir, { recursive: true, force: true })

  // --- Test 3: migrate deploy (apply committed migrations, no shadow) ---
  console.log('=== migrate deploy (apply the migration migrate-dev just authored) ===')
  const haveMigration = (await readdir(MIGRATIONS_DIR).catch(() => [])).some((f) => f.includes('init'))
  if (haveMigration) {
    dir = await mkdtemp(join(tmpdir(), 'pdeploy-'))
    main = await serveWire({ dataDir: join(dir, 'main') })
    const deploy = await run(['migrate', 'deploy'], { DATABASE_URL: url(main.url), SHADOW_DATABASE_URL: url(main.url) })
    console.log(deploy.out.trim().split('\n').slice(-8).join('\n'))
    console.log(`\n[migrate deploy exit=${deploy.code}]\n`)
    await main.stop()
    await rm(dir, { recursive: true, force: true })
  } else {
    console.log('(skipped: migrate dev did not author a migration to deploy)\n')
  }

  console.log('=== SUMMARY ===')
  console.log(`migrate dev (shadow + conn_limit=1): ${devOk ? 'WORKS ✅' : 'FAILS ❌'}`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
