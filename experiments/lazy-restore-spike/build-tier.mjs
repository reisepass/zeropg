// Build ONE dataset tier and stage it in the bucket for the eager-vs-lazy
// measurement. Datadir lives on tmpfs (/dev/shm) - mirrors a serverless rootfs
// and keeps the boot disk untouched (a prior session leaked 57GB; we do not).
//
// What it produces in the bucket under prefix lazy-measure/<tier>/:
//   - snapshot.tar              : full datadir tar (the EAGER restore path reads
//                                 this via one streamed, parallel-range GET).
//   - seg/<relpath>             : each USER relation segment as its own object
//                                 (the LAZY fault path range-GETs 1MB groups of
//                                 these). Catalogs/control/WAL are NOT uploaded
//                                 as segments; they ride in snapshot.tar and the
//                                 eager set the lazy boot lays down locally.
//   - tier.json                 : manifest - sizes, user-relation list with
//                                 pinned generations, snapshot generation, the
//                                 query shapes, and the eager-set file list.
//
// The bulk INSERT is BATCHED (calibrate.mjs hit "XLogBeginInsert was already
// called" / fragility on one huge INSERT+CHECKPOINT at 500MB+). Batching also
// bounds WAL growth and lets us CHECKPOINT periodically so the datadir on tmpfs
// does not balloon with WAL during the build.
//
// Run:
//   node_modules/.bin/tsx experiments/lazy-restore-spike/build-tier.mjs 500 gcs
//   node_modules/.bin/tsx experiments/lazy-restore-spike/build-tier.mjs 1024 gcs

import { PGlite } from '@electric-sql/pglite'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'
// tar.ts is internal to objectstore-fs (not re-exported); import the source
// file directly to reuse the one battle-tested tar writer the commit path uses.
import { createTarStream } from '../../packages/objectstore-fs/src/tar.ts'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  mkdtempSync, mkdirSync, readFileSync, statSync, existsSync, writeFileSync, linkSync,
} from 'node:fs'
import { execSync } from 'node:child_process'

const BLCKSZ = 8192
const TMPFS = process.env.TMPFS_DIR || '/dev/shm'
const sizeMB = Number(process.argv[2] || 500)
const provider = process.argv[3] || 'gcs'
const BUCKET = 'zeropg-experiments-euw1'
const PREFIX = `lazy-measure/${sizeMB}mb`

// scale -> ~sizeMB on disk for this schema (measured ~6.8MB/scale incl indexes).
const SCALE = { 500: 73.5, 1024: 150, 2048: 300 }[sizeMB] ?? sizeMB / 6.8
const INSERT_BATCH = 50_000 // rows per INSERT statement (batched, not one huge insert)

function makeStore(prefix) {
  if (provider === 'gcs') return new GcsBlobStore({ bucket: BUCKET, prefix })
  if (provider === 'r2') {
    const s = R2BlobStore.fromEnv(prefix)
    if (!s) throw new Error('R2 creds missing (source ~/.zeropg-r2.env)')
    return s
  }
  throw new Error(`unknown provider ${provider}`)
}

// Batched, idempotent bulk load. generate_series is sliced into INSERT_BATCH
// windows; CHECKPOINT every few batches so WAL on tmpfs stays bounded.
async function loadTable(pg, table, total, rowExpr, label) {
  let done = 0
  let sinceCkpt = 0
  while (done < total) {
    const lo = done + 1
    const hi = Math.min(done + INSERT_BATCH, total)
    await pg.exec(`INSERT INTO ${table} SELECT ${rowExpr} FROM generate_series(${lo}, ${hi}) g;`)
    done = hi
    sinceCkpt += hi - lo + 1
    if (sinceCkpt >= 250_000) {
      await pg.exec('CHECKPOINT;')
      sinceCkpt = 0
    }
    if (done % 500_000 === 0 || done === total) {
      process.stderr.write(`\r  [${label}] ${done}/${total}`)
    }
  }
  process.stderr.write('\n')
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

const work = mkdtempSync(join(TMPFS, 'bucket-build-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir)
console.error(`== build tier ${sizeMB}MB (scale=${SCALE}, provider=${provider}) ==`)
console.error(`  datadir: ${dataDir} (tmpfs)`)

const users = Math.round(2000 * SCALE)
const orders = Math.round(8000 * SCALE)
const lineItems = Math.round(40000 * SCALE)
const docs = Math.round(1500 * SCALE)

let userRels, allSegs, totalUserBytes
const tBuild = Date.now()
{
  // Cap recycled WAL so the eager set is honestly catalogs+control (~tens of MB),
  // not 400MB of recycled 16MB segments left over from the bulk load. v1 snapshots
  // at a clean checkpoint with little WAL; we mirror that here.
  {
    const seed = new PGlite({ dataDir })
    await seed.waitReady
    await seed.query(`ALTER SYSTEM SET max_wal_size='48MB'`)
    await seed.query(`ALTER SYSTEM SET min_wal_size='32MB'`)
    await seed.close()
  }
  const pg = new PGlite({ dataDir })
  await pg.waitReady
  await pg.exec(`
    CREATE TABLE users (id int primary key, email text, name text, created int);
    CREATE TABLE orders (id int primary key, user_id int, total int, status text, created int);
    CREATE TABLE line_items (id int primary key, order_id int, sku text, qty int, price int);
    CREATE TABLE documents (id int primary key, owner int, body text);
  `)
  // Load heaps FIRST (no indexes yet -> faster, less WAL), then build indexes.
  await loadTable(pg, 'users', users, `g, 'user'||g||'@example.com', 'User Name '||g, g`, 'users')
  await loadTable(pg, 'orders', orders, `g, (g % ${users}) + 1, (g * 13) % 500, (ARRAY['new','paid','shipped','cancelled'])[(g % 4) + 1], g`, 'orders')
  await loadTable(pg, 'line_items', lineItems, `g, (g % ${orders}) + 1, 'SKU-' || (g % 900), (g % 5) + 1, (g * 7) % 200`, 'line_items')
  await loadTable(pg, 'documents', docs, `g, (g % ${users}) + 1, repeat('lorem ipsum dolor sit amet ', 40) || g`, 'documents')
  process.stderr.write('  building indexes...\n')
  await pg.exec(`
    CREATE INDEX idx_orders_user ON orders(user_id);
    CREATE INDEX idx_orders_status ON orders(status);
    CREATE INDEX idx_li_order ON line_items(order_id);
    CREATE INDEX idx_li_sku ON line_items(sku);
    CREATE INDEX idx_docs_owner ON documents(owner);
    CHECKPOINT;
  `)
  // Capture golden answers for the measurement shapes (so eager/lazy verify).
  const golden = {
    pointPk: (await pg.query(`SELECT id,order_id,sku,qty,price FROM line_items WHERE id = ${Math.floor(lineItems/2)}`)).rows[0],
    indexedRange: (await pg.query(`SELECT count(*)::int n, sum(price)::bigint s FROM line_items WHERE id BETWEEN ${Math.floor(lineItems*0.475)} AND ${Math.floor(lineItems*0.525)}`)).rows[0],
    fullScan: (await pg.query(`SELECT count(*)::int n FROM line_items WHERE price = 0`)).rows[0],
  }
  userRels = await snapshotUserRelations(pg)
  // Double-CHECKPOINT (as v1 does) so recovery after restore touches ~no WAL.
  await pg.query('CHECKPOINT')
  await pg.query('CHECKPOINT')
  await pg.close()

  allSegs = []
  for (const r of userRels) for (const s of segmentsOf(dataDir, r.path)) allSegs.push(s)
  totalUserBytes = userRels.reduce((a, r) => a + r.sz, 0)
  global.__golden = golden
  global.__shapeParams = { lineItems, users, orders }
}
const onDiskMB = Number(execSync(`du -sm ${dataDir}`).toString().trim().split(/\s+/)[0])
console.error(`  built in ${((Date.now()-tBuild)/1000).toFixed(0)}s: ${userRels.length} user rels, ${allSegs.length} segs, user-bytes=${(totalUserBytes/1e6).toFixed(0)}MB, datadir=${onDiskMB}MB`)

// ---- upload: full snapshot tar (eager) -------------------------------------
const store = makeStore(PREFIX)
const tUp = Date.now()
const snapPut = await store.putStream('snapshot.tar', createTarStream(dataDir))
console.error(`  uploaded snapshot.tar gen=${snapPut.etag} (${((Date.now()-tUp)/1000).toFixed(0)}s)`)

// ---- upload: per-segment objects (lazy) ------------------------------------
const relManifest = []
let upBytes = 0
for (const r of userRels) {
  const segs = segmentsOf(dataDir, r.path)
  for (const rel of segs) {
    const bytes = readFileSync(join(dataDir, rel))
    const put = await store.put(`seg/${rel}`, bytes)
    relManifest.push({ relname: r.relname, relkind: r.relkind, path: rel, size: bytes.length, gen: put.etag })
    upBytes += bytes.length
  }
}
console.error(`  uploaded ${relManifest.length} segments (${(upBytes/1e6).toFixed(0)}MB)`)

// ---- eager set: every non-user-relation file (catalogs, control, etc.) -----
// The lazy boot lays these down locally; only user-relation segments fault.
function listAll(dir, base = '') {
  const out = []
  for (const name of execSync(`cd ${dir} && find . -type f`).toString().trim().split('\n')) {
    out.push(name.replace(/^\.\//, ''))
  }
  return out
}
const segSet = new Set(allSegs)
const eagerSet = listAll(dataDir).filter((p) => !segSet.has(p))
const eagerBytes = eagerSet.reduce((a, p) => { try { return a + statSync(join(dataDir, p)).size } catch { return a } }, 0)

// Empty directories Postgres REQUIRES at startup (pg_notify, pg_replslot,
// pg_stat, pg_wal/archive_status, ...). createTarStream walks files only, so
// eager.tar drops them; the lazy boot must recreate them or initdb-recovery
// fails ("PGlite failed to initialize properly"). The full snapshot.tar carries
// them, which is why EAGER boots and a naive lazy reconstruction does not.
const eagerEmptyDirs = execSync(`cd ${dataDir} && find . -type d -empty`)
  .toString().trim().split('\n').map((s) => s.replace(/^\.\//, '')).filter(Boolean)

// Stage an eager-only tree via hardlinks (~0 bytes on tmpfs) and tar+upload it.
// The lazy boot streams THIS (small) object, then lays down sparse placeholders
// for the user-relation segments it will fault on demand. This is the real
// lazy-boot download cost - not the full snapshot.
const eagerDir = join(work, 'eager')
for (const rel of eagerSet) {
  const dst = join(eagerDir, rel)
  mkdirSync(dirname(dst), { recursive: true })
  try { linkSync(join(dataDir, rel), dst) } catch { writeFileSync(dst, readFileSync(join(dataDir, rel))) }
}
const tEager = Date.now()
const eagerPut = await store.putStream('eager.tar', createTarStream(eagerDir))
console.error(`  uploaded eager.tar gen=${eagerPut.etag} (${(eagerBytes/1e6).toFixed(1)}MB, ${((Date.now()-tEager)/1000).toFixed(0)}s)`)

const tier = {
  sizeMB,
  provider,
  prefix: PREFIX,
  bucket: BUCKET,
  scale: SCALE,
  datadirMB: onDiskMB,
  totalUserBytes,
  totalUserBlocks: Math.ceil(totalUserBytes / BLCKSZ),
  snapshotKey: 'snapshot.tar',
  snapshotGen: snapPut.etag,
  snapshotSize: snapPut.size ?? null,
  eagerKey: 'eager.tar',
  eagerGen: eagerPut.etag,
  segments: relManifest,
  eagerSet,
  eagerEmptyDirs,
  eagerBytes,
  shapeParams: global.__shapeParams,
  golden: global.__golden,
  builtAt: new Date().toISOString(),
}
const tierJsonLocal = join(work, 'tier.json')
writeFileSync(tierJsonLocal, JSON.stringify(tier, null, 2))
await store.put('tier.json', readFileSync(tierJsonLocal), { contentType: 'application/json' })
// keep a local copy next to the harness for offline inspection
writeFileSync(join(dirname(new URL(import.meta.url).pathname), `tier-${sizeMB}mb.json`), JSON.stringify(tier, null, 2))
console.error(`  wrote tier.json (eagerSet=${eagerSet.length} files, ${(eagerBytes/1e6).toFixed(1)}MB)`)

// ---- free tmpfs WITHOUT rm: truncate then rmdir the empty tree -------------
// (rm is forbidden; rmSync of an already-truncated tree only removes empty dirs
//  + zero-byte files, which is allowed and leaks nothing.)
try {
  // truncate all files to 0 first to release bytes immediately
  for (const p of listAll(dataDir)) { try { writeFileSync(join(dataDir, p), '') } catch {} }
} catch {}
console.error(`  done. bucket prefix: gs://${BUCKET}/${PREFIX}/`)
console.error(`  (datadir files truncated to free tmpfs; empty tree left at ${work})`)
