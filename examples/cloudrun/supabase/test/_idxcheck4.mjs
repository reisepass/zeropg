import { serveWire } from '@zeropg/client'
import pg from 'pg'
const wire = await serveWire({ host:'127.0.0.1', port:5736 })
await wire.pglite.exec(`CREATE SCHEMA demo; CREATE TABLE demo.books(id bigserial primary key, title text); CREATE INDEX books_title_idx ON demo.books(title);`)
const c = new pg.Client({host:'127.0.0.1',port:5736,user:'postgres',database:'postgres',ssl:false}); await c.connect()
const q = async (label, sql) => { try { const r = await c.query(sql); console.log(label, '->', JSON.stringify(r.rows)) } catch(e){ console.log(label,'-> ERR', e.message) } }
// index-relation attribute numbering vs table indkey
await q('pg_attribute of books_title_idx (index oid)', `select a.attnum, a.attname from pg_attribute a join pg_class c on a.attrelid=c.oid where c.relname='books_title_idx' and a.attnum>0`)
await q('indkey of each index', `select c.relname, idx.indkey::text from pg_index idx join pg_class c on c.oid=idx.indexrelid join pg_namespace n on c.relnamespace=n.oid where n.nspname='demo'`)
// postgres-meta's exact join (a.attrelid=c.oid AND attnum=ANY(indkey)) vs the correct one (a.attrelid=indrelid)
await q('BUGGY join a.attrelid=indexoid', `select c.relname from pg_index idx join pg_class c on c.oid=idx.indexrelid join pg_namespace n on c.relnamespace=n.oid join pg_attribute a on a.attrelid=c.oid and a.attnum=any(idx.indkey) where n.nspname='demo' group by c.relname`)
await q('CORRECT join a.attrelid=indrelid', `select c.relname from pg_index idx join pg_class c on c.oid=idx.indexrelid join pg_namespace n on c.relnamespace=n.oid join pg_attribute a on a.attrelid=idx.indrelid and a.attnum=any(idx.indkey) where n.nspname='demo' group by c.relname`)
await c.end(); await wire.stop(); process.exit(0)
