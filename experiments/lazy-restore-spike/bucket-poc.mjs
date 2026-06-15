// Bucket POC: prove the REAL fault path. Boot PGlite on a datadir whose user
// relation segments are ZEROED locally; their true bytes live only in a GCS (or
// R2) bucket; every query faults the missing 1MB groups through the Atomics+SAB
// bridge from the bucket and must return byte-identical results vs full restore.
//
// This is intercept-poc.mjs upgraded from a local "remote" dir to a real object
// store via LazyBucketFS + BucketBridge + bucket-bridge-worker.
//
// Run (GCS, same-region euw1):
//   node_modules/.bin/tsx experiments/lazy-restore-spike/bucket-poc.mjs gcs
//   PROVIDER=r2 node_modules/.bin/tsx experiments/lazy-restore-spike/bucket-poc.mjs r2

import { PGlite } from '@electric-sql/pglite'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'
import { LazyBucketFS, BucketBridge } from './lazy-bucket-fs.mjs'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import {
  mkdtempSync, openSync, writeSync, closeSync, statSync, readFileSync, existsSync,
} from 'node:fs'

const BLCKSZ = 8192
const provider = process.argv[2] || process.env.PROVIDER || 'gcs'
const RUN_ID = process.env.RUN_ID || `poc-${process.pid}`
const PREFIX = `lazy-poc/${RUN_ID}`

function makeStore(prefix) {
  if (provider === 'gcs') return new GcsBlobStore({ bucket: 'zeropg-experiments-euw1', prefix })
  if (provider === 'r2') {
    const s = R2BlobStore.fromEnv(prefix)
    if (!s) throw new Error('R2 creds missing (source ~/.zeropg-r2.env)')
    return s
  }
  throw new Error(`unknown provider ${provider}`)
}

async function snapshotUserRelations(pg) {
  const rows = (await pg.query(`
    SELECT c.relname, c.relkind, pg_relation_filepath(c.oid) AS path, pg_relation_size(c.oid)::bigint AS sz
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','i')
  `)).rows
  return rows.filter((r) => r.path).map((r) => ({ relname: r.relname, relkind: r.relkind, path: r.path, sz: Number(r.sz) }))
}
function segmentsOf(dataDir, relPath) {
  const segs = []
  for (let i = 0; ; i++) {
    const rel = i === 0 ? relPath : `${relPath}.${i}`
    if (!existsSync(join(dataDir, rel))) break
    segs.push(rel)
  }
  return segs
}

const work = mkdtempSync(join(process.env.TMPDIR || '/dev/shm', 'bucket-poc-'))
const dataDir = mkdtempSync(join(work, 'dd-'))
const store = makeStore(PREFIX)

console.log(`== bucket POC (provider=${provider}, prefix=${PREFIX}) ==`)

// ---- Phase 1: build a real table, capture golden answers -------------------
let userRels, allSegs
{
  const pg = new PGlite({ dataDir })
  await pg.waitReady
  await pg.exec(`
    CREATE TABLE t (id int primary key, v int, label text);
    INSERT INTO t SELECT g, (g*7)%1000, 'widget-'||g FROM generate_series(1,50000) g;
    CREATE INDEX idx_t_v ON t(v);
    CHECKPOINT;
  `)
  userRels = await snapshotUserRelations(pg)
  const golden = {
    agg: (await pg.query(`SELECT count(*)::int n, sum(v)::bigint s, min(label) mn, max(label) mx FROM t`)).rows[0],
    point: (await pg.query(`SELECT id,v,label FROM t WHERE id = 41234`)).rows[0],
    range: (await pg.query(`SELECT count(*)::int n, sum(v)::bigint s FROM t WHERE id BETWEEN 20000 AND 20100`)).rows[0],
    full: (await pg.query(`SELECT md5(string_agg(id::text||':'||v::text||':'||label, ',' ORDER BY id)) h FROM t`)).rows[0],
  }
  global.__golden = golden
  await pg.close()
  allSegs = []
  for (const r of userRels) for (const s of segmentsOf(dataDir, r.path)) allSegs.push(s)
  console.log(`  built ${userRels.length} user relations, ${allSegs.length} segments`)
  console.log(`  golden point:`, JSON.stringify(golden.point))
}

// ---- Phase 2: upload true relation bytes to the bucket, pin generations -----
const relKeys = []
const relVersions = []
const keyIdByPath = new Map()
for (const rel of allSegs) {
  const bytes = readFileSync(join(dataDir, rel))
  const key = `seg/${rel}`
  const put = await store.put(key, bytes)
  const keyId = relKeys.length
  relKeys.push(key)
  relVersions.push(put.etag) // GCS generation / R2 etag - pins the fault to this version
  keyIdByPath.set(rel, keyId)
}
console.log(`  uploaded ${relKeys.length} segments to ${provider}, versions pinned`)

// Zero the local datadir copies so only a working bucket fault path returns data.
const segSet = new Set(allSegs)
for (const rel of allSegs) {
  const p = join(dataDir, rel)
  const sz = statSync(p).size
  const fd = openSync(p, 'r+'); writeSync(fd, Buffer.alloc(sz), 0, sz, 0); closeSync(fd)
}
console.log(`  zeroed ${allSegs.length} local segments (datadir now sparse)`)

// ---- Phase 3: boot LazyBucketFS, fault every query from the bucket ----------
const bridge = new BucketBridge({
  provider,
  gcs: provider === 'gcs' ? { bucket: 'zeropg-experiments-euw1', prefix: PREFIX } : undefined,
  r2: provider === 'r2' ? r2OptsFor(PREFIX) : undefined,
  relKeys,
  relVersions,
  prefetchStore: makeStore(PREFIX),
})
const keyIdForPath = (relPath) => (segSet.has(relPath) ? keyIdByPath.get(relPath) : undefined)
const lazy = new LazyBucketFS(dataDir, { bridge, keyIdForPath })

const golden = global.__golden
const results = {}
{
  const pg = new PGlite({ fs: lazy })
  await pg.waitReady
  const t0 = performance.now()
  const point = (await pg.query(`SELECT id,v,label FROM t WHERE id = 41234`)).rows[0]
  const ttfqPoint = performance.now() - t0
  const agg = (await pg.query(`SELECT count(*)::int n, sum(v)::bigint s, min(label) mn, max(label) mx FROM t`)).rows[0]
  const range = (await pg.query(`SELECT count(*)::int n, sum(v)::bigint s FROM t WHERE id BETWEEN 20000 AND 20100`)).rows[0]
  const full = (await pg.query(`SELECT md5(string_agg(id::text||':'||v::text||':'||label, ',' ORDER BY id)) h FROM t`)).rows[0]
  await pg.close()
  results.point = { match: JSON.stringify(point) === JSON.stringify(golden.point), ttfqMs: +ttfqPoint.toFixed(1) }
  results.agg = { match: JSON.stringify(agg) === JSON.stringify(golden.agg) }
  results.range = { match: JSON.stringify(range) === JSON.stringify(golden.range) }
  results.full = { match: full.h === golden.full.h }
}

const s = bridge.stats()
await bridge.close()

console.log(`\n== Results (provider=${provider}) ==`)
console.log(`  point  match=${results.point.match}  TTFQ(point-first)=${results.point.ttfqMs}ms`)
console.log(`  agg    match=${results.agg.match}`)
console.log(`  range  match=${results.range.match}`)
console.log(`  full   hashMatch=${results.full.match}`)
console.log(`  bridge: syncFaults=${s.syncFaults} prefetch=${s.prefetchFaults} cacheHits=${s.cacheHits} bytesPulled=${(s.bytesPulled/1e6).toFixed(2)}MB`)
console.log(`  per-fault range-GET latency: p50=${(s.latP50Us/1000).toFixed(1)}ms p99=${(s.latP99Us/1000).toFixed(1)}ms cold=${s.coldGetUs?(s.coldGetUs/1000).toFixed(1):'n/a'}ms warmMean=${s.warmGetMeanUs?(s.warmGetMeanUs/1000).toFixed(1):'n/a'}ms`)

const allMatch = results.point.match && results.agg.match && results.range.match && results.full.match
console.log(`\n${allMatch ? 'POC PASSED' : 'POC FAILED'}: real ${provider} bucket fault path ${allMatch ? 'returns byte-identical results' : 'MISMATCH'}.`)
process.exit(allMatch ? 0 : 1)

function r2OptsFor(prefix) {
  const e = process.env
  return {
    accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    bucket: e.R2_BUCKET, endpoint: e.R2_ENDPOINT, accountId: e.R2_ACCOUNT_ID,
    region: e.R2_REGION || 'auto', prefix,
  }
}
