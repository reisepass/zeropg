import { serveWire } from '@zeropg/client'
import pg from 'pg'
const wire = await serveWire({ host:'127.0.0.1', port:5734 })
await wire.pglite.exec(`CREATE SCHEMA demo; CREATE TABLE demo.books(id bigserial primary key, title text); CREATE INDEX books_title_idx ON demo.books(title);`)
const c = new pg.Client({host:'127.0.0.1',port:5734,user:'postgres',database:'postgres',ssl:false}); await c.connect()
const q = async (label, sql) => { try { const r = await c.query(sql); console.log(label, '->', r.rows.length, 'rows:', JSON.stringify(r.rows.map(x=>x.name||x.relname||x.id))) } catch(e){ console.log(label,'-> ERR', e.message) } }
// full postgres-meta query (no group by / group by) minimal
await q('joins-only (no group/agg)', `
  SELECT c.relname AS name FROM pg_index idx
  JOIN pg_class c ON c.oid = idx.indexrelid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  JOIN pg_am am ON c.relam = am.oid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(idx.indkey)
  JOIN pg_indexes ix ON c.relname = ix.indexname
  WHERE n.nspname = 'demo'`)
await q('with jsonb_agg + group by', `
  SELECT c.relname AS name, jsonb_agg(a.attname) AS attrs FROM pg_index idx
  JOIN pg_class c ON c.oid = idx.indexrelid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  JOIN pg_am am ON c.relam = am.oid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(idx.indkey)
  JOIN pg_indexes ix ON c.relname = ix.indexname
  WHERE n.nspname = 'demo'
  GROUP BY c.relname, idx.indkey, idx.indclass, idx.indcollation, idx.indoption`)
await q('group by WITHOUT vector cols', `
  SELECT c.relname AS name, jsonb_agg(a.attname) AS attrs FROM pg_index idx
  JOIN pg_class c ON c.oid = idx.indexrelid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  JOIN pg_am am ON c.relam = am.oid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(idx.indkey)
  JOIN pg_indexes ix ON c.relname = ix.indexname
  WHERE n.nspname = 'demo'
  GROUP BY c.relname`)
await c.end(); await wire.stop(); process.exit(0)
