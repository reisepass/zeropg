// Diagnostic: can LazyFS (no interception) boot an existing datadir and query?
import { PGlite } from '@electric-sql/pglite'
import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const work = mkdtempSync(join(tmpdir(), 'lazy-boot-'))
const dataDir = join(work, 'pgdata')

console.log('1) build datadir with normal PGlite')
{
  const pg = new PGlite({ dataDir })
  await pg.waitReady
  await pg.exec(`CREATE TABLE t(id int); INSERT INTO t VALUES (1),(2),(3); CHECKPOINT;`)
  console.log('   golden:', JSON.stringify((await pg.query('SELECT count(*)::int n FROM t')).rows[0]))
  await pg.close()
}

console.log('2) reopen SAME datadir with LazyFS (no interception)')
const lazy = new LazyFS(dataDir, { remoteDir: join(work, 'remote'), interceptMatch: () => false, debug: false })
const pg = new PGlite({ fs: lazy })
await pg.waitReady
console.log('   lazy:', JSON.stringify((await pg.query('SELECT count(*)::int n FROM t')).rows[0]))
await pg.close()
console.log('OK: LazyFS booted an existing datadir and queried it.')
