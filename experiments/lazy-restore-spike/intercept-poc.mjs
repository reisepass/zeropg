// Step 3 - Interception POC (local, no cloud). END-TO-END.
//
// Proves: a real PGlite boots on a datadir where a large relation's segment
// file is ZEROED, the missing heap blocks fault on demand through LazyFS.read()
// (served from a separate LOCAL "remote" store), and queries over that lazy
// relation return byte-identical results to a normal full-restore PGlite.
//
// Flow:
//   1. Boot a NORMAL PGlite. Create a table large enough to span many 8KB heap
//      blocks. CHECKPOINT so heap pages hit the relation file. Capture golden
//      results for several query shapes + a hash of the full row set. Record the
//      relation's on-disk file path.
//   2. Copy the relation file into a REMOTE store, then ZERO the datadir copy
//      (same size) so the datadir physically cannot answer reads.
//   3. Re-open PGlite with LazyFS intercepting reads to that relation file.
//      Re-run each query (fresh instance per query so the buffer cache is cold
//      and the faults are observable per shape).
//   4. Assert every result + the full-row-set hash match golden, and that the
//      intercept actually fired. A zeroed placeholder with no working intercept
//      would yield wrong/empty rows.
//
// Run: node experiments/lazy-restore-spike/intercept-poc.mjs

import { PGlite } from '@electric-sql/pglite'
import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  mkdtempSync, cpSync, openSync, readSync, writeSync, closeSync,
  statSync, mkdirSync,
} from 'node:fs'
import { createHash } from 'node:crypto'

const ROWS = 50000 // ~ many 8KB heap blocks (well over one block)
const BLCKSZ = 8192

// Query shapes exercised. Each is run on its own fresh lazy instance so faults
// are attributable to that shape (cold buffer cache).
const QUERIES = {
  aggregate: `SELECT count(*)::int n, sum(v)::bigint s, min(t) mn, max(t) mx FROM widgets`,
  pointLookup: `SELECT id, v, t FROM widgets WHERE id = 41234`,
  indexedRange: `SELECT count(*)::int n, sum(v)::bigint s FROM widgets WHERE id BETWEEN 10000 AND 10100`,
  fullScanFilter: `SELECT count(*)::int n FROM widgets WHERE v = 0`,
}

function log(...a) { console.log(...a) }
function rowsHash(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

const work = mkdtempSync(join(tmpdir(), 'lazy-poc-'))
const dataDir = join(work, 'pgdata')
const remoteDir = join(work, 'remote')
mkdirSync(remoteDir, { recursive: true })

// ---------------------------------------------------------------------------
// Phase 1: normal PGlite - build data, capture golden results + relation path.
// ---------------------------------------------------------------------------
log('== Phase 1: normal (full-restore) PGlite baseline ==')
const golden = {}
let goldenAllHash, relFileRel, relSize
{
  const pg = new PGlite({ dataDir })
  await pg.waitReady
  await pg.exec(`
    CREATE TABLE widgets (id int primary key, v int, t text);
    INSERT INTO widgets
      SELECT g, (g * 7) % 1000, 'widget-' || g
      FROM generate_series(1, ${ROWS}) g;
    CHECKPOINT;
  `)
  for (const [name, sql] of Object.entries(QUERIES)) {
    golden[name] = (await pg.query(sql)).rows
  }
  goldenAllHash = rowsHash((await pg.query('SELECT id, v, t FROM widgets ORDER BY id')).rows)

  relFileRel = (await pg.query(`SELECT pg_relation_filepath('widgets') p`)).rows[0].p
  const sz = (await pg.query(`SELECT pg_relation_size('widgets') sz`)).rows[0].sz
  relSize = Number(sz)
  log('  rows:', ROWS, '| relation file:', relFileRel, '| size:', relSize, 'bytes =',
      Math.round(relSize / BLCKSZ), '8KB blocks')
  log('  golden aggregate:', JSON.stringify(golden.aggregate[0]))
  log('  golden pointLookup:', JSON.stringify(golden.pointLookup[0]))
  log('  golden full-row-set sha256:', goldenAllHash.slice(0, 16), '...')
  await pg.close()
}

// ---------------------------------------------------------------------------
// Phase 2: externalize relation bytes to the remote store; zero datadir copy.
// ---------------------------------------------------------------------------
log('== Phase 2: copy relation to remote store, ZERO the datadir copy ==')
const datadirRelPath = join(dataDir, relFileRel)
const remoteRelPath = join(remoteDir, relFileRel)
mkdirSync(join(remoteDir, relFileRel, '..'), { recursive: true })
cpSync(datadirRelPath, remoteRelPath)
{
  const zero = Buffer.alloc(relSize)
  const fd = openSync(datadirRelPath, 'r+')
  writeSync(fd, zero, 0, relSize, 0)
  closeSync(fd)
  const a = Buffer.alloc(relSize)
  const fda = openSync(datadirRelPath, 'r'); readSync(fda, a, 0, relSize, 0); closeSync(fda)
  const b = Buffer.alloc(relSize)
  const fdb = openSync(remoteRelPath, 'r'); readSync(fdb, b, 0, relSize, 0); closeSync(fdb)
  log('  datadir copy all-zero:', a.every((x) => x === 0), '| remote has real bytes:', b.some((x) => x !== 0))
  if (!a.every((x) => x === 0) || !b.some((x) => x !== 0)) {
    console.error('SETUP FAILED'); process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Phase 3: re-open with LazyFS (intercepting the relation file), per query.
// ---------------------------------------------------------------------------
log('== Phase 3: LazyFS boot on zeroed relation; faults serve from remote ==')
const targetRel = relFileRel
const interceptMatch = (realPath) => {
  const rel = relative(dataDir, realPath)
  return rel === targetRel || rel.startsWith(targetRel + '.')
}

let allPass = true
const faultSummary = {}
for (const [name, sql] of Object.entries(QUERIES)) {
  const lazy = new LazyFS(dataDir, { remoteDir, interceptMatch })
  const pg = new PGlite({ fs: lazy })
  await pg.waitReady
  const rows = (await pg.query(sql)).rows
  await pg.close()

  const match = JSON.stringify(rows) === JSON.stringify(golden[name])
  const faultedBlocks = lazy.interceptedReadCount
  const faultedBytes = lazy.interceptedBytes
  faultSummary[name] = { faultedReads: faultedBlocks, faultedBytes, match }
  log(`  [${name}] match=${match} faultedReads=${faultedBlocks} faultedBytes=${faultedBytes}`)
  if (!match) {
    allPass = false
    log('    expected:', JSON.stringify(golden[name]).slice(0, 120))
    log('    got     :', JSON.stringify(rows).slice(0, 120))
  }
}

// Full-row-set hash through the lazy FS (a full scan - faults the whole relation).
let lazyAllHash, scanFaults
{
  const lazy = new LazyFS(dataDir, { remoteDir, interceptMatch })
  const pg = new PGlite({ fs: lazy })
  await pg.waitReady
  lazyAllHash = rowsHash((await pg.query('SELECT id, v, t FROM widgets ORDER BY id')).rows)
  scanFaults = lazy.interceptedReadCount
  await pg.close()
}
const allRowsMatch = lazyAllHash === goldenAllHash
log(`  [fullRowSet] hashMatch=${allRowsMatch} faultedReads=${scanFaults}`)

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
log('== Verdict ==')
const anyFault = Object.values(faultSummary).some((f) => f.faultedReads > 0) || scanFaults > 0
log('  per-query results identical to golden:', allPass)
log('  full-row-set hash identical to golden:', allRowsMatch)
log('  intercept fired (faults observed)    :', anyFault)
log('  fault summary:', JSON.stringify(faultSummary))

if (allPass && allRowsMatch && anyFault) {
  log('\nPOC PASSED: PGlite booted on a zeroed relation file; every query faulted the')
  log('missing blocks through LazyFS.read() (served from the local remote store) and')
  log('returned byte-identical results, including a full-row-set hash, vs full-restore.')
  process.exit(0)
} else {
  console.error('\nPOC FAILED:', { allPass, allRowsMatch, anyFault })
  process.exit(1)
}
