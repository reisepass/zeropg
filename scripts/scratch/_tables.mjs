import pg from 'pg'
const c = new pg.Client({ host:'127.0.0.1', port:5610, user:'postgres', password:'postgres', database:'postgres', ssl:false })
await c.connect()
const r = await c.query("select tablename from pg_tables where schemaname='public' order by tablename")
console.log('tables:', r.rows.map(x=>x.tablename).join(', '))
await c.end()
