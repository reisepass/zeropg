import pg from 'pg'
const c = new pg.Client({ host:'127.0.0.1', port:5610, user:'postgres', password:'postgres', database:'postgres' })
await c.connect()
const before = await c.query("SELECT count(*)::int FROM captures WHERE bin_id='ttlbin'")
await c.query("INSERT INTO captures(bin_id,method,path,headers,ts) VALUES ('ttlbin','GET','/','{}'::jsonb, now() - interval '48 hours')")
const mid = await c.query("SELECT count(*)::int FROM captures WHERE bin_id='ttlbin'")
// open the sweep window
await c.query("UPDATE maintenance_state SET last_run = now() - interval '1 hour' WHERE key='ttl'")
const ms = await c.query("SELECT key,last_run FROM maintenance_state")
console.log('maintenance_state:', JSON.stringify(ms.rows))
console.log('ttlbin before insert:', before.rows[0].count, ' after backdated insert:', mid.rows[0].count)
await c.end()
