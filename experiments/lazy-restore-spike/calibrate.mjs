// Calibration: measure REAL Postgres block-access footprints per (DB size,
// workload shape, working-set ratio) using actual PGlite + LazyFS.onFault.
//
// We build a table sized to a target, zero its relation file, then run a query
// shaped to touch a target fraction of the data, and record the EXACT set of
// 8KB blocks Postgres faulted (relation + block index). These footprints are the
// ground truth fed into the object-store cost model in sweep.mjs - so the
// simulation's fault counts are real, only the network cost is modeled.
//
// Output: writes one JSON line per (size, shape, wsRatio) to a footprints file.
// Each line: { sizeMB, shape, wsRatio, totalBlocks, touchedBlocks: [...keys],
//              touchedCount, relSizeBytes }
//
// Run: node experiments/lazy-restore-spike/calibrate.mjs [outFile]

import { PGlite } from '@electric-sql/pglite'
import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import {
  mkdtempSync, cpSync, openSync, writeSync, closeSync, statSync, mkdirSync,
  appendFileSync, existsSync,
} from 'node:fs'

const BLCKSZ = 8192
const outFile = process.argv[2] || join(dirname(new URL(import.meta.url).pathname), 'footprints.jsonl')

// Target on-disk relation sizes. Rows are tuned so the heap relation reaches
// roughly the target; we measure the ACTUAL size and report it.
// row width: id int + v int + t text(~40B) => ~60-70B/row useful, ~100B on heap.
// ~52.2 bytes/row on the heap (measured), so rows = targetBytes / 52.2.
const SIZE_PLANS = [
  { sizeMB: 10, rows: 190000 },
  { sizeMB: 50, rows: 950000 },
  { sizeMB: 100, rows: 1900000 },
  { sizeMB: 500, rows: 9500000 },
]

// Working-set ratios to target (fraction of rows the first query touches).
const WS_RATIOS = [0.01, 0.05, 0.25, 1.0]

// Workload shapes. Each returns a SQL string given (rows, wsRatio).
const SHAPES = {
  // Point lookup of a single row by PK. Touches ~1 heap block (+ index blocks,
  // but the index is small and eager). wsRatio ignored (always ~1 block).
  pointLookup: (rows) => `SELECT id, v, t FROM widgets WHERE id = ${Math.floor(rows / 2) + 1}`,

  // Indexed range over a contiguous id window sized to wsRatio. Touches a
  // contiguous fraction of the heap (clustered by insertion order).
  indexedRange: (rows, ws) => {
    const span = Math.max(1, Math.floor(rows * ws))
    const lo = Math.floor((rows - span) / 2) + 1
    return `SELECT count(*)::int n, sum(v)::bigint s FROM widgets WHERE id BETWEEN ${lo} AND ${lo + span - 1}`
  },

  // Full-table scan with a filter. Touches EVERY heap block regardless of how
  // few rows match (the adversarial case for lazy). wsRatio ignored.
  fullScan: () => `SELECT count(*)::int n FROM widgets WHERE v = 0`,

  // Multi-table join: a second small dim table joined to a wsRatio-sized slice
  // of the fact table. Models a join first-paint.
  join: (rows, ws) => {
    const span = Math.max(1, Math.floor(rows * ws))
    const lo = Math.floor((rows - span) / 2) + 1
    return `SELECT count(*)::int n, sum(w.v)::bigint s
            FROM widgets w JOIN dims d ON (w.v % 100) = d.k
            WHERE w.id BETWEEN ${lo} AND ${lo + span - 1}`
  },
}

function buildTable(pg, rows) {
  return pg.exec(`
    CREATE TABLE widgets (id int primary key, v int, t text);
    INSERT INTO widgets SELECT g, (g * 7) % 1000, 'widget-' || g
      FROM generate_series(1, ${rows}) g;
    CREATE TABLE dims (k int primary key, label text);
    INSERT INTO dims SELECT g, 'dim-' || g FROM generate_series(0, 99) g;
    CHECKPOINT;
  `)
}

async function measureOne(work, sizeMB, rows, shape, wsRatio) {
  const dataDir = mkdtempSync(join(work, `dd-${sizeMB}-`))
  const remoteDir = mkdtempSync(join(work, `rm-${sizeMB}-`))

  // Phase 1: build + capture relation path/size.
  let relFileRel, relSize
  {
    const pg = new PGlite({ dataDir })
    await pg.waitReady
    await buildTable(pg, rows)
    relFileRel = (await pg.query(`SELECT pg_relation_filepath('widgets') p`)).rows[0].p
    relSize = Number((await pg.query(`SELECT pg_relation_size('widgets') sz`)).rows[0].sz)
    await pg.close()
  }

  // Phase 2: externalize + zero the relation file (and its segments).
  const segs = []
  for (let i = 0; ; i++) {
    const rel = i === 0 ? relFileRel : `${relFileRel}.${i}`
    const p = join(dataDir, rel)
    if (!existsSync(p)) break
    segs.push(rel)
  }
  for (const rel of segs) {
    const src = join(dataDir, rel)
    const dst = join(remoteDir, rel)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
    const sz = statSync(src).size
    const fd = openSync(src, 'r+'); writeSync(fd, Buffer.alloc(sz), 0, sz, 0); closeSync(fd)
  }

  // Phase 3: run the shaped query under LazyFS, record touched blocks.
  const touched = new Set()
  const interceptMatch = (realPath) => {
    const rel = relative(dataDir, realPath)
    return segs.includes(rel)
  }
  const onFault = ({ path, position, length }) => {
    const startBlk = Math.floor(position / BLCKSZ)
    const endBlk = Math.floor((position + length - 1) / BLCKSZ)
    for (let b = startBlk; b <= endBlk; b++) touched.add(path + ':' + b)
  }
  const sql = SHAPES[shape](rows, wsRatio)
  {
    const lazy = new LazyFS(dataDir, { remoteDir, interceptMatch, onFault })
    const pg = new PGlite({ fs: lazy })
    await pg.waitReady
    await pg.query(sql)
    await pg.close()
  }

  return {
    sizeMB,
    requestedRows: rows,
    shape,
    wsRatio,
    relSizeBytes: relSize,
    totalBlocks: Math.ceil(relSize / BLCKSZ),
    touchedCount: touched.size,
    touchedBlocks: Array.from(touched),
  }
}

const work = mkdtempSync(join(tmpdir(), 'lazy-calib-'))
console.error('calibration workdir:', work, '\noutput:', outFile)

// Decide which (shape, wsRatio) combos to run. point/full ignore wsRatio.
const combos = []
for (const { sizeMB, rows } of SIZE_PLANS) {
  combos.push({ sizeMB, rows, shape: 'pointLookup', wsRatio: 0 })
  combos.push({ sizeMB, rows, shape: 'fullScan', wsRatio: 1.0 })
  for (const ws of WS_RATIOS) {
    combos.push({ sizeMB, rows, shape: 'indexedRange', wsRatio: ws })
    combos.push({ sizeMB, rows, shape: 'join', wsRatio: ws })
  }
}

console.error(`running ${combos.length} calibration combos...`)
let i = 0
for (const c of combos) {
  i++
  const t0 = Date.now()
  try {
    const rec = await measureOne(work, c.sizeMB, c.rows, c.shape, c.wsRatio)
    appendFileSync(outFile, JSON.stringify(rec) + '\n')
    console.error(`[${i}/${combos.length}] ${c.sizeMB}MB ${c.shape} ws=${c.wsRatio} ` +
      `-> rel=${(rec.relSizeBytes / 1e6).toFixed(1)}MB touched=${rec.touchedCount}/${rec.totalBlocks} blocks ` +
      `(${(Date.now() - t0) / 1000}s)`)
  } catch (e) {
    console.error(`[${i}/${combos.length}] ${c.sizeMB}MB ${c.shape} ws=${c.wsRatio} FAILED: ${e.message?.slice(0, 100)}`)
  }
}
console.error('calibration done ->', outFile)
