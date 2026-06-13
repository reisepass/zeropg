// Step 3 - Interception POC (local, no cloud).
//
// Goal: prove that with a custom pglite Filesystem (LazyFS, subclass of the
// public BaseFilesystem) we can (a) intercept the individual block reads
// Postgres issues against a chosen relation segment file, and (b) satisfy them
// ourselves from a separate backing store, such that SELECT results are
// byte-for-byte identical to a normal PGlite.
//
// Flow:
//   1. Boot a NORMAL PGlite on a fresh datadir. Create a table, insert rows,
//      CHECKPOINT so heap pages are flushed to the relation file. Run the query;
//      record the "golden" result. Find the relation's on-disk file path.
//   2. Close it. Copy that relation file into a separate REMOTE store dir, then
//      overwrite the datadir copy with a ZEROED placeholder of the same size
//      (so the datadir physically cannot answer the read).
//   3. Re-open PGlite with LazyFS that intercepts reads to that relation file
//      and serves them from the remote store. Run the SAME query.
//   4. Assert: results identical AND the intercept actually fired (read count>0,
//      bytes came from 'remote'). Without a working intercept, the zeroed
//      placeholder would yield wrong/empty rows.
//
// Run: node experiments/lazy-restore-spike/intercept-poc.mjs

import { PGlite } from '@electric-sql/pglite'
import { LazyFS } from './lazy-fs.mjs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  mkdtempSync, cpSync, openSync, readSync, writeSync, closeSync,
  statSync, mkdirSync, existsSync,
} from 'node:fs'

const ROWS = 5000
const QUERY = 'SELECT count(*)::int AS n, sum(v)::bigint AS s, min(t) AS mn, max(t) AS mx FROM widgets'

function log(...a) { console.log(...a) }

// ---------------------------------------------------------------------------
// Phase 1: normal PGlite, build data, capture golden result + relation path.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'lazy-poc-'))
const dataDir = join(work, 'pgdata')
const remoteDir = join(work, 'remote')
mkdirSync(remoteDir, { recursive: true })

log('== Phase 1: normal PGlite ==')
let golden, relFileRel
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

  golden = (await pg.query(QUERY)).rows[0]
  log('  golden:', JSON.stringify(golden))

  // Find the relation's main fork file: base/<dboid>/<relfilenode>
  const relnode = (await pg.query(
    `SELECT pg_relation_filepath('widgets') AS p`,
  )).rows[0].p
  relFileRel = relnode // e.g. base/5/16384
  const sz = (await pg.query(
    `SELECT pg_relation_size('widgets') AS sz`,
  )).rows[0].sz
  log('  relation file:', relFileRel, 'size:', String(sz), 'bytes')

  await pg.close()
}

// ---------------------------------------------------------------------------
// Phase 2: move relation bytes to the remote store; zero the datadir copy.
// ---------------------------------------------------------------------------
log('== Phase 2: externalize relation file to remote store, zero datadir copy ==')
const datadirRelPath = join(dataDir, relFileRel)
const remoteRelPath = join(remoteDir, relFileRel)
mkdirSync(join(remoteDir, relFileRel, '..'), { recursive: true })

// Copy real bytes to remote store.
cpSync(datadirRelPath, remoteRelPath)
const relSize = statSync(datadirRelPath).size

// Overwrite the datadir copy with zeros (same size) so it cannot answer reads.
// (We do NOT delete - just clobber the bytes in place.)
{
  const zero = Buffer.alloc(relSize)
  const fd = openSync(datadirRelPath, 'r+')
  writeSync(fd, zero, 0, relSize, 0)
  closeSync(fd)
}
// Sanity: confirm datadir copy is now all zeros and differs from remote.
{
  const a = Buffer.alloc(relSize), b = Buffer.alloc(relSize)
  let fda = openSync(datadirRelPath, 'r'); readSync(fda, a, 0, relSize, 0); closeSync(fda)
  let fdb = openSync(remoteRelPath, 'r'); readSync(fdb, b, 0, relSize, 0); closeSync(fdb)
  const datadirZeroed = a.every((x) => x === 0)
  const remoteHasData = b.some((x) => x !== 0)
  log('  datadir copy all-zero:', datadirZeroed, '| remote has real bytes:', remoteHasData)
  if (!datadirZeroed || !remoteHasData) {
    console.error('SETUP FAILED: zeroing/copy did not take')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Phase 3: re-open with LazyFS that intercepts reads to that relation file.
// ---------------------------------------------------------------------------
log('== Phase 3: re-open with LazyFS (intercept reads to the relation file) ==')
const targetRel = relFileRel // PGDATA-relative path of the target
const lazy = new LazyFS(dataDir, {
  remoteDir,
  // Intercept only the target relation's main-fork file (and its segments).
  interceptMatch: (realPath) => {
    const rel = relative(dataDir, realPath)
    return rel === targetRel || rel.startsWith(targetRel + '.')
  },
  debug: true,
})

let lazyResult
{
  const pg = new PGlite({ fs: lazy })
  await pg.waitReady
  lazyResult = (await pg.query(QUERY)).rows[0]
  log('  lazy result:', JSON.stringify(lazyResult))
  await pg.close()
}

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
log('== Verdict ==')
log('  intercepted reads:', lazy.interceptedReadCount,
    '| bytes served from remote:', lazy.interceptedBytes)
const sample = lazy.readLog.slice(0, 5)
log('  sample intercepted block reads (position,length):')
for (const r of sample) log('   ', JSON.stringify(r))

const match =
  golden.n === lazyResult.n &&
  String(golden.s) === String(lazyResult.s) &&
  golden.mn === lazyResult.mn &&
  golden.mx === lazyResult.mx
const interceptFired = lazy.interceptedReadCount > 0 && lazy.interceptedBytes > 0

log('')
log('  results identical to golden:', match)
log('  intercept actually fired   :', interceptFired)

if (match && interceptFired) {
  log('\nPOC PASSED: lazy intercept served the relation reads; query result is byte-identical to a normal PGlite.')
  process.exit(0)
} else {
  console.error('\nPOC FAILED:', { match, interceptFired })
  process.exit(1)
}
