import { serveWire } from '@zeropg/client'
import pg from 'pg'
import { readdir, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGS = '/tmp/rallly/packages/database/prisma/migrations'
const dir = await mkdtemp(join(tmpdir(), 'rallly-mig-'))
const wire = await serveWire({ dataDir: join(dir, 'db') })
const client = new pg.Client({ connectionString: wire.url })
await client.connect()

const folders = (await readdir(MIGS, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort()

let applied = 0
const failures = []
for (const f of folders) {
  let sql
  try { sql = await readFile(join(MIGS, f, 'migration.sql'), 'utf8') } catch { continue }
  try { await client.query(sql); applied++ }
  catch (e) {
    failures.push({ f, code: e.code, msg: String(e.message).split('\n')[0] })
    await client.query('ROLLBACK').catch(() => {}) // clear aborted-tx state
  }
}
const t = await client.query(`select count(*)::int n from information_schema.tables where table_schema='public'`)
console.log(`\napplied ${applied}/${folders.length} | failed ${failures.length} | ${t.rows[0].n} public tables\n`)
for (const x of failures.slice(0, 15)) console.log(`FAIL ${x.f}  [${x.code}]\n   ${x.msg}`)
await client.end(); await wire.stop()
