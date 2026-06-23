import pg from 'pg'
const URL = 'postgres://postgres:postgres@127.0.0.1:5463/postgres'
const out = (k, v) => console.log(`${k}: ${v}`)

// 1) version / server identity NocoDB's knex sees
{ const c = new pg.Client({ connectionString: URL }); await c.connect()
  out('server_version', (await c.query('show server_version')).rows[0].server_version)
  const ext = (await c.query("select extname from pg_extension order by 1")).rows.map(r=>r.extname)
  out('installed_extensions', JSON.stringify(ext))
  // does NocoDB's knex migration lock table exist & how is it implemented?
  const kl = (await c.query("select * from xc_knex_migrationsv0_lock")).rows
  out('knex_migration_lock_rows', JSON.stringify(kl))
  await c.end() }

// 2) CONCURRENCY: open TWO pooled clients, run overlapping queries. Single-session
// PGlite must serialize; verify it does not error/deadlock under a real pool.
{ const pool = new pg.Pool({ connectionString: URL, max: 10 })
  const t0 = Date.now()
  const tasks = Array.from({length: 20}, (_,i) =>
    pool.query('select pg_sleep(0.05), $1::int as n', [i]).then(r => r.rows[0].n))
  const res = await Promise.all(tasks)
  out('concurrent_20_queries_ok', res.length === 20)
  out('concurrent_wall_ms', Date.now()-t0)  // ~serialized => ~1000ms; parallel => ~50ms
  await pool.end() }

// 3) TRANSACTIONS: BEGIN/COMMIT, ROLLBACK, savepoints, isolation level
{ const c = new pg.Client({ connectionString: URL }); await c.connect()
  try {
    await c.query('begin isolation level serializable')
    await c.query('create temp table _t(x int)')
    await c.query('insert into _t values (1)')
    await c.query('savepoint sp1')
    await c.query('insert into _t values (2)')
    await c.query('rollback to savepoint sp1')
    const n = (await c.query('select count(*)::int n from _t')).rows[0].n
    await c.query('commit')
    out('tx_savepoint_rollback_ok', n === 1)
  } catch(e) { out('tx_FAILED', e.message) }
  await c.end() }

// 4) Per-base schema DDL like NocoDB issues (CREATE SCHEMA + serial + FK across schema)
{ const c = new pg.Client({ connectionString: URL }); await c.connect()
  try {
    await c.query('create schema if not exists _probe_base')
    await c.query('create table _probe_base.t (id serial primary key, name text)')
    await c.query("insert into _probe_base.t(name) values ('x')")
    const id = (await c.query('select id from _probe_base.t')).rows[0].id
    out('per_base_schema_serial_ok', id === 1)
    await c.query('drop schema _probe_base cascade')
  } catch(e) { out('schema_DDL_FAILED', e.message) }
  await c.end() }

// 5) Things PG has that PGlite historically lacks: advisory locks (knex uses for migrate)
{ const c = new pg.Client({ connectionString: URL }); await c.connect()
  try { const r = (await c.query('select pg_try_advisory_lock(42) as l')).rows[0].l
    await c.query('select pg_advisory_unlock(42)')
    out('advisory_lock_ok', r) }
  catch(e){ out('advisory_lock_FAILED', e.message) }
  // LISTEN/NOTIFY (NocoDB realtime / some knex paths)
  try { await c.query("listen probe_ch"); await c.query("notify probe_ch, 'hi'"); out('listen_notify_ok', true) }
  catch(e){ out('listen_notify_FAILED', e.message) }
  await c.end() }
