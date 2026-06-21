// Spike: does putting PGlite behind supabase-community's pg-gateway (instead of
// @electric-sql/pglite-socket) make `prisma migrate dev` work over the wire?
//
// The difference: pg-gateway only does the startup/auth/SSL handshake, then hands
// RAW protocol bytes to PGlite's own `execProtocolRaw` (PGlite's faithful backend),
// serialized with PGlite's `runExclusive` mutex. pglite-socket reimplements more
// of the framing and has the wire bugs (#985, #958) that break migrate dev.
//
// Run: tsx experiments/prisma-spike/pggw.ts

import { spawn } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client as Pg } from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from 'pg-gateway/node'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, 'prisma', 'migrations')

interface GW {
  url: string
  port: number
  pglite: PGlite
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(p))
    })
  })
}

async function serveGW(dataDir?: string): Promise<GW> {
  const db = dataDir ? await PGlite.create({ dataDir }) : await PGlite.create()
  const port = await freePort()
  const sockets = new Set<Socket>()
  let connSeq = 0
  const server: Server = createServer((socket) => {
    const cid = ++connSeq
    sockets.add(socket)
    if (process.env.GW_DEBUG) console.error(`[gw ${dataDir ? 'main/shadow' : 'mem'} conn#${cid}] open (live=${sockets.size})`)
    socket.on('close', () => sockets.delete(socket))
    fromNodeSocket(socket, {
      serverVersion: '16.3',
      auth: { method: 'trust' },
      async onStartup() {
        await db.waitReady
      },
      async onMessage(data, { isAuthenticated }) {
        if (!isAuthenticated) return // let pg-gateway finish startup/auth/SSL
        try {
          return await db.runExclusive(() => db.execProtocolRaw(data))
        } catch (e) {
          if (process.env.GW_DEBUG) console.error(`[gw conn#${cid}] execProtocolRaw error:`, e instanceof Error ? e.message : e)
          throw e
        }
      },
    }).catch((e) => {
      if (process.env.GW_DEBUG) console.error(`[gw conn#${cid}] connection error:`, e instanceof Error ? e.message : e)
      socket.destroy()
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    port,
    pglite: db,
    async stop() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
      await db.close()
    },
  }
}

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
  // First sanity-check: a plain pg client over pg-gateway (no sslmode override).
  console.log('=== sanity: pg client over pg-gateway ===')
  const dir0 = await mkdtemp(join(tmpdir(), 'pggw0-'))
  const s0 = await serveGW(join(dir0, 'db'))
  const c = new Pg({ connectionString: s0.url })
  await c.connect()
  await c.query('create table t (id int)')
  await c.query('insert into t values (1)')
  console.log('  pg over pg-gateway:', (await c.query('select count(*)::int n from t')).rows[0].n === 1 ? 'OK' : 'FAIL')
  await c.end()
  await s0.stop()
  await rm(dir0, { recursive: true, force: true })

  // The real test: prisma migrate dev (shadow DB) over pg-gateway.
  console.log('\n=== prisma migrate dev over pg-gateway (separate shadow + connection_limit=1) ===')
  await rm(MIGRATIONS_DIR, { recursive: true, force: true })
  const dir = await mkdtemp(join(tmpdir(), 'pggw-'))
  const main = await serveGW(join(dir, 'main'))
  const shadow = await serveGW(join(dir, 'shadow'))
  const u = (base: string): string => base + '?sslmode=disable&connection_limit=1'
  const env = { DATABASE_URL: u(main.url), SHADOW_DATABASE_URL: u(shadow.url) }
  const dev = await run(['migrate', 'dev', '--name', 'init'], env)
  console.log(dev.out.trim().split('\n').slice(-14).join('\n'))
  const created = (await readdir(MIGRATIONS_DIR).catch(() => [])).some((f) => f.includes('init'))
  console.log(`\n[migrate dev exit=${dev.code}] migration authored: ${created}`)
  console.log(`\nRESULT: prisma migrate dev over pg-gateway = ${dev.code === 0 && created ? 'WORKS ✅' : 'FAILS ❌'}`)
  await main.stop()
  await shadow.stop()
  await rm(dir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
