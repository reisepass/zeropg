import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readdir, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGS = '/tmp/rallly/packages/database/prisma/migrations'
const dir = await mkdtemp(join(tmpdir(), 'rallly-ext-'))
const db = await PGlite.create({ dataDir: join(dir, 'db'), extensions: { citext, pgcrypto } })

const folders = (await readdir(MIGS, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort()
let applied = 0
const failures = []
for (const f of folders) {
  const sql = await readFile(join(MIGS, f, 'migration.sql'), 'utf8').catch(() => null)
  if (sql == null) continue
  try { await db.exec(sql); applied++ }
  catch (e) { failures.push({ f, msg: String(e.message).split('\n')[0] }) }
}
const t = await db.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)
console.log(`\napplied ${applied}/${folders.length} | failed ${failures.length} | ${t.rows[0].n} public tables`)
for (const x of failures.slice(0, 15)) console.log(`  FAIL ${x.f}: ${x.msg}`)
await db.close()
