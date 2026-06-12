import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'
const prefix = `_test/v1dbg-${Date.now()}`
const store = new GcsBlobStore({ bucket: 'zeropg-experiments-euw1', prefix })
const seed = await ZeroPG.buildEmptySnapshot()
const db = await ZeroPG.open({ store, holder: 'dbg', seedSnapshot: seed })
const gucs = await db.raw.query("SELECT name, setting, source FROM pg_settings WHERE name IN ('wal_init_zero','wal_recycle','synchronous_commit','max_wal_size')")
console.log('gucs:', JSON.stringify(gucs.rows))
console.log('manifest version:', db.currentManifest.version)
try {
  const sw = await db.raw.query('SELECT pg_switch_wal()')
  console.log('pg_switch_wal:', JSON.stringify(sw.rows))
} catch (e) { console.log('pg_switch_wal FAILED:', e.message) }
await db.exec('CREATE TABLE t (v text)')
const r = await db.query("INSERT INTO t VALUES ('x')")
console.log('commit mode:', r.commit?.mode, 'segments:', r.commit?.segments, 'bytes:', r.commit?.snapshotBytes)
await db.close()
process.exit(0)
