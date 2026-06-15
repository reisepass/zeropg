// Measure EAGER full-restore vs LAZY page-fault TTFQ on the VM, from a real
// bucket, for a staged tier. Produces the MEASURED table (the deliverable).
//
// For each (size, shape) and >= RUNS runs:
//   EAGER: getStream(snapshot.tar) -> extract into a boot-disk workdir ->
//          open PGlite -> run the first query. TTFQ = whole wall clock.
//   LAZY:  getStream(eager.tar) -> extract -> lay down sparse zeroed placeholders
//          for every user-relation segment -> open PGlite with LazyBucketFS ->
//          (optional query-plan frontrunning prefetch) -> run the first query,
//          which faults the segment 1MB-groups it touches through the SAB bridge
//          from the per-segment bucket objects. Records TTFQ, bytes pulled,
//          fault count, and REAL per-fault range-GET latency (cold vs warm).
//
// IMPORTANT: use WORKDIR on the BOOT DISK (never /dev/shm - that eats RAM).
// Peak disk use is one 530MB datadir at a time (truncated after each trial).
//
// Run:
//   node_modules/.bin/tsx experiments/lazy-restore-spike/measure.mjs 500 gcs 5
//   node_modules/.bin/tsx experiments/lazy-restore-spike/measure.mjs 1024 gcs 5

import { PGlite } from '@electric-sql/pglite'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'
import { extractTarStream } from '../../packages/objectstore-fs/src/tar.ts'
import { LazyBucketFS, BucketBridge } from './lazy-bucket-fs.mjs'
import { Readable } from 'node:stream'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import {
  mkdtempSync, mkdirSync, openSync, writeSync, closeSync, ftruncateSync,
  appendFileSync, writeFileSync, existsSync,
} from 'node:fs'

// Boot disk workdir - never /dev/shm (tmpfs eats RAM on a 7.8GB VM).
const WORKDIR = process.env.WORKDIR || `${process.env.HOME}/lazy-work`
const sizeMB = Number(process.argv[2] || 500)
const provider = process.argv[3] || 'gcs'
const RUNS = Number(process.argv[4] || 5)
const BUCKET = 'zeropg-experiments-euw1'
const PREFIX = `lazy-measure/${sizeMB}mb`
const HERE = dirname(new URL(import.meta.url).pathname)
const OUT = join(HERE, 'measured.jsonl')

// Empty dirs Postgres requires at startup but eager.tar (files-only) omits.
// Used only for tiers built before tier.eagerEmptyDirs was recorded.
const EAGER_EMPTY_DIRS_FALLBACK = [
  'base/pgsql_tmp', 'pg_commit_ts', 'pg_dynshmem', 'pg_logical/mappings',
  'pg_logical/snapshots', 'pg_notify', 'pg_replslot', 'pg_serial',
  'pg_snapshots', 'pg_stat', 'pg_stat_tmp', 'pg_tblspc', 'pg_twophase',
  'pg_wal/archive_status', 'pg_wal/summaries',
]

function makeStore(prefix) {
  if (provider === 'gcs') return new GcsBlobStore({ bucket: BUCKET, prefix })
  if (provider === 'r2') {
    const s = R2BlobStore.fromEnv(prefix)
    if (!s) throw new Error('R2 creds missing (source ~/.zeropg-r2.env)')
    return s
  }
  throw new Error(`unknown provider ${provider}`)
}
function r2OptsFor(prefix) {
  const e = process.env
  return {
    accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    bucket: e.R2_BUCKET, endpoint: e.R2_ENDPOINT, accountId: e.R2_ACCOUNT_ID,
    region: e.R2_REGION || 'auto', prefix,
  }
}
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const r1 = (x) => +x.toFixed(1)

// SQL for the three deliverable shapes, from tier.shapeParams.
function shapeSql({ lineItems, users }) {
  return {
    pointLookup: `SELECT id,order_id,sku,qty,price FROM line_items WHERE id = ${Math.floor(lineItems / 2)}`,
    indexedRange: `SELECT count(*)::int n, sum(price)::bigint s FROM line_items WHERE id BETWEEN ${Math.floor(lineItems * 0.475)} AND ${Math.floor(lineItems * 0.525)}`,
    fullScan: `SELECT count(*)::int n FROM line_items WHERE price = 0`,
  }
}
// Which relations a shape's query-plan frontrunning would prefetch (by relname).
const SHAPE_PREFETCH = {
  pointLookup: ['line_items', 'line_items_pkey'],
  indexedRange: ['line_items', 'line_items_pkey'],
  fullScan: ['line_items'],
}

async function streamFromStore(store, key, gen) {
  const src = await store.getStream(key)
  if (!src) throw new Error(`missing ${key}`)
  return src
}

async function loadTier() {
  const store = makeStore(PREFIX)
  const obj = await store.get('tier.json')
  if (!obj) throw new Error(`no tier.json at ${PREFIX} - build the tier first`)
  return JSON.parse(Buffer.from(obj.bytes).toString('utf8'))
}

// ---- EAGER: full restore -> open -> first query ----------------------------
async function runEager(tier, shapeName, sql) {
  const store = makeStore(PREFIX)
  mkdirSync(WORKDIR, { recursive: true })
  const dataDir = mkdtempSync(join(WORKDIR, `eager-${sizeMB}-`))
  const t0 = performance.now()
  const src = await store.getStream(tier.snapshotKey)
  if (!src) throw new Error('no snapshot.tar')
  const ex = await extractTarStream(Readable.from(src.stream), dataDir)
  const tRestored = performance.now()
  const pg = new PGlite({ dataDir })
  await pg.waitReady
  const tOpen = performance.now()
  const row = (await pg.query(sql)).rows[0]
  const tQuery = performance.now()
  await pg.close()
  truncTree(dataDir)
  return {
    mode: 'eager', shape: shapeName,
    ttfqMs: r1(tQuery - t0),
    restoreMs: r1(tRestored - t0),
    openMs: r1(tOpen - tRestored),
    queryMs: r1(tQuery - tOpen),
    bytesPulled: ex.bytes,
    row,
  }
}

// ---- LAZY: eager set + sparse placeholders -> fault on query ---------------
async function runLazy(tier, shapeName, sql, { prefetch }) {
  const store = makeStore(PREFIX)
  mkdirSync(WORKDIR, { recursive: true })
  const dataDir = mkdtempSync(join(WORKDIR, `lazy-${sizeMB}-`))

  const t0 = performance.now()
  // 1. lay down the eager set
  const esrc = await store.getStream(tier.eagerKey)
  if (!esrc) throw new Error('no eager.tar')
  await extractTarStream(Readable.from(esrc.stream), dataDir)
  // 1b. recreate the empty dirs Postgres requires (pg_notify, pg_replslot, ...).
  //     eager.tar is files-only, so these are absent; without them recovery
  //     fails. tier.eagerEmptyDirs is the captured list (fallback for older
  //     tiers built before it was recorded).
  for (const d of tier.eagerEmptyDirs ?? EAGER_EMPTY_DIRS_FALLBACK) {
    mkdirSync(join(dataDir, d), { recursive: true })
  }
  // 2. sparse placeholders (correct size, zero bytes) for every user segment
  const relKeys = []
  const relVersions = []
  const keyIdByPath = new Map()
  const relnameByKeyId = []
  for (const seg of tier.segments) {
    const p = join(dataDir, seg.path)
    mkdirSync(dirname(p), { recursive: true })
    const fd = openSync(p, 'w')
    ftruncateSync(fd, seg.size) // sparse: size set, no bytes written
    closeSync(fd)
    const keyId = relKeys.length
    relKeys.push(`seg/${seg.path}`)
    relVersions.push(seg.gen)
    keyIdByPath.set(seg.path, keyId)
    relnameByKeyId.push(seg.relname)
  }
  const tEager = performance.now()

  // 3. boot LazyBucketFS
  const bridge = new BucketBridge({
    provider,
    gcs: provider === 'gcs' ? { bucket: BUCKET, prefix: PREFIX } : undefined,
    r2: provider === 'r2' ? r2OptsFor(PREFIX) : undefined,
    relKeys, relVersions,
    prefetchStore: makeStore(PREFIX),
  })
  const segSet = new Set(tier.segments.map((s) => s.path))
  const keyIdForPath = (relPath) => (segSet.has(relPath) ? keyIdByPath.get(relPath) : undefined)
  const lazy = new LazyBucketFS(dataDir, { bridge, keyIdForPath })

  const pg = new PGlite({ fs: lazy })
  await pg.waitReady
  const tOpen = performance.now()

  // 4. optional query-plan frontrunning: prefetch the groups of the relations
  //    the plan will touch (all groups of those segments). Concurrent async GETs.
  let prefetchMs = 0
  if (prefetch) {
    const wantRel = new Set(SHAPE_PREFETCH[shapeName] || [])
    const groups = []
    for (const seg of tier.segments) {
      if (!wantRel.has(seg.relname)) continue
      const keyId = keyIdByPath.get(seg.path)
      const nGroups = Math.ceil(seg.size / bridge.groupBytes)
      for (let g = 0; g < nGroups; g++) groups.push({ keyId, groupIdx: g })
    }
    const tp = performance.now()
    await bridge.prefetch(groups, 12)
    prefetchMs = performance.now() - tp
  }

  const tQ0 = performance.now()
  const row = (await pg.query(sql)).rows[0]
  const tQuery = performance.now()
  await pg.close()

  const s = bridge.stats()
  await bridge.close()
  truncTree(dataDir)

  return {
    mode: prefetch ? 'lazy+prefetch' : 'lazy', shape: shapeName,
    ttfqMs: r1(tQuery - t0),
    eagerSetMs: r1(tEager - t0),
    openMs: r1(tOpen - tEager),
    prefetchMs: r1(prefetchMs),
    queryMs: r1(tQuery - tQ0),
    bytesPulled: s.bytesPulled,
    syncFaults: s.syncFaults,
    prefetchFaults: s.prefetchFaults,
    groupsFetched: s.groupsFetched,
    faultLatP50Ms: r1(s.latP50Us / 1000),
    faultLatP99Ms: r1(s.latP99Us / 1000),
    coldGetMs: s.coldGetUs ? r1(s.coldGetUs / 1000) : null,
    warmGetMeanMs: s.warmGetMeanUs ? r1(s.warmGetMeanUs / 1000) : null,
    row,
  }
}

// Free a tmpfs tree by truncating files (no rm); empty dirs are harmless.
function truncTree(dir) {
  for (const rel of listFiles(dir)) {
    try { writeFileSync(join(dir, rel), '') } catch {}
  }
}
function listFiles(dir) {
  try {
    return execSync(`cd ${dir} && find . -type f`).toString().trim().split('\n').map((s) => s.replace(/^\.\//, '')).filter(Boolean)
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
const tier = await loadTier()
const sql = shapeSql(tier.shapeParams)
console.error(`== measure tier ${sizeMB}MB (${provider}), ${RUNS} runs/shape ==`)
console.error(`  user-bytes=${(tier.totalUserBytes / 1e6).toFixed(0)}MB blocks=${tier.totalUserBlocks} eager=${(tier.eagerBytes / 1e6).toFixed(1)}MB`)

const shapes = Object.keys(sql)
const records = []

for (const shape of shapes) {
  // golden for correctness assertion
  const goldenRow = tier.golden[shape === 'pointLookup' ? 'pointPk' : shape]
  for (const variant of [
    { mode: 'eager', fn: () => runEager(tier, shape, sql[shape]) },
    { mode: 'lazy', fn: () => runLazy(tier, shape, sql[shape], { prefetch: false }) },
    { mode: 'lazy+prefetch', fn: () => runLazy(tier, shape, sql[shape], { prefetch: true }) },
  ]) {
    const runs = []
    for (let i = 0; i < RUNS; i++) {
      const rec = await variant.fn()
      // correctness: compare to golden where shapes line up
      if (goldenRow !== undefined) {
        rec.match = JSON.stringify(rec.row) === JSON.stringify(goldenRow)
      }
      runs.push(rec)
      process.stderr.write(`\r  ${shape} ${variant.mode} run ${i + 1}/${RUNS} ttfq=${rec.ttfqMs}ms`)
    }
    process.stderr.write('\n')
    const ttfqs = runs.map((r) => r.ttfqMs)
    const agg = {
      sizeMB, provider, shape, mode: variant.mode, runs: RUNS,
      ttfqP50Ms: pct(ttfqs, 50), ttfqP99Ms: pct(ttfqs, 99),
      ttfqMinMs: Math.min(...ttfqs), ttfqMaxMs: Math.max(...ttfqs),
      bytesPulled: runs[runs.length - 1].bytesPulled,
      faults: runs[runs.length - 1].syncFaults ?? null,
      groupsFetched: runs[runs.length - 1].groupsFetched ?? null,
      faultLatP50Ms: runs[runs.length - 1].faultLatP50Ms ?? null,
      faultLatP99Ms: runs[runs.length - 1].faultLatP99Ms ?? null,
      coldGetMs: runs[runs.length - 1].coldGetMs ?? null,
      warmGetMeanMs: runs[runs.length - 1].warmGetMeanMs ?? null,
      allMatch: runs.every((r) => r.match !== false),
      perRun: runs.map((r) => ({ ttfqMs: r.ttfqMs, bytesPulled: r.bytesPulled, faults: r.syncFaults ?? null, prefetchMs: r.prefetchMs ?? null })),
      measuredAt: new Date().toISOString(),
    }
    records.push(agg)
    console.error(`  => ${shape} ${variant.mode}: TTFQ p50=${agg.ttfqP50Ms}ms p99=${agg.ttfqP99Ms}ms bytes=${(agg.bytesPulled / 1e6).toFixed(1)}MB faults=${agg.faults ?? '-'} match=${agg.allMatch}`)
  }
}

// append to measured.jsonl (one line per (size,shape,mode))
for (const r of records) appendFileSync(OUT, JSON.stringify(r) + '\n')
console.error(`\nwrote ${records.length} records -> ${OUT}`)
