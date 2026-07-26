import pg from 'pg'
const c = new pg.Client({ host:'127.0.0.1', port:5602, user:'postgres', password:'postgres', database:'postgres', ssl:false })
c.on('error', e => console.log('client error event:', e.message))
try {
  await c.connect()
  const r = await c.query('select 1 as x')
  console.log('OK rows:', JSON.stringify(r.rows))
  await c.end()
} catch (e) {
  console.log('connect/query error:', e.message, e.code)
}
