// sslnegotiation=direct: does pg-gateway HANG or ERROR?
//
// PG17+ libpq with `sslnegotiation=direct` sends a TLS ClientHello (first byte
// 0x16) as the very first bytes on the socket, with ALPN protocol id `postgresql`,
// and NEVER sends the SSLRequest packet. pg-gateway has no ALPN support and its
// framer reads that first byte as a message type.
//
// A hang is the exact failure class zeropg exists to eliminate - a client that
// errors tells the user what to fix, a client that hangs burns their connection
// budget and their afternoon. So the question is not "does it work" (we know it
// does not) but "does it fail fast".
//
// CLIENT NOTE: the psql available here is 16.14, which predates the
// `sslnegotiation` parameter entirely (rejected as "invalid URI query parameter").
// So this drives node:tls directly, which emits a genuine TLS ClientHello with the
// ALPN extension - byte-for-byte the same opening move libpq makes. The property
// under test is what the SERVER does with 0x16 as the first byte, and that does
// not depend on which client produced it.
//
// Run: npx tsx experiments/pg-gateway/e-direct-tls-alpn.ts

import { readFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createServer, type Server, type Socket } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { fromNodeSocket } from 'pg-gateway/node'
import { freePort } from './lib/gateway.ts'

// pg-gateway types TLS material as ArrayBuffer; a Buffer is a view, so copy out its bytes.
const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const CERTS = '/tmp/pggw-certs'
let failures = 0
const ok = (m: string): void => console.log(`  ok   ${m}`)
const fail = (m: string): void => {
  console.log(`  FAIL ${m}`)
  failures++
}
const note = (m: string): void => console.log(`  NOTE ${m}`)

interface Srv {
  port: number
  stop: () => Promise<void>
}

async function serveTls(db: PGlite): Promise<Srv> {
  const port = await freePort()
  const socks = new Set<Socket>()
  const server: Server = createServer((socket) => {
    socks.add(socket)
    socket.on('close', () => socks.delete(socket))
    socket.on('error', () => {})
    fromNodeSocket(socket, {
      tls: {
        key: toArrayBuffer(readFileSync(`${CERTS}/server.key`)),
        cert: toArrayBuffer(readFileSync(`${CERTS}/server.crt`)),
      },
      auth: { method: 'trust' },
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

type Outcome =
  | { kind: 'hang'; ms: number }
  | { kind: 'error'; ms: number; detail: string }
  | { kind: 'closed'; ms: number }
  | { kind: 'connected'; ms: number; alpn: string | false | null }

/** Direct TLS, exactly what sslnegotiation=direct does: ClientHello first. */
function directTls(port: number, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    const done = (o: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      resolve(o)
    }
    const sock = tlsConnect(
      {
        port,
        host: '127.0.0.1',
        // The ALPN id PG17 registered for direct SSL connections.
        ALPNProtocols: ['postgresql'],
        rejectUnauthorized: false,
      },
      () => done({ kind: 'connected', ms: Date.now() - t0, alpn: sock.alpnProtocol }),
    )
    sock.on('error', (e: Error & { code?: string }) =>
      done({ kind: 'error', ms: Date.now() - t0, detail: `${e.code ?? ''} ${e.message}`.trim() }),
    )
    sock.on('close', () => done({ kind: 'closed', ms: Date.now() - t0 }))
    const timer = setTimeout(() => done({ kind: 'hang', ms: Date.now() - t0 }), timeoutMs)
  })
}

/** Raw 0x16 first byte with no follow-up, to see whether the server ever answers. */
function rawClientHelloByte(port: number, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    let bytesBack = 0
    const done = (o: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(o)
    }
    const sock = netConnect(port, '127.0.0.1', () => {
      // A TLS record header claiming a 512-byte handshake body, then nothing more.
      // This is what the first 5 bytes of a real ClientHello look like.
      sock.write(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]))
    })
    sock.on('data', (d: Buffer) => {
      bytesBack += d.length
      done({ kind: 'error', ms: Date.now() - t0, detail: `server replied ${bytesBack} bytes` })
    })
    sock.on('error', (e: Error & { code?: string }) =>
      done({ kind: 'error', ms: Date.now() - t0, detail: `${e.code ?? ''} ${e.message}`.trim() }),
    )
    sock.on('close', () => done({ kind: 'closed', ms: Date.now() - t0 }))
    const timer = setTimeout(() => done({ kind: 'hang', ms: Date.now() - t0 }), timeoutMs)
  })
}

const describe = (o: Outcome): string => {
  switch (o.kind) {
    case 'hang':
      return `HUNG (no response, no close, still open after ${o.ms}ms)`
    case 'error':
      return `errored after ${o.ms}ms: ${o.detail}`
    case 'closed':
      return `connection closed by server after ${o.ms}ms`
    case 'connected':
      return `TLS ESTABLISHED after ${o.ms}ms, alpn=${JSON.stringify(o.alpn)}`
  }
}

async function main(): Promise<void> {
  console.log('### sslnegotiation=direct / ALPN against pg-gateway\n')
  console.log('Client: node:tls (real ClientHello + ALPN "postgresql").')
  console.log('Local psql is 16.14 and rejects sslnegotiation outright, so it cannot drive this.\n')

  const db = await PGlite.create()
  const s = await serveTls(db)

  console.log('--- 1. direct TLS ClientHello with ALPN, the PG17 opening move ---')
  const a = await directTls(s.port, 10_000)
  console.log(`    ${describe(a)}`)
  if (a.kind === 'hang') {
    fail('pg-gateway HANGS on a direct TLS ClientHello - the exact failure class we exist to eliminate')
  } else if (a.kind === 'connected') {
    note('TLS actually completed. Check ALPN: without it PG17 clients still abort.')
    if (a.alpn === 'postgresql') ok('ALPN negotiated as postgresql')
    else fail(`no ALPN negotiated (${JSON.stringify(a.alpn)}), PG17 direct clients require it`)
  } else {
    ok(`fails fast rather than hanging (${a.kind})`)
  }

  console.log('\n--- 2. bare 0x16 TLS record header, nothing else ---')
  const b = await rawClientHelloByte(s.port, 10_000)
  console.log(`    ${describe(b)}`)
  if (b.kind === 'hang') {
    fail('server neither answers nor closes on a 0x16 first byte - it hangs holding the connection')
  } else {
    ok(`does not hang on a bare 0x16 (${b.kind})`)
  }

  console.log('\n--- 3. control: the SSLRequest path a PG16 client uses ---')
  const c = await new Promise<Outcome>((resolve) => {
    const t0 = Date.now()
    let settled = false
    const done = (o: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(o)
    }
    const sock = netConnect(s.port, '127.0.0.1', () => {
      // SSLRequest: int32 len=8, int32 80877103
      const req = Buffer.alloc(8)
      req.writeInt32BE(8, 0)
      req.writeInt32BE(80877103, 4)
      sock.write(req)
    })
    sock.on('data', (d: Buffer) =>
      done({
        kind: 'error',
        ms: Date.now() - t0,
        detail: `server replied ${JSON.stringify(d.toString('latin1'))}`,
      }),
    )
    sock.on('error', (e: Error) => done({ kind: 'error', ms: Date.now() - t0, detail: e.message }))
    sock.on('close', () => done({ kind: 'closed', ms: Date.now() - t0 }))
    const timer = setTimeout(() => done({ kind: 'hang', ms: Date.now() - t0 }), 10_000)
  })
  console.log(`    ${describe(c)}`)
  if (c.kind === 'error' && c.detail.includes('"S"')) {
    ok('SSLRequest is answered with S, so the negotiated path is healthy and only direct TLS is affected')
  } else {
    note(`SSLRequest control returned: ${describe(c)}`)
  }

  await s.stop()
  await db.close()
  console.log(`\n${'='.repeat(64)}\nfailures: ${failures}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
