import pg from 'pg'
const cal = new pg.Client({ connectionString:'postgres://x:x@127.0.0.1:5461/calendso' }); await cal.connect()
const r = await cal.query('select id,username,email,created from users order by id')
console.log('all users in cal zeropg:')
for (const u of r.rows) console.log(`  id=${u.id} user=${u.username} email=${u.email} created=${u.created?.toISOString?.()||u.created}`)
await cal.end()
