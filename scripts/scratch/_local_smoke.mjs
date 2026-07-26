import { resolveDatabaseUrl } from '@zeropg/client'
import pg from 'pg'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(),'zpg-local-'))
const dataDir = join(dir,'pgdata')

const a = await resolveDatabaseUrl(`file:${dataDir}`)
console.log('leader:', a.leader, a.url)
const ca = new pg.Client({ connectionString: a.url }); await ca.connect()
await ca.query('create table t(id serial primary key, v text)')
await ca.query("insert into t(v) values('from leader')")

const b = await resolveDatabaseUrl(`file:${dataDir}`)
console.log('follower:', b.leader, b.url, '| sameUrl:', a.url === b.url)
const cb = new pg.Client({ connectionString: b.url }); await cb.connect()
const r = await cb.query('select v from t')
console.log('follower sees:', r.rows)

const p = await resolveDatabaseUrl('postgres://example/db')
console.log('passthrough:', p.url, '| leader:', p.leader)

await ca.end(); await cb.end()
await b.close(); await a.close()
console.log('OK')
