// Diagnostic: can LazyFS run initdb + create + query in one process?
import { PGlite } from '@electric-sql/pglite'
import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const work = mkdtempSync(join(tmpdir(), 'lazy-init-'))
const lazy = new LazyFS(join(work, 'pgdata'), { remoteDir: join(work, 'remote'), interceptMatch: () => false })
const pg = new PGlite({ fs: lazy })
await pg.waitReady
await pg.exec(`CREATE TABLE t(id int); INSERT INTO t VALUES (1),(2),(3);`)
console.log('lazy initdb+query:', JSON.stringify((await pg.query('SELECT count(*)::int n FROM t')).rows[0]))
await pg.close()
console.log('OK')
