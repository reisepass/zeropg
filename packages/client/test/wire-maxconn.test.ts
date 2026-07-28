// Run: tsx packages/client/test/wire-maxconn.test.ts
//
// Over-cap connections must be refused IN PROTOCOL. pglite-socket's own
// handleConnection writes the raw string "Too many connections\n" and ends the
// socket, which is not a Postgres message at all, so clients report:
//
//   psql            "server closed the connection unexpectedly ... the server
//                    terminated abnormally"
//   node-postgres   "Connection terminated unexpectedly"  (err.code undefined)
//
// Both read like a crash, which is what led a user to conclude the wire protocol
// was broken when it was working. WireFrontend owns the public port, so it can
// answer with a real ErrorResponse carrying SQLSTATE 53300 instead.

import { Client } from 'pg'
import { serveWire } from '../src/wire.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

interface PgError extends Error {
  code?: string
}

async function main(): Promise<void> {
  console.log('over-cap connections get a protocol ErrorResponse, not a bare disconnect')
  const cap = 2
  const w = await serveWire({ maxConnections: cap })
  const url = `${w.url}?sslmode=disable`
  const held: Client[] = []
  try {
    // Fill the cap. Every one of these must work: the limit is the number of
    // connections the caller actually gets, not one less.
    for (let i = 0; i < cap; i++) {
      const c = new Client({ connectionString: url })
      await c.connect()
      const r = await c.query('select 1 as n')
      ok(r.rows[0].n === 1, `connection ${i + 1}/${cap} within the cap works`)
      held.push(c)
    }

    // The next one is over cap.
    const over = new Client({ connectionString: url })
    let err: PgError | null = null
    try {
      await over.connect()
    } catch (e) {
      err = e as PgError
    }
    ok(err !== null, 'the over-cap connection was refused')
    ok(
      err?.code === '53300',
      `refusal carries SQLSTATE 53300 too_many_connections (got ${JSON.stringify(err?.code)})`,
    )
    // The old behavior produced these exact strings; they must not come back.
    const msg = String(err?.message ?? '')
    ok(
      !/terminated unexpectedly|ECONNRESET/i.test(msg),
      `the message is not a bare-disconnect artifact (got ${JSON.stringify(msg)})`,
    )
    ok(/too many connections/i.test(msg), 'the message says what went wrong')
    ok(new RegExp(String(cap)).test(msg), `the message names the limit (${cap})`)
    ok(/maxConnections/i.test(msg), 'the message names the option that raises it')

    // A slot must be reclaimed when a connection closes, or the cap leaks and
    // the server degrades to unusable after enough churn.
    const freed = held.pop()
    await freed?.end()
    // end() resolves before the server has necessarily seen the FIN; retry
    // briefly rather than racing it.
    let reconnected = false
    for (let i = 0; i < 40 && !reconnected; i++) {
      const c = new Client({ connectionString: url })
      try {
        await c.connect()
        await c.query('select 1')
        held.push(c)
        reconnected = true
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    ok(reconnected, 'closing a connection frees its slot for a new one')
  } finally {
    for (const c of held) await c.end().catch(() => {})
    await w.stop()
  }

  console.log(`\nPASS - ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
