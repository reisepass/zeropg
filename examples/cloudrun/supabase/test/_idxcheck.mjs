import { serveWire } from '@zeropg/client'
import { execFile as _e } from 'node:child_process'; import { promisify } from 'node:util'
const execFile = promisify(_e)
const WIRE=5730, META=8210, C='pgmeta-idxcheck'
const wire = await serveWire({ host:'0.0.0.0', port:WIRE })
await wire.pglite.exec(`CREATE SCHEMA demo; CREATE TABLE demo.books(id bigserial primary key, title text); CREATE INDEX books_title_idx ON demo.books(title);`)
await execFile('docker',['rm','-f',C]).catch(()=>{})
await execFile('docker',['run','--rm','-d','--name',C,'-p',`${META}:8080`,'-e','PG_META_PORT=8080','-e',`PG_META_DB_URL=postgresql://postgres:postgres@host.docker.internal:${WIRE}/postgres?sslmode=disable`,'supabase/postgres-meta:v0.96.6'])
for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${META}/health`)).ok)break}catch{}; await new Promise(r=>setTimeout(r,400))}
const r = await (await fetch(`http://127.0.0.1:${META}/indexes?included_schemas=demo`)).json()
console.log('count:', Array.isArray(r)?r.length:JSON.stringify(r).slice(0,200))
if(Array.isArray(r)){console.log('keys:', Object.keys(r[0]||{}).join(',')); for(const x of r) console.log('  def=', JSON.stringify(x.index_definition), 'primary=', x.is_primary)}
await execFile('docker',['rm','-f',C]).catch(()=>{}); await wire.stop(); process.exit(0)
