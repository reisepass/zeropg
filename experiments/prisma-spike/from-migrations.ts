// Can we replicate `prisma migrate dev`'s authoring step WITHOUT an external
// Postgres and WITHOUT the broken migrate-dev engine path?
//
// `prisma migrate diff --from-migrations <dir> --to-schema <schema>` replays the
// existing migrations into a SHADOW database, then diffs the result against the
// edited schema to emit the new migration SQL. The shadow is used sequentially
// in a single session — unlike migrate dev's concurrent advisory-lock dance. If
// that works against a throwaway in-process PGlite shadow, we can build a clean
// `migrate dev` equivalent (generate + apply) entirely on PGlite.
//
// Run: tsx experiments/prisma-spike/from-migrations.ts

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWire } from '../../packages/client/src/wire.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('npx', ['prisma', ...args], { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    p.on('close', (code) => resolve({ code: code ?? 0, out }))
  })
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fromm-'))
  const shadow = await serveWire({ dataDir: join(dir, 'shadow') })
  const shadowUrl = shadow.url.replace('postgres://', 'postgres://postgres@') + '?sslmode=disable&connection_limit=1'
  // env must satisfy prisma.config.ts env() at load time
  const env = { DATABASE_URL: shadowUrl, SHADOW_DATABASE_URL: shadowUrl }

  console.log('=== migrate diff --from-migrations (replay into PGlite shadow) -> new SQL ===')
  const r = await run(
    [
      'migrate', 'diff',
      '--from-migrations', 'prisma/migrations',
      '--to-schema', 'prisma/schema_v2.prisma',
      '--script',
    ],
    env,
  )
  const sql = r.out.split('\n').filter((l) => !l.startsWith('Loaded Prisma config')).join('\n').trim()
  console.log(sql || '(no output)')
  console.log(`\n[exit=${r.code}]`)
  const ok = r.code === 0 && /ALTER TABLE\s+"Poll"\s+ADD COLUMN\s+"note"/i.test(sql)
  console.log(`\nRESULT: from-migrations replay on PGlite shadow = ${ok ? 'WORKS ✅ (we can build migrate-dev ourselves)' : 'FAILS ❌'}`)

  await shadow.stop()
  await rm(dir, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
