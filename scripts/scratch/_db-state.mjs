import pg from 'pg'
for (const [name, port, db] of [['cal.com',5461,'calcom'],['nocodb',5463,'nocodb']]) {
  try {
    const c = new pg.Client({ connectionString:`postgres://x:x@127.0.0.1:${port}/${db}`, connectionTimeoutMillis: 4000 })
    await c.connect()
    const tbls = (await c.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)).rows[0].n
    const mig = (await c.query(`select count(*)::int n from _zeropg_migrations`).catch(()=>({rows:[{n:'(none - app self-migrates)'}]}))).rows[0].n
    const sample = (await c.query(`select table_name from information_schema.tables where table_schema='public' order by 1 limit 6`)).rows.map(r=>r.table_name)
    console.log(`${name} (:${port}): ${tbls} tables | migrations marker: ${mig} | sample: ${sample.join(', ')}`)
    await c.end()
  } catch (e) { console.log(`${name} (:${port}): ERROR ${e.message}`) }
}
