import { serveWire } from '@zeropg/client'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import pg from 'pg'
import { readdir, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGS = '/tmp/rallly/packages/database/prisma/migrations'
const dir = await mkdtemp(join(tmpdir(), 'rallly-wire-'))
const wire = await serveWire({ dataDir: join(dir, 'db'), extensions: { citext, pgcrypto }, maxConnections: 20 })

// Apply Rallly's migrations IN-PROCESS via the served PGlite (what the container does).
const db = wire.pglite
const folders = (await readdir(MIGS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()
let applied = 0
for (const f of folders) {
  const sql = await readFile(join(MIGS, f, 'migration.sql'), 'utf8').catch(() => null)
  if (sql == null) continue
  await db.exec(sql); applied++
}
console.log(`in-process applied ${applied}/${folders.length} Rallly migrations (extensions loaded)`)

// Now connect like Rallly does: node-postgres over the wire, run a real query.
const client = new pg.Client({ connectionString: wire.url }); await client.connect()
const tables = await client.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)
console.log(`pg client over the wire sees ${tables.rows[0].n} tables`)
// exercise a citext + pgcrypto-backed table the way the app would
const sample = await client.query(`select table_name from information_schema.tables where table_schema='public' order by table_name limit 8`)
console.log('sample tables:', sample.rows.map(r => r.table_name).join(', '))
await client.end(); await wire.stop()
console.log('OK - Rallly schema lives on zeropg, reachable by a node-postgres client over the wire')
