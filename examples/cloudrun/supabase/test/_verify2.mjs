import { serveWire } from '@zeropg/client'
import pg from 'pg'
const wire = await serveWire({ host:'127.0.0.1', port:5742 })
await wire.pglite.exec(`CREATE TABLE hb (id serial primary key);`)
const cl = () => new pg.Client({host:'127.0.0.1',port:5742,user:'postgres',database:'postgres',ssl:false})

async function measure(label, longSql, probeSql) {
  const a = cl(), b = cl(); await a.connect(); await b.connect()
  const t0 = Date.now()
  const long = a.query(longSql).then(()=>({done: Date.now()-t0}))
  const lat = []
  // fire 8 probes at 250ms cadence during the long query
  for (let i=0;i<8;i++){
    await new Promise(r=>setTimeout(r,250))
    const s=Date.now(); try{ await b.query(probeSql); lat.push(Date.now()-s) }catch(e){ lat.push('ERR') }
  }
  const l = await long
  console.log(`  [${label}] long=${l.done}ms  probe latencies(ms)=[${lat.join(',')}]`)
  await a.end(); await b.end()
}
console.log('probe = SELECT (read):')
await measure('pg_sleep(3) / read', 'select pg_sleep(3)', 'select 1')
await measure('genseries20M / read', 'select count(*) from generate_series(1,20000000)', 'select 1')
console.log('probe = INSERT (write):')
await measure('pg_sleep(3) / write', 'select pg_sleep(3)', 'insert into hb default values')
await measure('genseries20M / write', 'select count(*) from generate_series(1,20000000)', 'insert into hb default values')
await wire.stop(); process.exit(0)
