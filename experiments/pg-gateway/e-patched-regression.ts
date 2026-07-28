// Regression suite for the patched vendored source.
//
// The patch is worthless if it fixed the crash by breaking the library. This
// exercises the paths the three patches touch, with real psql:
//   - PATCH 3 (std-shim): SCRAM-SHA-256 (encode/decodeBase64) and md5 auth
//     (concat, encodeHex, crypto.subtle.digest('MD5') via node:crypto).
//   - PATCH 1 (crash): TLS still terminates correctly for clients that ACCEPT
//     the cert, including sslmode=verify-full with the RIGHT CA.
//   - Wrong passwords must still be REJECTED. A crash fix that turned auth into
//     a no-op would otherwise look like a pass.
//
// Run: npx tsx experiments/pg-gateway/e-patched-regression.ts

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from './vendor/patched/src/platforms/node/index.ts'
import { createScramSha256Data } from './vendor/patched/src/auth/sasl/scram-sha-256.ts'
import { createPreHashedPassword } from './vendor/patched/src/auth/md5.ts'
import { freePort } from './lib/gateway.ts'

const CERTS = '/tmp/pggw-certs'
const PASSWORD = 'correct-horse-battery-staple'

let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const fail = (m: string): void => {
  console.log(`  FAIL ${m}`)
  failures++
}

function psql(url: string, sql: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('psql', [url, '-tAc', sql], {
      env: { ...process.env, PGPASSWORD: process.env.TEST_PGPASSWORD ?? PASSWORD },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', () => resolve(out.trim()))
    setTimeout(() => p.kill('SIGKILL'), 10_000)
  })
}

interface Srv {
  port: number
  stop: () => Promise<void>
}

async function serve(db: PGlite, options: Record<string, unknown>): Promise<Srv> {
  const port = await freePort()
  const socks = new Set<Socket>()
  const server: Server = createServer((socket) => {
    socks.add(socket)
    socket.on('close', () => socks.delete(socket))
    socket.on('error', () => {})
    fromNodeSocket(socket, {
      ...options,
      onConnectionError() {},
      async onMessage(data: Uint8Array, { isAuthenticated }: { isAuthenticated: boolean }) {
        if (!isAuthenticated) return
        return await db.runExclusive(() => db.execProtocolRaw(data))
      },
    }).catch(() => socket.destroy())
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  return {
    port,
    async stop() {
      for (const s of socks) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

async function main(): Promise<void> {
  const db = await PGlite.create()
  const tls = {
    key: readFileSync(`${CERTS}/server.key`),
    cert: readFileSync(`${CERTS}/server.crt`),
  }

  // -- SCRAM-SHA-256 over TLS: exercises std-shim base64 both directions ------
  console.log('\n=== SCRAM-SHA-256 (patched std-shim base64) ===')
  {
    const scramData = createScramSha256Data(PASSWORD)
    const s = await serve(db, {
      tls,
      auth: { method: 'scram-sha-256', getScramSha256Data: () => scramData },
    })
    const url = `postgresql://postgres@127.0.0.1:${s.port}/postgres?sslmode=require`
    const good = await psql(url, 'select 1001')
    if (good.includes('1001')) ok('SCRAM-SHA-256 accepted the correct password over TLS')
    else fail(`SCRAM with correct password failed: ${good.split('\n')[0]}`)

    process.env.TEST_PGPASSWORD = 'wrong-password'
    const bad = await psql(url, 'select 1001')
    delete process.env.TEST_PGPASSWORD
    if (!bad.includes('1001') && /password|auth/i.test(bad)) {
      ok(`SCRAM-SHA-256 REJECTED the wrong password (${bad.split('\n')[0].slice(0, 60)})`)
    } else {
      fail(`wrong password was not rejected: ${bad.split('\n')[0]}`)
    }
    await s.stop()
  }

  // -- md5: the ONLY consumer of the removed WASM crypto module ---------------
  console.log('\n=== md5 auth (node:crypto replacing the @std/crypto WASM blob) ===')
  {
    const preHashed = await createPreHashedPassword('postgres', PASSWORD)
    const s = await serve(db, {
      auth: { method: 'md5', getPreHashedPassword: () => preHashed },
    })
    const url = `postgresql://postgres@127.0.0.1:${s.port}/postgres?sslmode=disable`
    const good = await psql(url, 'select 1002')
    if (good.includes('1002')) ok('md5 accepted the correct password via node:crypto MD5')
    else fail(`md5 with correct password failed: ${good.split('\n')[0]}`)

    process.env.TEST_PGPASSWORD = 'wrong-password'
    const bad = await psql(url, 'select 1002')
    delete process.env.TEST_PGPASSWORD
    if (!bad.includes('1002') && /password|auth/i.test(bad)) {
      ok(`md5 REJECTED the wrong password (${bad.split('\n')[0].slice(0, 60)})`)
    } else {
      fail(`md5 wrong password not rejected: ${bad.split('\n')[0]}`)
    }
    await s.stop()
  }

  // -- TLS still works for clients that ACCEPT the cert ----------------------
  console.log('\n=== TLS paths the crash patch touches ===')
  {
    const s = await serve(db, { tls, auth: { method: 'trust' } })
    const base = `postgresql://postgres@127.0.0.1:${s.port}/postgres`

    const req = await psql(`${base}?sslmode=require`, 'select 1003')
    if (req.includes('1003')) ok('sslmode=require still works')
    else fail(`sslmode=require broke: ${req.split('\n')[0]}`)

    const vf = await psql(
      `${base}?sslmode=verify-full&sslrootcert=${CERTS}/server.crt&host=localhost`.replace(
        '127.0.0.1',
        'localhost',
      ),
      'select 1004',
    )
    if (vf.includes('1004')) ok('sslmode=verify-full with the CORRECT CA still works')
    else fail(`verify-full with correct CA broke: ${vf.split('\n')[0]}`)

    // NOT a patch regression: upstream connection.ts refuses plaintext startup
    // whenever `tls` is configured ("Guard against SSL connection not being
    // established when tls is enabled"). Asserting the real behaviour, because
    // it matters for us: pg-gateway has no "TLS optional" mode, so a gateway with
    // certs configured rejects every sslmode=disable client outright.
    const dis = await psql(`${base}?sslmode=disable`, 'select 1005')
    if (/SSL connection is required/i.test(dis)) {
      ok('sslmode=disable is refused when tls is configured (upstream behaviour, TLS is all-or-nothing)')
    } else if (dis.includes('1005')) {
      fail('sslmode=disable was ALLOWED against a TLS gateway - the TLS guard regressed')
    } else {
      fail(`sslmode=disable failed for an unexpected reason: ${dis.split('\n')[0]}`)
    }
    await s.stop()

    // And with no tls configured at all, plaintext must of course work.
    const plain = await serve(db, { auth: { method: 'trust' } })
    const p = await psql(
      `postgresql://postgres@127.0.0.1:${plain.port}/postgres?sslmode=disable`,
      'select 1006',
    )
    if (p.includes('1006')) ok('plaintext gateway (no tls option) still works')
    else fail(`plaintext gateway broke: ${p.split('\n')[0]}`)
    await plain.stop()
  }

  await db.close()
  console.log(`\n${'='.repeat(60)}\nfailures: ${failures}`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
