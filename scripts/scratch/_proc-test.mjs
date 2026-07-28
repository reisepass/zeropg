import { serveWire } from '@zeropg/client'
import pg from 'pg'

const wire = await serveWire({})               // fresh in-memory PGlite + wire
const ip = wire.pglite                          // in-process handle
const cl = new pg.Client({ connectionString: wire.url }); await cl.connect()  // over-the-wire

const out = []
const T = async (label, fn) => { try { await fn(); out.push(['ok  ', label]) } catch (e) { out.push(['FAIL', label + ' -> ' + String(e.message).split('\n')[0]]) } }

await ip.exec(`create table t(id int)`)

// 1. basic CREATE PROCEDURE + CALL (no tx control)
await T('in-proc: CREATE PROCEDURE + CALL (no tx control)', async () => {
  await ip.exec(`create procedure p_simple() language plpgsql as $$ begin insert into t values (1); end $$`)
  await ip.exec(`call p_simple()`)
  const n = (await ip.query(`select count(*)::int n from t where id=1`)).rows[0].n
  if (n !== 1) throw new Error('row not inserted')
})
await T('over-wire: CALL p_simple()', async () => {
  await cl.query(`call p_simple()`)            // inserts another row id=1
})

// 2. procedure WITH transaction control (COMMIT inside) - the risky one
await T('in-proc: CREATE PROCEDURE with COMMIT inside', async () => {
  await ip.exec(`create procedure p_commit() language plpgsql as $$ begin insert into t values (2); commit; insert into t values (3); end $$`)
})
await T('in-proc: CALL proc-with-COMMIT', async () => { await ip.exec(`call p_commit()`) })
await T('over-wire: CALL proc-with-COMMIT (pglite-socket implicit tx?)', async () => { await cl.query(`call p_commit()`) })

// 3. procedure with INOUT params
await T('in-proc: CREATE PROCEDURE with INOUT param + CALL', async () => {
  await ip.exec(`create procedure p_io(inout x int) language plpgsql as $$ begin x := x * 10; end $$`)
  const r = await ip.query(`call p_io(5)`)
  if (JSON.stringify(r.rows[0]) !== JSON.stringify({x:50})) throw new Error('got '+JSON.stringify(r.rows[0]))
})
await T('over-wire: CALL p_io(7)', async () => {
  const r = await cl.query(`call p_io($1)`, [7])
  if (r.rows[0].x !== 70) throw new Error('got '+JSON.stringify(r.rows[0]))
})

// 4. ROLLBACK inside a procedure
await T('in-proc: procedure with ROLLBACK inside', async () => {
  await ip.exec(`create procedure p_rb() language plpgsql as $$ begin insert into t values (99); rollback; end $$`)
  await ip.exec(`call p_rb()`)
})

for (const [s,m] of out) console.log(s, m)
await cl.end(); await wire.stop()
