// Does the vendored-source patch actually fix the remote process kill?
//
// Same attack as e-tls-kill.ts, but the child imports the PATCHED vendored source
// (vendor/patched/src) instead of the published pg-gateway package. If the patch
// works, the process survives with NO process-level uncaughtException handler -
// which is the point, since a process-level handler is a blunt instrument that
// also swallows unrelated bugs.
//
// Run: npx tsx experiments/pg-gateway/e-tls-kill-patched.ts

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from './vendor/patched/src/platforms/node/index.ts'

// pg-gateway types TLS material as ArrayBuffer; a Buffer is a view, so copy out its bytes.
const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const SELF = fileURLToPath(import.meta.url)
const CERTS = '/tmp/pggw-certs'

async function child(): Promise<void> {
  const db = await PGlite.create()
  const tls = {
    key: toArrayBuffer(readFileSync(`${CERTS}/server.key`)),
    cert: toArrayBuffer(readFileSync(`${CERTS}/server.crt`)),
  }

  // DELIBERATELY NO process.on('uncaughtException') / ('unhandledRejection').
  // If the process survives, it is the source patch doing it, not a safety net.
  const server: Server = createServer((socket) => {
    socket.on('error', () => {})
    fromNodeSocket(socket, {
      tls,
      auth: { method: 'trust' },
      onConnectionError(e: Error) {
        console.log(`[child] onConnectionError: ${(e as Error & { code?: string }).code ?? ''} ${e.message}`)
      },
      async onMessage(data: Uint8Array, { isAuthenticated }: { isAuthenticated: boolean }) {
        if (!isAuthenticated) return
        return await db.runExclusive(() => db.execProtocolRaw(data))
      },
    }).catch((e: unknown) => {
      console.log(`[child] fromNodeSocket rejected: ${(e as Error).message}`)
      socket.destroy()
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  console.log(`[child] READY ${port}`)
  let beats = 0
  setInterval(() => console.log(`[child] ALIVE ${++beats}`), 400)
}

function psql(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('psql', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', () => resolve(out))
    setTimeout(() => p.kill('SIGKILL'), 8000)
  })
}

let failures = 0

async function main(): Promise<void> {
  console.log('### PATCHED vendored source, no process-level handler\n')

  const result = await new Promise<{ died: boolean; code: number | null; log: string[]; good: string }>(
    (resolve) => {
      const kid = spawn('npx', ['tsx', SELF, 'child'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const log: string[] = []
      let port = 0
      let good = ''
      let done = false
      const finish = (died: boolean, code: number | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (!kid.killed) kid.kill('SIGKILL')
        resolve({ died, code, log, good })
      }
      const onLine = (line: string): void => {
        if (!line.trim()) return
        log.push(line)
        const m = line.match(/READY (\d+)/)
        if (m && !port) {
          port = Number(m[1])
          void (async () => {
            // 1. the attack, three times, to check it is not a one-shot resource leak
            for (let i = 0; i < 3; i++) {
              await psql([
                `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=verify-full&sslrootcert=${CERTS}/other-ca.crt`,
                '-c',
                'select 1',
              ])
            }
            // 2. a legitimate client afterwards
            good = await psql([
              `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=require`,
              '-tAc',
              'select 777',
            ])
            setTimeout(() => finish(false, null), 1200)
          })()
        }
      }
      kid.stdout.on('data', (d: Buffer) => d.toString().split('\n').forEach(onLine))
      kid.stderr.on('data', (d: Buffer) => d.toString().split('\n').forEach(onLine))
      kid.on('exit', (code) => finish(true, code))
      const timer = setTimeout(() => finish(false, null), 40_000)
    },
  )

  for (const l of result.log.slice(0, 20)) console.log(`    ${l}`)

  if (!result.died) {
    console.log('\n    ok   process SURVIVED 3 cert-rejection attacks with no process-level handler')
  } else {
    console.log(`\n    FAIL process DIED (exit=${result.code})`)
    failures++
  }

  const errs = result.log.filter((l) => l.includes('onConnectionError')).length
  console.log(`    onConnectionError fired ${errs} time(s) - errors are reported, not swallowed silently`)
  if (errs === 0) {
    console.log('    FAIL the patch hid the error entirely instead of routing it')
    failures++
  } else {
    console.log('    ok   the failure is still observable through the error sink')
  }

  if (result.good.includes('777')) {
    console.log('    ok   legitimate psql client served afterwards (777)')
  } else {
    console.log(`    FAIL legitimate client failed: ${result.good.trim().split('\n')[0]}`)
    failures++
  }

  console.log(`\n${'='.repeat(60)}\nfailures: ${failures}`)
  process.exit(0)
}

if (process.argv[2] === 'child') {
  void child()
} else {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
