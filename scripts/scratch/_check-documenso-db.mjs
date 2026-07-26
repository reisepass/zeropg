import pg from 'pg'
const c = new pg.Client({ connectionString:'postgres://x:x@127.0.0.1:5462/documenso' })
await c.connect()
const tbls = (await c.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)).rows[0].n
const mig = (await c.query(`select count(*)::int n from _zeropg_migrations`).catch(()=>({rows:[{n:'(no marker table)'}]}))).rows[0].n
console.log('public tables:', tbls, '| _zeropg_migrations rows:', mig)
await c.end()
