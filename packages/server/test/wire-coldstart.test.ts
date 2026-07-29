// Run: tsx packages/server/test/wire-coldstart.test.ts
//
// Step 3 of docs/SPEC-wire-router.md section 8: cold-start connection holding.
// Complete the handshake immediately, hold the first query until the database
// is ready, cap the hold, and name the phase it died in.
//
// WHY THIS IS WORTH DOING, in one measurement. ReadyForQuery is where every
// client library stops its connect-phase timer and starts its query-phase one:
// node-postgres arms connectionTimeoutMillis on connect and clears it inside
// _handleReadyForQuery. Connect-phase budgets are small and are what a cold
// start blows (Prisma's connect_timeout is 5s, which is how a slow restore
// becomes P1001). Query-phase budgets are off by default in libpq, pg, pgx and
// pgjdbc. Holding moves the wait from the budget that is too small into the one
// that is unbounded.
//
// WHAT IS ASSERTED, all with real node-postgres over TCP, plus real psql:
//   - connect() returns in milliseconds against a database that takes seconds
//     to come up, and the query then returns CORRECT rows
//   - the handshake sent early is the real harvested block, not a guess
//   - exactly one ReadyForQuery reaches the client, so nothing desynchronizes
//   - the hold is capped, and the error is a protocol-legal 57P03 that NAMES
//     the phase - leasing and restoring capped separately
//   - a restore that FAILS gives the held client an ErrorResponse, not a
//     dropped socket
//   - queries pipelined during the hold run in order once ready

import { Client } from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connect } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { WireRouter } from '../src/wire-router.js'
import { catalogFrom, type DatabaseSource, type OpenPhase, type RoutedInstance } from '../src/warm-set.js'
import { splitBackendMessages, decodeParameterStatus } from '../src/wire-messages.js'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface SlowSourceOptions {
  /** Time spent in the leasing phase before reporting 'restoring'. */
  leaseMs?: number
  /** Time spent in the restoring phase before the instance exists. */
  restoreMs?: number
  /** Fail the open with this error instead of producing an instance. */
  failWith?: string
  /** Fail during leasing rather than restoring. */
  failDuring?: OpenPhase
  seed?: string
}

/** A database whose cold start takes a controllable, phase-split amount of
 *  time. Real PGlite behind it, so what the held client eventually talks to is
 *  a real Postgres, not a stub that would prove nothing about the protocol. */
function slowSource(o: SlowSourceOptions): DatabaseSource {
  return {
    async open(onPhase?: (p: OpenPhase) => void): Promise<RoutedInstance> {
      onPhase?.('leasing')
      await sleep(o.leaseMs ?? 10)
      if (o.failWith && o.failDuring === 'leasing') throw new Error(o.failWith)
      onPhase?.('restoring')
      await sleep(o.restoreMs ?? 10)
      if (o.failWith) throw new Error(o.failWith)
      const pg = new PGlite()
      await pg.waitReady
      if (o.seed) await pg.exec(o.seed)
      return {
        engine: pg as never,
        async flush() {},
        async close() {
          await pg.close()
        },
      }
    },
  }
}

/** Raw connection: send a startup packet, collect bytes, so the handshake can
 *  be inspected as protocol rather than through a driver's interpretation. */
function rawStartup(port: number, params: Record<string, string>, waitMs: number): Promise<Buffer> {
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

async function main(): Promise<void> {
  const SEED = "create table t (id serial primary key, tag text); insert into t (tag) values ('seeded')"
  const RESTORE_MS = 3000

  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const router = new WireRouter({
    catalog: catalogFrom({
      // The database used for the happy path. Its cold start is slow enough
      // that an unheld connect would visibly block for seconds.
      slow: slowSource({ leaseMs: 150, restoreMs: RESTORE_MS, seed: SEED }),
      // Warms the process so a handshake template exists (see below).
      primer: slowSource({ leaseMs: 5, restoreMs: 5, seed: SEED }),
      // Overruns the total ceiling during restoring.
      stuck: slowSource({ leaseMs: 50, restoreMs: 60_000, seed: SEED }),
      // Overruns the leasing ceiling specifically.
      contended: slowSource({ leaseMs: 60_000, seed: SEED }),
      // Comes up part way and then fails.
      broken: slowSource({ leaseMs: 50, restoreMs: 300, failWith: 'bucket is on fire' }),
    }),
    maxWarm: 4,
    maxConnections: 16,
    flushIntervalMs: 0,
    holdMaxMs: 20_000,
    leaseHoldMs: 2_000,
    onLog: (event, fields) => logs.push({ event, fields }),
  })
  await router.start()
  const url = (db: string) => `postgres://holduser@127.0.0.1:${router.port}/${db}`

  try {
    // ---- 0. Prime the process with one real harvested handshake ----
    // A held client is answered with a block copied from an instance this
    // process already harvested: same WASM build, so the same server_version,
    // and the same process TZ. What is NOT done is guessing those values, which
    // is the silent-corruption risk the harvesting design exists to remove. On
    // a completely cold process with nothing to copy, the router says so and
    // falls back to an unheld connect rather than inventing a block.
    console.log('priming: one real handshake harvested, so held clients get a real block')
    const primed = new Client({ connectionString: url('primer') })
    await primed.connect()
    await primed.end()
    ok(
      logs.some((l) => l.event === 'cold-start-unheld'),
      'the very first connection on a cold process was NOT held (nothing real to answer with)',
    )

    // ---- 1. THE POINT: connect fast, query slow, rows correct ----
    console.log(`holding: connect returns immediately against a ${RESTORE_MS}ms cold start`)
    const t0 = Date.now()
    const c = new Client({ connectionString: url('slow') })
    await c.connect()
    const connectMs = Date.now() - t0
    const r = await c.query<{ tag: string }>('select tag from t')
    const queryMs = Date.now() - t0
    await c.end()

    console.log(`      connect returned at ${connectMs}ms, query returned at ${queryMs}ms`)
    ok(
      connectMs < RESTORE_MS / 2,
      `connect completed in ${connectMs}ms, far inside the ${RESTORE_MS}ms cold start`,
    )
    ok(
      queryMs >= RESTORE_MS,
      `the query returned at ${queryMs}ms, after the cold start actually finished`,
    )
    eq(r.rows, [{ tag: 'seeded' }], 'the held query returned correct rows from the real database')
    const heldLog = logs.find((l) => l.event === 'cold-start-held')
    ok(heldLog !== undefined, `the hold was logged (heldMs=${heldLog?.fields.heldMs})`)
    ok(
      logs.some((l) => l.event === 'handshake-early'),
      'the handshake went out before the database existed',
    )

    // ---- 2. Exactly one ReadyForQuery reaches a held client ----
    console.log('a held client sees exactly one handshake, so nothing desynchronizes')
    await router.evictDatabase('slow', 'test: go cold again')
    const block = await rawStartup(
      router.port,
      { user: 'alice', database: 'slow', application_name: 'heldapp' },
      RESTORE_MS + 1500,
    )
    const msgs = splitBackendMessages(block)
    eq(msgs.filter((m) => m.type === 'Z').length, 1, 'exactly one ReadyForQuery')
    eq(msgs.filter((m) => m.type === 'R').length, 1, 'exactly one AuthenticationOk')
    eq(msgs.map((m) => m.type).join(''), 'R' + 'S'.repeat(15) + 'KZ', 'the full real block, in order')
    const params = new Map(
      msgs.filter((m) => m.type === 'S').map((m) => {
        const p = decodeParameterStatus(m.payload)
        return [p.key, p.value] as const
      }),
    )
    const probe = new PGlite()
    await probe.waitReady
    const realVer = await probe.query<{ server_version: string }>('show server_version')
    const realTz = await probe.query<{ TimeZone: string }>('show timezone')
    await probe.close()
    eq(params.get('server_version'), realVer.rows[0]!.server_version, 'the early handshake carries the real server_version')
    eq(params.get('TimeZone'), realTz.rows[0]!.TimeZone, 'the early handshake carries the real TimeZone, not a guess')
    eq(params.get('application_name'), 'heldapp', 'application_name still echoes the client')

    // ---- 3. Queries pipelined during the hold run in order ----
    console.log('queries issued during the hold run in order once the database is ready')
    await router.evictDatabase('slow', 'test: go cold again')
    const p = new Client({ connectionString: url('slow') })
    await p.connect()
    // Fire three writes without awaiting, so all three are in flight while the
    // restore is still running. node-postgres warns that overlapping query()
    // calls on one Client are deprecated; that is exactly the pipelining shape
    // being tested, and it is the shape that breaks if a client ever sees two
    // ReadyForQuery messages.
    const q1 = p.query("insert into t (tag) values ('first')")
    const q2 = p.query("insert into t (tag) values ('second')")
    const q3 = p.query("insert into t (tag) values ('third')")
    await Promise.all([q1, q2, q3])
    const ordered = await p.query<{ tag: string }>('select tag from t order by id')
    await p.end()
    eq(
      ordered.rows.map((x) => x.tag),
      ['seeded', 'first', 'second', 'third'],
      'three queries issued during the hold applied in the order they were sent',
    )

    // ---- 4. The hold is capped, and the error names the RESTORING phase ----
    console.log('a restore that never lands: 57P03 naming phase=restoring, not a hang')
    const stuckRouter = new WireRouter({
      catalog: catalogFrom({
        primer: slowSource({ leaseMs: 5, restoreMs: 5, seed: SEED }),
        stuck: slowSource({ leaseMs: 50, restoreMs: 60_000, seed: SEED }),
      }),
      maxWarm: 4,
      flushIntervalMs: 0,
      holdMaxMs: 1500,
      leaseHoldMs: 1000,
      onLog: (event, fields) => logs.push({ event, fields }),
    })
    await stuckRouter.start()
    try {
      const warmup = new Client({ connectionString: `postgres://u@127.0.0.1:${stuckRouter.port}/primer` })
      await warmup.connect()
      await warmup.end()

      const stuck = new Client({
        connectionString: `postgres://u@127.0.0.1:${stuckRouter.port}/stuck`,
      })
      const stuckErrors: PgError[] = []
      stuck.on('error', (e) => stuckErrors.push(e as PgError))
      const tStuck = Date.now()
      await stuck.connect()
      const stuckConnect = Date.now() - tStuck
      ok(stuckConnect < 1000, `connect still returned fast (${stuckConnect}ms) - the hold is on the QUERY`)
      let qErr: PgError | null = null
      try {
        await stuck.query('select 1')
      } catch (e) {
        qErr = e as PgError
      }
      const stuckMs = Date.now() - tStuck
      const all = [...stuckErrors, qErr].filter(Boolean) as PgError[]
      const fatal = all.find((e) => e.code)
      ok(fatal !== undefined, `the held client got a Postgres error, not a hang (after ${stuckMs}ms)`)
      eq(fatal?.code, '57P03', 'SQLSTATE is 57P03 cannot_connect_now, what real Postgres says while starting up')
      ok(
        /phase=restoring/.test(String(fatal?.message)),
        `the message names the phase it died in (${fatal?.message})`,
      )
      ok(
        /database="stuck"/.test(String(fatal?.message)),
        'the message names the database',
      )
      ok(stuckMs < 6000, `the hold was actually capped (${stuckMs}ms against a 60s restore)`)
      await stuck.end().catch(() => {})

      // ---- 5. The LEASING phase is capped separately ----
      console.log('a contended lease: 57P03 naming phase=leasing, on the tighter cap')
      const contendedRouter = new WireRouter({
        catalog: catalogFrom({
          primer: slowSource({ leaseMs: 5, restoreMs: 5, seed: SEED }),
          contended: slowSource({ leaseMs: 60_000, seed: SEED }),
        }),
        maxWarm: 4,
        flushIntervalMs: 0,
        holdMaxMs: 20_000, // generous total...
        leaseHoldMs: 800, // ...but leasing is capped much tighter
        onLog: (event, fields) => logs.push({ event, fields }),
      })
      await contendedRouter.start()
      try {
        const w = new Client({ connectionString: `postgres://u@127.0.0.1:${contendedRouter.port}/primer` })
        await w.connect()
        await w.end()

        const cl = new Client({
          connectionString: `postgres://u@127.0.0.1:${contendedRouter.port}/contended`,
        })
        const clErrors: PgError[] = []
        cl.on('error', (e) => clErrors.push(e as PgError))
        const tLease = Date.now()
        let connErr: PgError | null = null
        try {
          await cl.connect()
          await cl.query('select 1')
        } catch (e) {
          connErr = e as PgError
        }
        const leaseMs = Date.now() - tLease
        const leaseAll = [...clErrors, connErr].filter(Boolean) as PgError[]
        const leaseFatal = leaseAll.find((e) => e.code)
        ok(leaseFatal !== undefined, 'the client waiting on a contended lease got a Postgres error')
        eq(leaseFatal?.code, '57P03', 'SQLSTATE is 57P03')
        ok(
          /phase=leasing/.test(String(leaseFatal?.message)),
          `the message names LEASING, distinguishing it from a slow restore (${leaseFatal?.message})`,
        )
        // This is what capping the phases separately buys: it failed on the
        // 800ms leasing cap, nowhere near the 20s total.
        ok(
          leaseMs < 5000,
          `it failed on the leasing cap (${leaseMs}ms), not the 20s total ceiling`,
        )
        await cl.end().catch(() => {})
      } finally {
        await contendedRouter.stop()
      }
    } finally {
      await stuckRouter.stop()
    }

    // ---- 6. A restore that FAILS gives an ErrorResponse, not a dropped socket ----
    console.log('a restore that fails outright: the held client gets a protocol error')
    const brokenClient = new Client({ connectionString: url('broken') })
    const brokenErrors: PgError[] = []
    brokenClient.on('error', (e) => brokenErrors.push(e as PgError))
    let brokenErr: PgError | null = null
    try {
      await brokenClient.connect()
      await brokenClient.query('select 1')
    } catch (e) {
      brokenErr = e as PgError
    }
    const brokenAll = [...brokenErrors, brokenErr].filter(Boolean) as PgError[]
    const brokenFatal = brokenAll.find((e) => e.code)
    ok(brokenFatal !== undefined, 'the held client was told the restore failed')
    eq(brokenFatal?.code, '08006', 'SQLSTATE is 08006 connection_failure')
    ok(
      /bucket is on fire/.test(String(brokenFatal?.message)),
      `the underlying cause reaches the client (${brokenFatal?.message})`,
    )
    ok(
      !brokenAll.every((e) => /terminated unexpectedly|closed the connection/.test(e.message)),
      'not merely a dropped socket',
    )
    await brokenClient.end().catch(() => {})

    // ---- 7. Real psql through a cold start ----
    console.log('real libpq through a held cold start')
    await router.evictDatabase('slow', 'test: cold for psql')
    const env = { ...process.env }
    delete env.PGSSLMODE
    const tPsql = Date.now()
    const out = await execFileAsync(
      'psql',
      ['-h', '127.0.0.1', '-p', String(router.port), '-U', 'psqluser', '-d', 'slow', '-At', '-c', 'select count(*)::int from t'],
      { env },
    )
    const psqlMs = Date.now() - tPsql
    ok(psqlMs >= RESTORE_MS, `psql waited out the ${RESTORE_MS}ms cold start (${psqlMs}ms) rather than failing`)
    // 1, not 4: these sources are in-memory PGlite with no object store behind
    // them, so an eviction really does discard the instance and the next open
    // re-runs the seed. Durability across eviction is what wire-eviction.test.ts
    // proves, against real ZeroPG on a real store. What matters here is that
    // psql got a correct answer from a real backend through the hold.
    eq(out.stdout.trim(), '1', 'psql read correct rows through the hold, from the freshly started instance')
    // And no libpq complaint: a held connection must look completely ordinary.
    eq(out.stderr.trim(), '', 'psql printed no warning or error')
  } finally {
    await router.stop()
  }

  console.log(`\n${passed} assertions passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
