// Test `prisma migrate deploy` (apply committed migrations, NO shadow DB) over
// our pglite-socket wire — the standard production migration workflow.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client as Pg } from 'pg'
import { serveWire } from '../../packages/client/src/wire.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const dir = await mkdtemp(join(tmpdir(), 'deploy-'))
const w = await serveWire({ dataDir: join(dir, 'main') })
const shadow = await serveWire({ dataDir: join(dir, 'shadow') })
const u = (b: string): string => b.replace('postgres://', 'postgres://postgres@') + '?sslmode=disable&connection_limit=1'
const env = { DATABASE_URL: u(w.url), SHADOW_DATABASE_URL: u(shadow.url) }

const p = spawn('npx', ['prisma', 'migrate', 'deploy'], { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
p.stdout.on('data', (d) => (out += d.toString()))
p.stderr.on('data', (d) => (out += d.toString()))
const code: number = await new Promise((r) => p.on('close', (c) => r(c ?? 0)))
console.log(out.trim().split('\n').slice(-12).join('\n'))
console.log(`\n[migrate deploy exit=${code}]`)

const c = new Pg({ connectionString: w.url })
await c.connect()
const t = await c.query(`select table_name from information_schema.tables where table_schema='public' order by table_name`)
console.log('tables present:', t.rows.map((r: { table_name: string }) => r.table_name).join(', '))
await c.end()
await w.stop()
await shadow.stop()
await rm(dir, { recursive: true, force: true })
