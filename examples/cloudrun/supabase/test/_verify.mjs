import { serveWire } from '@zeropg/client'
import pg from 'pg'
const wire = await serveWire({ host:'127.0.0.1', port:5740 })
await wire.pglite.exec(`CREATE TABLE hb (id serial primary key, ts timestamptz, note text); CREATE TABLE mark (label text, ts timestamptz);`)
const cl = () => new pg.Client({host:'127.0.0.1',port:5740,user:'postgres',database:'postgres',ssl:false})

// === PROOF: is the long query genuinely mid-flight while B commits writes? ===
{
  const a = cl(), b = cl(); await a.connect(); await b.connect()
  // A: single-statement long query that records start (via CTE side-effect is hard); instead record around it on a 3rd conn
  const c = cl(); await c.connect()
  await c.query(`insert into mark values ('A_start', clock_timestamp())`)
  const longP = a.query(`select count(*) from generate_series(1,20000000)`).then(async()=>{
    await c.query(`insert into mark values ('A_end', clock_timestamp())`)
  })
  await new Promise(r=>setTimeout(r,400))
  // B commits heartbeat writes repeatedly while A's single statement is (claimed) running
  for (let i=0;i<5;i++){ await b.query(`insert into hb (ts,note) values (clock_timestamp(),$1)`,[`beat${i}`]); await new Promise(r=>setTimeout(r,150)) }
  await longP
  // Now: did B's heartbeat commits land BETWEEN A_start and A_end?
  const r = await c.query(`
    with w as (select max(case when label='A_start' then ts end) s, max(case when label='A_end' then ts end) e from mark)
    select (count(*) filter (where hb.ts > w.s and hb.ts < w.e))::int as during, count(*)::int as total, w.s, w.e from hb, w group by w.s, w.e`)
  console.log('heartbeats during A long-statement window:', JSON.stringify(r.rows[0]))
  await a.end(); await b.end(); await c.end()
}

// === RESET semantics: does RESET ALL clear SET ROLE / SET search_path? ===
{
  const c = cl(); await c.connect()
  await c.query(`create role r1 nologin`)
  await c.query(`grant r1 to postgres`).catch(()=>{})
  const show = async l => { try { const r = await c.query(`select current_setting('search_path') sp, current_user cu, session_user su`); console.log(l, JSON.stringify(r.rows[0])) } catch(e){ console.log(l,'ERR',e.message) } }
  await c.query(`set search_path to pg_catalog`); await c.query(`set role r1`).catch(e=>console.log('set role err', e.message))
  await show('after SET search_path+ROLE')
  await c.query(`reset all`)
  await show('after RESET ALL')
  await c.query(`set role r1`).catch(()=>{})
  await c.query(`reset role`).catch(e=>console.log('reset role err',e.message))
  await show('after RESET ROLE')
  await c.end()
}
await wire.stop(); process.exit(0)
