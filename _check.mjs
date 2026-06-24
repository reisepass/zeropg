import pg from 'pg'
const c = new pg.Client({ host:'127.0.0.1', port:5610, user:'postgres', password:'postgres', database:'postgres' })
await c.connect()
const r = await c.query("SELECT count(*)::int AS ttlbin FROM captures WHERE bin_id='ttlbin'")
const m = await c.query("SELECT last_run FROM maintenance_state WHERE key='ttl'")
console.log('ttlbin rows after sweep:', r.rows[0].ttlbin, '(expect 0)')
console.log('last_run advanced to:', m.rows[0].last_run)
await c.end()
