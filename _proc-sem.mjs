import { serveWire } from '@zeropg/client'
import pg from 'pg'
const wire = await serveWire({})
const ip = wire.pglite
const cl = new pg.Client({ connectionString: wire.url }); await cl.connect()
await ip.exec(`create table t(id int)`)

// Procedure: insert 100, COMMIT, insert 200, then ERROR. Real tx-control => 100 persists, 200 rolls back.
await ip.exec(`create procedure p_partial() language plpgsql as $$
begin
  insert into t values (100);
  commit;
  insert into t values (200);
  raise exception 'boom after commit';
end $$`)

// in-process
try { await ip.exec(`call p_partial()`) } catch (e) { console.log('in-proc CALL raised (expected):', e.message.split('\n')[0]) }
const ipRows = (await ip.query(`select id from t order by id`)).rows.map(r=>r.id)
console.log('in-proc rows after:', JSON.stringify(ipRows), '-> committed-100 kept, 200 rolled back =', JSON.stringify(ipRows)==='[100]')

// over the wire
await cl.query('delete from t')
try { await cl.query(`call p_partial()`) } catch (e) { console.log('over-wire CALL raised (expected):', e.message.split('\n')[0]) }
const wRows = (await cl.query(`select id from t order by id`)).rows.map(r=>r.id)
console.log('over-wire rows after:', JSON.stringify(wRows), '-> tx-control correct =', JSON.stringify(wRows)==='[100]')

// And: COMMIT inside a proc called from an EXPLICIT tx must be rejected (Postgres "atomic context" rule)
await cl.query('delete from t')
let atomicErr = null
try { await cl.query('begin'); await cl.query('call p_partial()'); await cl.query('commit') }
catch (e) { atomicErr = e.message.split('\n')[0]; await cl.query('rollback').catch(()=>{}) }
console.log('COMMIT-in-proc inside explicit BEGIN -> rejected as expected:', atomicErr || '(NOT rejected - divergence)')
await cl.end(); await wire.stop()
