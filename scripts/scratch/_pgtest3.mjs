import pg from 'pg'
const port = Number(process.env.TP || 5610)
const c = new pg.Client({ host:'127.0.0.1', port, user:'postgres', password:'postgres', database:'postgres', ssl:false })
try {
  await c.connect()
  const r = await c.query('select 1 as x')
  console.log('OK rows:', JSON.stringify(r.rows))
  await c.end()
} catch (e) { console.log('ERR:', e.message, e.code) }
