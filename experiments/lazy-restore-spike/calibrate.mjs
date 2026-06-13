// Calibration (Phase 3): measure REAL Postgres block-access footprints across a
// realistic MULTI-RELATION schema (heaps + secondary indexes + a wide-row
// table), recording faults across ALL relations a query touches (heap + index),
// not just one primary heap. Runs multiple trials per scenario and records
// variance so downstream TTFQ percentiles have stability bars.
//
// What this fixes vs Phase 2: Phase 2 used one 50k-row flat table, so working
// set = one heap's touched fraction. Real apps fault across multiple relfilenodes
// and index files; a "small" working set must include the index blocks an
// indexed lookup reads. Counting those is more faithful and generally raises the
// faulted-byte floor (an indexed point lookup still has to fault index pages).
//
// Method per scenario (size x shape):
//   1. Build a realistic schema scaled to a target on-disk size. CHECKPOINT.
//   2. Snapshot which files are USER relations (public heaps + indexes) and the
//      total user-relation bytes (the "DB size" lazy must eventually fault).
//   3. For each trial: copy all user-relation files to a remote store, zero the
//      datadir copies, boot LazyFS intercepting ALL of them, run the shaped
//      query, and record the exact 8KB blocks faulted, keyed by relation file.
//   4. Aggregate touched blocks across relations; report per-relation breakdown,
//      total touched blocks/bytes, working-set fraction, and trial variance.
//
// Output: one JSON line per (size, shape) to footprints.jsonl. touchedBlocks is
// the UNION across trials (queries are deterministic so trials should match; we
// verify and record variance).
//
// Run: node experiments/lazy-restore-spike/calibrate.mjs [outFile] [trials] [maxSizeMB]

import { PGlite } from '@electric-sql/pglite'
import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import {
  mkdtempSync, cpSync, openSync, writeSync, closeSync, statSync, mkdirSync,
  appendFileSync, writeFileSync, existsSync,
} from 'node:fs'

const BLCKSZ = 8192
const HERE = dirname(new URL(import.meta.url).pathname)
const outFile = process.argv[2] || join(HERE, 'footprints.jsonl')
const TRIALS = Number(process.argv[3] || 6)
const MAX_SIZE_MB = Number(process.argv[4] || 1024) // include 1GB by default; lower to skip

// Size plans. `scale` multiplies base row counts. Measured: db ~= 6.8MB * scale
// for this schema, so scale = targetMB / 6.8. The ACTUAL measured total is what
// we report. `trials` is per-scenario; large sizes use fewer trials (footprints
// are deterministic, so a couple of trials confirm stability without re-copying
// a multi-GB datadir many times).
const SIZE_PLANS = [
  { sizeMB: 10, scale: 1.5, trials: TRIALS },
  { sizeMB: 50, scale: 7.4, trials: TRIALS },
  { sizeMB: 100, scale: 14.7, trials: TRIALS },
  { sizeMB: 500, scale: 73.5, trials: Math.min(TRIALS, 3) },
  { sizeMB: 1024, scale: 150, trials: Math.min(TRIALS, 2) },
].filter((p) => p.sizeMB <= MAX_SIZE_MB)

// Realistic e-commerce-ish schema with FKs, secondary indexes, a narrow table
// (users), a medium table (orders), a high-row table (line_items), and a WIDE
// table (documents) with a large text column so blocks-per-row varies.
function buildSchema(pg, scale) {
  const users = Math.round(2000 * scale)
  const orders = Math.round(8000 * scale)
  const lineItems = Math.round(40000 * scale)
  const docs = Math.round(1500 * scale) // wide rows
  return pg.exec(`
    CREATE TABLE users (id int primary key, email text, name text, created int);
    CREATE TABLE orders (id int primary key, user_id int references users(id), total int, status text, created int);
    CREATE TABLE line_items (id int primary key, order_id int references orders(id), sku text, qty int, price int);
    CREATE TABLE documents (id int primary key, owner int, body text);
    CREATE INDEX idx_orders_user ON orders(user_id);
    CREATE INDEX idx_orders_status ON orders(status);
    CREATE INDEX idx_li_order ON line_items(order_id);
    CREATE INDEX idx_li_sku ON line_items(sku);
    CREATE INDEX idx_docs_owner ON documents(owner);

    INSERT INTO users SELECT g, 'user'||g||'@example.com', 'User Name '||g, g
      FROM generate_series(1, ${users}) g;
    INSERT INTO orders SELECT g, (g % ${users}) + 1, (g * 13) % 500,
      (ARRAY['new','paid','shipped','cancelled'])[(g % 4) + 1], g
      FROM generate_series(1, ${orders}) g;
    INSERT INTO line_items SELECT g, (g % ${orders}) + 1, 'SKU-' || (g % 900),
      (g % 5) + 1, (g * 7) % 200
      FROM generate_series(1, ${lineItems}) g;
    INSERT INTO documents SELECT g, (g % ${users}) + 1,
      repeat('lorem ipsum dolor sit amet ', 40) || g
      FROM generate_series(1, ${docs}) g;
    CHECKPOINT;
  `)
}

// Query shapes hitting the policy's decision points.
function makeShapes(scale) {
  const users = Math.round(2000 * scale)
  const orders = Math.round(8000 * scale)
  const lineItems = Math.round(40000 * scale)
  return {
    // Point lookup by PRIMARY KEY (index + 1 heap block).
    pointPk: `SELECT * FROM line_items WHERE id = ${Math.floor(lineItems / 2)}`,

    // Point lookup by SECONDARY index (idx_li_sku) - faults index + scattered heap.
    pointSecondary: `SELECT count(*)::int n, sum(price)::bigint s FROM line_items WHERE sku = 'SKU-450'`,

    // Indexed JOIN: a user's orders joined to their line_items - faults orders
    // heap+index and line_items across several relfilenodes.
    indexedJoin: `SELECT count(*)::int n, sum(li.price)::bigint s
                  FROM orders o JOIN line_items li ON li.order_id = o.id
                  WHERE o.user_id = ${Math.floor(users / 2)}`,

    // Range scan over a contiguous PK window (~5% of line_items).
    rangeScan: (() => {
      const span = Math.max(1, Math.floor(lineItems * 0.05))
      const lo = Math.floor((lineItems - span) / 2) + 1
      return `SELECT count(*)::int n, sum(price)::bigint s FROM line_items WHERE id BETWEEN ${lo} AND ${lo + span - 1}`
    })(),

    // Wide-row point lookup (documents heap has few rows/block).
    pointWide: `SELECT length(body) FROM documents WHERE id = ${Math.max(1, Math.floor(750 * scale))}`,

    // Adversarial FULL TABLE SCAN of the largest heap.
    fullScan: `SELECT count(*)::int n FROM line_items WHERE price = 0`,
  }
}

// Discover user relation files (public heaps + indexes) and total bytes.
async function snapshotUserRelations(pg) {
  const rows = (await pg.query(`
    SELECT c.relname, c.relkind, pg_relation_filepath(c.oid) AS path, pg_relation_size(c.oid)::bigint AS sz
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i')
  `)).rows
  return rows
    .filter((r) => r.path)
    .map((r) => ({ relname: r.relname, relkind: r.relkind, path: r.path, sz: Number(r.sz) }))
}

// Expand a relation main-fork path to all its on-disk segment files.
function segmentsOf(dataDir, relPath) {
  const segs = []
  for (let i = 0; ; i++) {
    const rel = i === 0 ? relPath : `${relPath}.${i}`
    if (!existsSync(join(dataDir, rel))) break
    segs.push(rel)
  }
  return segs
}

// Build a size tier ONCE: one datadir + one remote copy of its user-relation
// segments, reused across all shapes for that size. Disk usage stays ~2x the
// tier size (one datadir + one relation copy) instead of growing per shape.
async function buildTier(work, sizeMB, scale) {
  const dataDir = mkdtempSync(join(work, `dd-${sizeMB}-`))
  let userRels
  {
    const pg = new PGlite({ dataDir })
    await pg.waitReady
    await buildSchema(pg, scale)
    userRels = await snapshotUserRelations(pg)
    await pg.close()
  }
  const allSegs = []
  for (const r of userRels) for (const s of segmentsOf(dataDir, r.path)) allSegs.push(s)
  const segSet = new Set(allSegs)
  const totalUserBytes = userRels.reduce((a, r) => a + r.sz, 0)

  // One-time remote copy of the true relation bytes.
  const remoteDir = mkdtempSync(join(work, `rm-${sizeMB}-`))
  for (const rel of allSegs) {
    const dst = join(remoteDir, rel)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(join(dataDir, rel), dst)
  }
  return { dataDir, remoteDir, userRels, allSegs, segSet, totalUserBytes, scale }
}

async function measureShape(tier, sizeMB, shapeName, trials) {
  const { dataDir, remoteDir, userRels, allSegs, segSet, totalUserBytes } = tier
  const totalUserBlocks = Math.ceil(totalUserBytes / BLCKSZ)
  const sqlOf = makeShapes(tier.scale)[shapeName]

  // Re-zero the relation segments IN PLACE in the datadir before each trial so
  // every trial starts from a truly-absent relation, faulting from the one
  // remote copy. No per-trial full copies (that is what filled the disk before).
  const zeroSegments = () => {
    for (const rel of allSegs) {
      const src = join(dataDir, rel)
      const sz = statSync(src).size
      const fd = openSync(src, 'r+'); writeSync(fd, Buffer.alloc(sz), 0, sz, 0); closeSync(fd)
    }
  }
  // Restore the true bytes from remote (so a prior shape's zeroing/boot does not
  // leave the relation empty for the next shape's build-state assumptions).
  const restoreSegments = () => {
    for (const rel of allSegs) cpSync(join(remoteDir, rel), join(dataDir, rel))
  }

  const trialTouchCounts = []
  const unionTouched = new Set()
  const interceptMatch = (realPath) => segSet.has(relative(dataDir, realPath))
  for (let t = 0; t < trials; t++) {
    zeroSegments()
    const touched = new Set()
    const onFault = ({ path, position, length }) => {
      const startBlk = Math.floor(position / BLCKSZ)
      const endBlk = Math.floor((position + length - 1) / BLCKSZ)
      for (let b = startBlk; b <= endBlk; b++) touched.add(path + ':' + b)
    }
    const lazy = new LazyFS(dataDir, { remoteDir, interceptMatch, onFault })
    const pg = new PGlite({ fs: lazy })
    await pg.waitReady
    await pg.query(sqlOf)
    await pg.close()
    trialTouchCounts.push(touched.size)
    for (const k of touched) unionTouched.add(k)
  }
  restoreSegments() // leave the datadir whole for the next shape

  // Per-relation touched-block counts from the union.
  const perRel = {}
  for (const k of unionTouched) {
    const rel = k.slice(0, k.lastIndexOf(':'))
    perRel[rel] = (perRel[rel] || 0) + 1
  }
  const relMeta = Object.fromEntries(userRels.map((r) => [r.path, { relname: r.relname, relkind: r.relkind, sz: r.sz }]))
  const perRelBreakdown = Object.entries(perRel)
    .map(([path, blocks]) => ({ path, blocks, relname: relMeta[path]?.relname, relkind: relMeta[path]?.relkind }))
    .sort((a, b) => b.blocks - a.blocks)

  const mean = trialTouchCounts.reduce((a, b) => a + b, 0) / trialTouchCounts.length
  const variance = trialTouchCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / trialTouchCounts.length
  const stddev = Math.sqrt(variance)

  const touchedCount = unionTouched.size
  return {
    sizeMB,
    scale: tier.scale,
    shape: shapeName,
    relSizeBytes: totalUserBytes,
    totalBlocks: totalUserBlocks,
    touchedCount,
    touchedFrac: +(touchedCount / totalUserBlocks).toFixed(5),
    touchedBytes: touchedCount * BLCKSZ,
    relationsTouched: perRelBreakdown.length,
    relationsTotal: userRels.length,
    perRelBreakdown,
    trials,
    trialTouchCounts,
    touchMean: +mean.toFixed(1),
    touchStddev: +stddev.toFixed(2),
    touchMin: Math.min(...trialTouchCounts),
    touchMax: Math.max(...trialTouchCounts),
    stable: stddev === 0,
    touchedBlocks: Array.from(unionTouched),
  }
}

const work = mkdtempSync(join(tmpdir(), 'lazy-calib3-'))
console.error('calibration workdir:', work, '\noutput:', outFile, '\ntrials per scenario:', TRIALS,
  '\nsizes:', SIZE_PLANS.map((p) => p.sizeMB + 'MB').join(', '))

writeFileSync(outFile, '') // fresh

const shapeNames = Object.keys(makeShapes(1))
const totalBoots = SIZE_PLANS.reduce((a, p) => a + p.trials * shapeNames.length, 0)
console.error(`running ${SIZE_PLANS.length} size tiers x ${shapeNames.length} shapes = ${totalBoots} measured boots`)

let done = 0
const totalScenarios = SIZE_PLANS.length * shapeNames.length
const tStart = Date.now()
for (const { sizeMB, scale, trials } of SIZE_PLANS) {
  // Build this size tier once; reuse across all shapes (disk-frugal).
  let tier
  try {
    tier = await buildTier(work, sizeMB, scale)
  } catch (e) {
    console.error(`[tier ${sizeMB}MB] BUILD FAILED: ${e.message?.slice(0, 160)} - skipping tier`)
    done += shapeNames.length
    continue
  }
  for (const shape of shapeNames) {
    done++
    const t0 = Date.now()
    try {
      const rec = await measureShape(tier, sizeMB, shape, trials)
      appendFileSync(outFile, JSON.stringify(rec) + '\n')
      console.error(
        `[${done}/${totalScenarios}] ${sizeMB}MB ${shape} -> ` +
        `db=${(rec.relSizeBytes / 1e6).toFixed(0)}MB touched=${rec.touchedCount}/${rec.totalBlocks} ` +
        `(${(rec.touchedFrac * 100).toFixed(3)}%) rels=${rec.relationsTouched}/${rec.relationsTotal} ` +
        `sd=${rec.touchStddev} [${((Date.now() - t0) / 1000).toFixed(0)}s, tot ${((Date.now() - tStart) / 1000).toFixed(0)}s]`,
      )
    } catch (e) {
      console.error(`[${done}/${totalScenarios}] ${sizeMB}MB ${shape} FAILED: ${e.message?.slice(0, 160)}`)
    }
  }
}
console.error(`calibration done -> ${outFile} (${((Date.now() - tStart) / 1000).toFixed(0)}s total)`)
