import { serveWire } from '@zeropg/client'
import pg from 'pg'
const wire = await serveWire({ host:'127.0.0.1', port:5732 })
await wire.pglite.exec(`CREATE SCHEMA demo; CREATE TABLE demo.books(id bigserial primary key, title text); CREATE INDEX books_title_idx ON demo.books(title);`)
const c = new pg.Client({host:'127.0.0.1',port:5732,user:'postgres',database:'postgres',ssl:false}); await c.connect()
console.log('pg_indexes:', JSON.stringify((await c.query(`select indexname, indexdef from pg_indexes where schemaname='demo' order by indexname`)).rows))
console.log('pg_class idx count:', (await c.query(`select count(*)::int n from pg_class where relkind='i' and relnamespace='demo'::regnamespace`)).rows[0].n)
console.log('pg_am names:', JSON.stringify((await c.query(`select amname from pg_am order by amname`)).rows.map(r=>r.amname)))
// does the join that postgres-meta uses drop it? test amname join
console.log('idx+am join:', JSON.stringify((await c.query(`select c.relname, am.amname from pg_class c join pg_am am on c.relam=am.oid where c.relkind='i' and c.relnamespace='demo'::regnamespace`)).rows))
await c.end(); await wire.stop(); process.exit(0)
