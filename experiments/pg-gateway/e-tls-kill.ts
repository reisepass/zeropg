// The remote process kill: does one unauthenticated packet take down the whole
// Node process?
//
// Claim under test: a client that rejects the server certificate (TLS alert
// unknown_ca, e.g. `psql sslmode=verify-full` with a mismatched CA) raises an
// unhandled ERR_INVALID_STATE "WritableStream is locked" that escapes a try/catch
// around fromNodeSocket and kills the process.
//
// This runs as a PARENT that spawns a child server per scenario, so a real
// process death is observable as an exit code rather than taking the harness
// with it. Child mode is selected by argv[2].
//
// Run: npx tsx experiments/pg-gateway/e-tls-kill.ts

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from 'pg-gateway/node'

// pg-gateway types TLS material as ArrayBuffer; a Buffer is a view, so copy out its bytes.
const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const SELF = fileURLToPath(import.meta.url)
const CERTS = '/tmp/pggw-certs'

// ---------------------------------------------------------------------------
// CHILD: a pg-gateway TLS server, wrapped in every guard an application could
// reasonably apply from OUTSIDE the library.
// ---------------------------------------------------------------------------
async function child(patched: boolean): Promise<void> {
  const db = await PGlite.create()
  const tls = {
    key: toArrayBuffer(readFileSync(`${CERTS}/server.key`)),
    cert: toArrayBuffer(readFileSync(`${CERTS}/server.crt`)),
  }

  const server: Server = createServer((socket) => {
    socket.on('error', () => {
      /* guard 1: socket-level errors */
    })
    // guard 2: try/catch plus .catch() around the library entry point, which is
    // the documented way to handle a failed connection.
    try {
      fromNodeSocket(socket, {
        tls,
        auth: { method: 'trust' },
        async onMessage(data: Uint8Array, { isAuthenticated }: { isAuthenticated: boolean }) {
          if (!isAuthenticated) return
          return await db.runExclusive(() => db.execProtocolRaw(data))
        },
      }).catch((e: unknown) => {
        console.error(`[child] fromNodeSocket rejected (caught): ${(e as Error).message}`)
        socket.destroy()
      })
    } catch (e) {
      console.error(`[child] synchronous throw (caught): ${(e as Error).message}`)
      socket.destroy()
    }
  })

  if (patched) {
    // guard 3, the PATCH CANDIDATE: the only thing that can actually stop the
    // process dying from outside the library. See the writeup in the queue doc.
    process.on('uncaughtException', (e: Error & { code?: string }) => {
      console.error(`[child] uncaughtException INTERCEPTED: ${e.code} ${e.message}`)
    })
    process.on('unhandledRejection', (e: unknown) => {
      const err = e as Error & { code?: string }
      console.error(`[child] unhandledRejection INTERCEPTED: ${err.code} ${err.message}`)
    })
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  console.log(`[child] READY ${port}`)

  // Heartbeat: proves the process is still alive and the event loop still turns.
  let beats = 0
  setInterval(() => {
    beats++
    console.log(`[child] ALIVE ${beats}`)
  }, 400)
}

// ---------------------------------------------------------------------------
// PARENT
// ---------------------------------------------------------------------------
interface Outcome {
  died: boolean
  exitCode: number | null
  signal: string | null
  aliveBeatsAfter: number
  log: string[]
}

function runScenario(
  name: string,
  patched: boolean,
  attack: (port: number) => Promise<string>,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const kid = spawn('npx', ['tsx', SELF, patched ? 'child-patched' : 'child'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log: string[] = []
    let port = 0
    let beatsAtAttack = -1
    let done = false
    let attackOutput = ''

    const finish = (died: boolean, exitCode: number | null, signal: string | null): void => {
      if (done) return
      done = true
      const beatsNow = log.filter((l) => l.includes('ALIVE')).length
      clearTimeout(timer)
      if (!kid.killed) kid.kill('SIGKILL')
      console.log(`\n--- ${name} ---`)
      for (const l of log.slice(0, 14)) console.log(`    ${l}`)
      if (attackOutput.trim()) {
        console.log(`    [client] ${attackOutput.trim().split('\n').slice(0, 3).join(' | ')}`)
      }
      resolve({
        died,
        exitCode,
        signal,
        aliveBeatsAfter: beatsAtAttack < 0 ? 0 : beatsNow - beatsAtAttack,
        log,
      })
    }

    const onLine = (line: string): void => {
      if (!line.trim()) return
      log.push(line)
      const m = line.match(/READY (\d+)/)
      if (m && !port) {
        port = Number(m[1])
        void (async () => {
          attackOutput = await attack(port)
          beatsAtAttack = log.filter((l) => l.includes('ALIVE')).length
          // let the process live (or die) for a couple more heartbeats
          setTimeout(() => finish(false, null, null), 1600)
        })()
      }
    }

    kid.stdout.on('data', (d: Buffer) => d.toString().split('\n').forEach(onLine))
    kid.stderr.on('data', (d: Buffer) => d.toString().split('\n').forEach(onLine))
    kid.on('exit', (code, sig) => finish(true, code, sig))
    const timer = setTimeout(() => finish(false, null, null), 25_000)
  })
}

function psql(args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('psql', args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.stderr.on('data', (d: Buffer) => (out += d.toString()))
    p.on('close', () => resolve(out))
    setTimeout(() => p.kill('SIGKILL'), 8000)
  })
}

let failures = 0
const verdict = (label: string, o: Outcome, expectDeath: boolean): void => {
  const died = o.died
  console.log(
    `    => process ${died ? `DIED (exit=${o.exitCode} sig=${o.signal})` : `SURVIVED (${o.aliveBeatsAfter} heartbeats after)`}`,
  )
  if (died === expectDeath) {
    console.log(`    ok   ${label}`)
  } else {
    console.log(`    FAIL ${label}`)
    failures++
  }
}

async function main(): Promise<void> {
  console.log('### The remote process kill: psql rejecting the server cert\n')

  // 1. verify-full against a CA that did NOT sign the server cert.
  const a = await runScenario('1. psql sslmode=verify-full, mismatched CA (UNPATCHED)', false, (port) =>
    psql([
      `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=verify-full&sslrootcert=${CERTS}/other-ca.crt`,
      '-c',
      'select 1',
    ]),
  )
  verdict('one unauthenticated packet kills the whole Node process', a, true)

  // 2. sslmode=require: client does NOT verify, so no alert. Control case.
  const b = await runScenario('2. psql sslmode=require, same server (control)', false, (port) =>
    psql([`postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=require`, '-c', 'select 1']),
  )
  verdict('a client that accepts the cert leaves the process alive', b, false)

  // 3. verify-ca, mismatched CA: same alert class, different check.
  const c = await runScenario('3. psql sslmode=verify-ca, mismatched CA (UNPATCHED)', false, (port) =>
    psql([
      `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=verify-ca&sslrootcert=${CERTS}/other-ca.crt`,
      '-c',
      'select 1',
    ]),
  )
  verdict('verify-ca with a bad CA also kills the process', c, true)

  // 4. the same attack against the patched child.
  const d = await runScenario('4. psql sslmode=verify-full, mismatched CA (PATCHED)', true, (port) =>
    psql([
      `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=verify-full&sslrootcert=${CERTS}/other-ca.crt`,
      '-c',
      'select 1',
    ]),
  )
  verdict('a process-level handler keeps the process alive', d, false)

  // 5. does the PATCHED server still serve other clients after the attack?
  console.log('\n--- 5. survivability: can a good client still connect after the attack? ---')
  const survived = await new Promise<string>((resolve) => {
    const kid = spawn('npx', ['tsx', SELF, 'child-patched'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let port = 0
    let result = 'never became ready'
    const onLine = async (line: string): Promise<void> => {
      const m = line.match(/READY (\d+)/)
      if (m && !port) {
        port = Number(m[1])
        // attack first
        await psql([
          `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=verify-full&sslrootcert=${CERTS}/other-ca.crt`,
          '-c',
          'select 1',
        ])
        // then a legitimate client
        const good = await psql([
          `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=require`,
          '-tAc',
          'select 777',
        ])
        result = good.includes('777') ? 'GOOD CLIENT SERVED (777)' : `good client failed: ${good.trim().split('\n')[0]}`
        kid.kill('SIGKILL')
        resolve(result)
      }
    }
    kid.stdout.on('data', (d: Buffer) => d.toString().split('\n').forEach((l) => void onLine(l)))
    kid.stderr.on('data', (d: Buffer) => d.toString().split('\n').forEach((l) => void onLine(l)))
    kid.on('exit', () => resolve(result))
    setTimeout(() => {
      kid.kill('SIGKILL')
      resolve(result)
    }, 25_000)
  })
  console.log(`    ${survived}`)
  if (survived.includes('777')) {
    console.log('    ok   patched server still serves legitimate clients after the attack')
  } else {
    console.log('    FAIL patched server was left unusable')
    failures++
  }

  console.log(`\n${'='.repeat(60)}\nfailures: ${failures}`)
  process.exit(0)
}

const mode = process.argv[2]
if (mode === 'child' || mode === 'child-patched') {
  void child(mode === 'child-patched')
} else {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
