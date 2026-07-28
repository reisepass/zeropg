// Run: tsx packages/client/test/wire-sslmode.test.ts
//
// Regression test for the SSL-negotiation hang. @electric-sql/pglite-socket
// (0.2.x) does not implement SSL/GSSENC negotiation: a libpq client at its
// DEFAULT sslmode=prefer first sends an 8-byte SSLRequest, pglite-socket buffers
// it as if it were the head of a StartupMessage and never replies, and the client
// hangs silently until timeout. That is the worst failure mode there is - no
// error, just a stall - and it forced every consumer to remember
// ?sslmode=disable / PGSSLMODE=disable.
//
// These cases drive REAL libpq (/usr/bin/psql), not node-postgres, because the
// node driver does not send SSLRequest unless explicitly configured, so only a
// real libpq client exercises the defect.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { serveWire } from '../src/wire.js'

const PSQL = '/usr/bin/psql'
// Short enough that a regression fails the suite fast instead of hanging it.
const TIMEOUT_MS = 10_000

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

interface PsqlResult {
  out: string
  err: string
  /** True when psql had to be killed, i.e. it hung rather than answering. */
  timedOut: boolean
  ms: number
}

/** Run `psql <conn> -tAc 'SELECT 1'` under a hard timeout. */
function psql(conn: string): Promise<PsqlResult> {
  const t0 = Date.now()
  return new Promise((res) => {
    execFile(
      PSQL,
      [conn, '-tAc', 'SELECT 1'],
      // PGCONNECT_TIMEOUT is libpq's own guard; the execFile timeout is the
      // backstop that actually kills a silent hang.
      { timeout: TIMEOUT_MS, env: { ...process.env, PGCONNECT_TIMEOUT: '30' } },
      (e, out, err) => {
        const killed = !!(e as { killed?: boolean } | null)?.killed
        res({ out: out.trim(), err: err.trim(), timedOut: killed, ms: Date.now() - t0 })
      },
    )
  })
}

// ---- byte-level framing helpers ----
//
// psql always coalesces its SSLRequest into one segment, so it cannot by itself
// cover the TCP segmentation the front-end has to survive. These drive the
// socket by hand: the negotiation packet and the StartupMessage can arrive in
// ONE segment, or the 8 negotiation bytes can arrive split across several. Both
// must work and neither may lose buffered bytes.

function negotiationPacket(code: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeInt32BE(8, 0)
  b.writeInt32BE(code, 4)
  return b
}
const sslRequest = () => negotiationPacket(80877103)
const gssRequest = () => negotiationPacket(80877104)

/** A minimal protocol-3.0 StartupMessage for user/database postgres. */
function startupMessage(): Buffer {
  const params = Buffer.from('user\0postgres\0database\0postgres\0\0', 'latin1')
  const b = Buffer.alloc(8 + params.length)
  b.writeInt32BE(8 + params.length, 0)
  b.writeInt32BE(196608, 4) // 3.0
  params.copy(b, 8)
  return b
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Framing {
  /** Count of 'N' negotiation replies the server sent. */
  nCount: number
  /** True if the first byte was an 'N'. */
  leadingN: boolean
  /** True if the server answered the StartupMessage (AuthenticationOk / ReadyForQuery),
   *  which is the proof that no buffered bytes were dropped in the handoff. */
  startupAnswered: boolean
}

async function framing(port: number, send: (s: Socket) => Promise<void>): Promise<Framing> {
  const s = connect({ host: '127.0.0.1', port })
  let got = Buffer.alloc(0)
  s.on('data', (d: Buffer) => {
    got = Buffer.concat([got, d])
  })
  s.on('error', () => {})
  await new Promise<void>((r) => s.once('connect', () => r()))
  await send(s)
  await sleep(700)
  s.destroy()
  return {
    nCount: [...got].filter((b) => b === 0x4e).length, // 'N'
    leadingN: got[0] === 0x4e,
    startupAnswered: got.includes(0x52) || got.includes(0x5a), // 'R' auth / 'Z' ready
  }
}

async function main(): Promise<void> {
  if (!existsSync(PSQL)) {
    // Do not silently pass: a missing psql means these cases were NOT verified.
    throw new Error(`${PSQL} not found - cannot verify libpq SSL negotiation`)
  }

  const w = await serveWire()
  const base = `postgres://127.0.0.1:${w.port}/postgres`
  try {
    // The regression case. No sslmode in the string => libpq defaults to
    // prefer => it opens with an SSLRequest. Before the WireFrontend fix this
    // hung and was killed at the timeout.
    console.log('libpq default sslmode (prefer): SSLRequest is answered, not ignored')
    const prefer = await psql(base)
    ok(!prefer.timedOut, `default sslmode did not hang (${prefer.ms}ms)`)
    ok(prefer.out === '1', `default sslmode ran SELECT 1 (got ${JSON.stringify(prefer.out)} ${prefer.err})`)

    // Isolates the defect to negotiation: this path never sends an SSLRequest
    // and worked even before the fix. It must keep working.
    console.log('sslmode=disable: unchanged, still works')
    const disable = await psql(`${base}?sslmode=disable`)
    ok(!disable.timedOut, `sslmode=disable did not hang (${disable.ms}ms)`)
    ok(disable.out === '1', `sslmode=disable ran SELECT 1 (got ${JSON.stringify(disable.out)})`)

    // We answer 'N' (SSL not supported), so a client that REQUIRES SSL must get
    // a clean, fast error. Erroring is the correct outcome; hanging is not.
    console.log('sslmode=require: clean error rather than a silent hang')
    const require_ = await psql(`${base}?sslmode=require`)
    ok(!require_.timedOut, `sslmode=require did not hang (${require_.ms}ms)`)
    ok(require_.out !== '1', 'sslmode=require did not silently succeed without SSL')
    ok(
      /ssl/i.test(require_.err),
      `sslmode=require reported a real SSL error (got ${JSON.stringify(require_.err)})`,
    )

    // The port callers connect to must be the front-end's public port, not the
    // private inner one - psql above already proved it is reachable.
    console.log('port/url contract')
    ok(w.url === `postgres://127.0.0.1:${w.port}/postgres`, `url matches port: ${w.url}`)

    console.log('TCP framing: negotiation and startup across segment boundaries')

    // SSLRequest and StartupMessage coalesced into a single segment. The naive
    // implementation replies N and then throws away the startup bytes it had
    // already read.
    const coalesced = await framing(w.port, async (s) => {
      s.write(Buffer.concat([sslRequest(), startupMessage()]))
    })
    ok(coalesced.leadingN, 'coalesced SSLRequest+Startup: replied N first')
    ok(coalesced.startupAnswered, 'coalesced SSLRequest+Startup: startup bytes survived the handoff')

    // The 8 negotiation bytes split 4+4. A decision made on a short read would
    // misparse this.
    const split = await framing(w.port, async (s) => {
      const r = sslRequest()
      s.write(r.subarray(0, 4))
      await sleep(120)
      s.write(r.subarray(4))
      await sleep(120)
      s.write(startupMessage())
    })
    ok(split.leadingN, 'SSLRequest split 4+4: replied N')
    ok(split.startupAnswered, 'SSLRequest split 4+4: startup answered')

    // Worst-case segmentation: one byte per segment.
    const dribble = await framing(w.port, async (s) => {
      for (const byte of sslRequest()) {
        s.write(Buffer.from([byte]))
        await sleep(40)
      }
      await sleep(80)
      s.write(startupMessage())
    })
    ok(dribble.leadingN, 'SSLRequest one byte per segment: replied N')
    ok(dribble.startupAnswered, 'SSLRequest one byte per segment: startup answered')

    // libpq with gssencmode sends GSSENCRequest first, then SSLRequest. Both
    // must be answered, and the startup after them must still land.
    const both = await framing(w.port, async (s) => {
      s.write(Buffer.concat([gssRequest(), sslRequest(), startupMessage()]))
    })
    ok(both.nCount >= 2, `GSSENC+SSL+Startup coalesced: replied N to both (${both.nCount})`)
    ok(both.startupAnswered, 'GSSENC+SSL+Startup coalesced: startup answered')

    // No negotiation at all (the sslmode=disable shape): the front-end must pass
    // the StartupMessage through untouched and NOT inject a spurious N.
    const bare = await framing(w.port, async (s) => {
      s.write(startupMessage())
    })
    ok(!bare.leadingN, 'bare StartupMessage: no spurious N injected')
    ok(bare.startupAnswered, 'bare StartupMessage: passed through untouched')
  } finally {
    await w.stop()
  }

  // stop() must free the public port for a later bind, and close the inner
  // listener too (a leaked inner listener would keep PGlite referenced).
  console.log('stop(): the public port is released')
  const reuse = await serveWire({ port: w.port })
  ok(reuse.port === w.port, `rebound the same port after stop() (${reuse.port})`)
  const again = await psql(`postgres://127.0.0.1:${reuse.port}/postgres`)
  ok(again.out === '1', 'the rebound server serves libpq default sslmode too')
  await reuse.stop()

  console.log(`\nPASS - ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
