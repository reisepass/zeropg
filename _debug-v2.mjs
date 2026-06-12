import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const prefix = `_test/v1dbg2-${Date.now()}`
const store = new GcsBlobStore({ bucket: 'zeropg-experiments-euw1', prefix })
const seed = await ZeroPG.buildEmptySnapshot()
const db = await ZeroPG.open({ store, holder: 'dbg', seedSnapshot: seed })
const p = db
const dataDir = p.dataDir
const walDir = join(dataDir, 'pg_wal')
const list = () => Object.fromEntries(readdirSync(walDir).filter(f => { try { return statSync(join(walDir,f)).isFile() } catch { return false } }).map(f => [f, statSync(join(walDir,f)).size]))
console.log('highWater after open:', JSON.stringify([...p.walHighWater.entries()]))
console.log('pg_wal now:          ', JSON.stringify(list()))
await db.raw.exec('CREATE TABLE t (v text)')
await db.raw.exec("INSERT INTO t VALUES ('x')")
console.log('pg_wal after insert: ', JSON.stringify(list()))
const delta = await p.scanWalDelta()
console.log('scanWalDelta:', JSON.stringify(delta))
await db.close()
process.exit(0)
