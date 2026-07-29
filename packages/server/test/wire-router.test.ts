// Run: tsx packages/server/test/wire-router.test.ts
//
// Step 1 of docs/SPEC-wire-router.md section 8, end to end, with REAL clients:
// real node-postgres over TCP and, when a `psql` binary is on PATH, real libpq.
// A hand-rolled socket test would prove the bytes are what I intended; it would
// not prove they are what a driver accepts, and the whole point of the router is
// that unmodified Postgres clients work against it.
//
// What is asserted:
//   - routing by the StartupMessage `database` field, to the right instance
//   - an unknown name gets 3D000 invalid_catalog_name, not a dropped socket
//   - the handshake is PGlite's REAL harvested one (server_version from the
//     backend, all 15 ParameterStatus messages present)
//   - BackendKeyData is per-connection, not PGlite's hardcoded pid=42
//   - the startup packet is NOT forwarded: exactly one ReadyForQuery arrives,
//     so a pipelining client cannot desynchronize
//   - warm set fixed at 1 refuses a second database in protocol (53400)
//   - transactions on the shared session stay isolated between connections
//   - `psql`, at its DEFAULT sslmode (no PGSSLMODE=disable), works

import { Client } from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import { WireRouter } from '../src/wire-router.js'
import { catalogFrom, type DatabaseSource, type RoutedInstance } from '../src/warm-set.js'
import { splitBackendMessages, decodeParameterStatus } from '../src/wire-messages.js'
import { connect } from 'node:net'

const execFileAsync = promisify(execFile)

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`)
}

interface PgError extends Error {
  code?: string
}

/** An in-memory PGlite behind the RoutedInstance contract. Real PGlite, no
 *  object store: step 1 is about routing and the handshake, not durability. */
function pgliteSource(seed?: string): DatabaseSource & { opened: number } {
  const s = {
    opened: 0,
    async open(): Promise<RoutedInstance> {
      s.opened++
      const pg = new PGlite()
      await pg.waitReady
      if (seed) await pg.exec(seed)
      return {
        engine: pg as never,
        async flush() {},
        async close() {
          await pg.close()
        },
      }
    },
  }
  return s
}

/** Drive one raw connection through startup and collect every backend byte, so
 *  the handshake can be inspected at the protocol level rather than through a
 *  driver that has already interpreted it. */
function rawStartup(
  port: number,
  params: Record<string, string>,
  waitMs = 1500,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    sock.on('error', reject)
    sock.on('data', (c) => chunks.push(c))
    sock.once('connect', () => {
      const parts: Buffer[] = []
      for (const [k, v] of Object.entries(params)) {
        parts.push(Buffer.from(k), Buffer.from([0]), Buffer.from(v), Buffer.from([0]))
      }
      parts.push(Buffer.from([0]))
      const body = Buffer.concat(parts)
      const pkt = Buffer.alloc(8 + body.length)
      pkt.writeInt32BE(8 + body.length, 0)
      pkt.writeInt32BE(196608, 4)
      body.copy(pkt, 8)
      sock.write(pkt)
      setTimeout(() => {
        sock.destroy()
        resolve(Buffer.concat(chunks))
      }, waitMs)
    })
  })
}

async function withPg<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function main(): Promise<void> {
  const app = pgliteSource("create table t (id serial primary key, tag text); insert into t (tag) values ('from-app')")
  const other = pgliteSource("create table t (id serial primary key, tag text); insert into t (tag) values ('from-other')")

  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const router = new WireRouter({
    catalog: catalogFrom({ app, other }),
    maxWarm: 1,
    maxConnections: 8,
    onLog: (event, fields) => logs.push({ event, fields }),
  })
  await router.start()
  const port = router.port
  ok(port > 0, `router bound a public port (${port})`)
  const url = (db: string) => `postgres://someuser@127.0.0.1:${port}/${db}`

  try {
    // ---- 1. Routing by database name, with a real driver ----
    console.log('routing: the StartupMessage database field selects the instance')
    await withPg(url('app'), async (c) => {
      const r = await c.query('select tag from t')
      eq(r.rows, [{ tag: 'from-app' }], 'routed to "app" and read its own table')
      const v = await c.query('select version() v')
      ok(String(v.rows[0].v).includes('PostgreSQL'), 'the backend is a real PostgreSQL')
    })
    eq(app.opened, 1, 'the "app" instance was started exactly once')
    eq(router.warmDatabases, ['app'], 'warm set holds "app"')

    // ---- 2. The handshake is PGlite's real one ----
    console.log('handshake: harvested from PGlite, not synthesized, not forwarded')
    const block = await rawStartup(port, { user: 'alice', database: 'app', application_name: 'myapp' })
    const msgs = splitBackendMessages(block)
    const types = msgs.map((m) => m.type).join('')
    eq(types, 'R' + 'S'.repeat(15) + 'KZ', 'exactly R + 15 ParameterStatus + K + Z')
    // Exactly ONE Z. If the client's startup packet were forwarded to PGlite it
    // would answer with a second full handshake and the client would see two,
    // which desynchronizes any pipelining driver.
    eq(msgs.filter((m) => m.type === 'Z').length, 1, 'exactly one ReadyForQuery (startup packet not forwarded)')
    const z = msgs.find((m) => m.type === 'Z')!
    eq(String.fromCharCode(z.payload[0]!), 'I', 'ReadyForQuery status forced to I (idle)')
    eq(msgs.filter((m) => m.type === 'R').length, 1, 'exactly one AuthenticationOk')

    const params = new Map(
      msgs.filter((m) => m.type === 'S').map((m) => {
        const p = decodeParameterStatus(m.payload)
        return [p.key, p.value] as const
      }),
    )
    // Compare against what THIS PGlite build actually reports, rather than a
    // string baked into the test: a wrong server_version is exactly the kind of
    // silent breakage harvesting exists to prevent.
    // SHOW names its output column after the setting, so no alias is possible.
    const probe = new PGlite()
    await probe.waitReady
    const real = await probe.query<{ server_version: string }>('show server_version')
    const realTz = await probe.query<{ TimeZone: string }>('show timezone')
    await probe.close()
    eq(params.get('server_version'), real.rows[0]!.server_version, 'server_version is the backend truth')
    eq(params.get('TimeZone'), realTz.rows[0]!.TimeZone, 'TimeZone is the backend truth, not a guess')
    ok(params.get('DateStyle') === 'ISO, MDY', `DateStyle passed through (${params.get('DateStyle')})`)
    ok(params.get('client_encoding') === 'UTF8', 'client_encoding passed through')
    // PGlite reports both of these as "" no matter what the client sent. The
    // router parsed the startup packet, so it can be correct where PGlite is not.
    eq(params.get('application_name'), 'myapp', 'application_name echoes the client, unlike PGlite')
    eq(params.get('session_authorization'), 'alice', 'session_authorization is the startup user, unlike PGlite')

    const k = msgs.find((m) => m.type === 'K')!
    const pid1 = k.payload.readInt32BE(0)
    const secret1 = k.payload.readInt32BE(4)
    ok(pid1 !== 42, `BackendKeyData pid is not PGlite's hardcoded 42 (got ${pid1})`)
    ok(secret1 !== 2875488, `BackendKeyData secret is not PGlite's hardcoded 2875488 (got ${secret1})`)
    const block2 = await rawStartup(port, { user: 'alice', database: 'app' })
    const k2 = splitBackendMessages(block2).find((m) => m.type === 'K')!
    ok(
      k2.payload.readInt32BE(0) !== pid1 || k2.payload.readInt32BE(4) !== secret1,
      'BackendKeyData differs per connection',
    )

    // ---- 3. Unknown database ----
    console.log('unknown database: 3D000 invalid_catalog_name, in protocol')
    let err: PgError | null = null
    const bad = new Client({ connectionString: url('nosuchdb') })
    try {
      await bad.connect()
    } catch (e) {
      err = e as PgError
    }
    ok(err !== null, 'connecting to an unknown database was refused')
    eq(err?.code, '3D000', 'SQLSTATE is 3D000 invalid_catalog_name')
    ok(
      /database "nosuchdb" does not exist/.test(String(err?.message)),
      `message names the database (${err?.message})`,
    )
    // The failure modes this replaces: a dropped socket reads like a crash.
    const m = String(err?.message ?? '')
    ok(
      !/terminated unexpectedly|closed the connection/.test(m),
      'not reported as an unexpected disconnect',
    )

    // ---- 4. database defaults to user (the libpq rule) ----
    console.log('database defaults to the user name when the client omits it')
    await withPg(`postgres://app@127.0.0.1:${port}/`, async (c) => {
      const r = await c.query('select tag from t')
      eq(r.rows, [{ tag: 'from-app' }], 'psql -U app with no -d routed to database "app"')
    })

    // ---- 5. Warm set of 1 ----
    //
    // UPDATED for step 2. This assertion used to be "a second database is
    // refused with 53400", because step 1 shipped before the eviction protocol
    // existed and refusing was the only safe answer: eviction is a lease
    // handoff, and one that skips the flush loses the victim's unflushed
    // writes. Now that the protocol is built, a full warm set makes room by
    // EVICTING safely, so a second database is admitted rather than refused.
    // The refusal path is still exercised, in wire-eviction.test.ts, where it
    // is what happens when no victim can be flushed.
    console.log('warm set of 1: a second database evicts the first, safely')
    await withPg(url('other'), async (c) => {
      const r = await c.query('select tag from t')
      eq(r.rows, [{ tag: 'from-other' }], 'the second database was admitted and is its own instance')
    })
    eq(other.opened, 1, 'the second database was started')
    eq(router.warmDatabases, ['other'], 'the warm set still holds exactly one database')
    // And the evicted one comes back on demand, as a fresh instance.
    await withPg(url('app'), async (c) => {
      const r = await c.query('select tag from t')
      eq(r.rows, [{ tag: 'from-app' }], 'the evicted database is re-admitted on the next connection')
    })
    eq(app.opened, 2, 'the re-admitted database was opened a second time')

    // ---- 6. Transaction isolation on the shared session ----
    console.log('two connections, one PGlite session: transactions stay isolated')
    const a = new Client({ connectionString: url('app') })
    const b = new Client({ connectionString: url('app') })
    await a.connect()
    await b.connect()
    try {
      await a.query('begin')
      await a.query("insert into t (tag) values ('in-tx')")
      // b's insert must NOT land inside a's transaction. Issue it while a's
      // transaction is open, then roll a back: if the queue leaked it into the
      // transaction, the rollback would take b's row with it.
      const bInsert = b.query("insert into t (tag) values ('outside-tx')")
      await new Promise((r) => setTimeout(r, 100))
      await a.query('rollback')
      await bInsert
      const rows = await b.query('select tag from t order by id')
      eq(
        rows.rows.map((r) => (r as { tag: string }).tag),
        ['from-app', 'outside-tx'],
        "a's rollback discarded only its own row",
      )
    } finally {
      await a.end()
      await b.end()
    }

    // ---- 7. A client that disconnects mid-transaction does not wedge the DB ----
    console.log('a client abandoned inside BEGIN is rolled back, not left blocking')
    const abandoner = new Client({ connectionString: url('app') })
    // node-postgres emits an 'error' on the Client when its socket dies under
    // it, and an unhandled one would take the process down. We are killing the
    // socket deliberately, so absorb it. This is the test client's reaction to
    // its own destroy(), not anything the router did.
    abandoner.on('error', () => {})
    await abandoner.connect()
    await abandoner.query('begin')
    await abandoner.query("insert into t (tag) values ('abandoned')")
    // Hard destroy: no Terminate message, the way a killed process behaves.
    ;(abandoner as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy()
    await new Promise((r) => setTimeout(r, 300))
    await withPg(url('app'), async (c) => {
      const rows = await c.query<{ tag: string }>('select tag from t order by id')
      eq(
        rows.rows.map((r) => r.tag),
        ['from-app', 'outside-tx'],
        'the abandoned transaction was rolled back and the database still answers',
      )
    })
    await abandoner.end().catch(() => {})

    // ---- 8. Real psql, at its DEFAULT sslmode ----
    let psqlVersion = ''
    try {
      psqlVersion = (await execFileAsync('psql', ['--version'])).stdout.trim()
    } catch {
      psqlVersion = ''
    }
    if (psqlVersion) {
      console.log(`real libpq: ${psqlVersion} at its default sslmode (no PGSSLMODE=disable)`)
      const env = { ...process.env, PGPASSWORD: '' }
      delete env.PGSSLMODE
      const run = (db: string, sql: string) =>
        execFileAsync(
          'psql',
          ['-h', '127.0.0.1', '-p', String(port), '-U', 'psqluser', '-d', db, '-At', '-c', sql],
          { env },
        )
      const out = await run('app', 'select tag from t order by id')
      eq(out.stdout.trim().split('\n'), ['from-app', 'outside-tx'], 'psql read the routed database')
      const ver = await run('app', 'select version()')
      ok(ver.stdout.includes('PostgreSQL'), `psql sees a real PostgreSQL: ${ver.stdout.trim()}`)
      // psql writes over the wire, and reads it back through a fresh connection.
      await run('app', "insert into t (tag) values ('via-psql')")
      const after = await run('app', "select count(*)::int from t where tag = 'via-psql'")
      eq(after.stdout.trim(), '1', 'psql wrote a row that a later psql connection reads')
      // And an unknown database must be a clean libpq error, not a hang.
      let psqlErr = ''
      try {
        await run('nosuchdb', 'select 1')
      } catch (e) {
        psqlErr = String((e as { stderr?: string }).stderr ?? e)
      }
      ok(/3D000|does not exist/.test(psqlErr), `psql got a clean error for an unknown db: ${psqlErr.trim()}`)
    } else {
      throw new Error('FAIL: psql is not on PATH, so the real-libpq assertions could not run')
    }
  } finally {
    await router.stop()
  }

  ok(
    logs.some((l) => l.event === 'routed' && l.fields.database === 'app'),
    'the router logged the routing decision',
  )

  console.log(`\n${passed} assertions passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
