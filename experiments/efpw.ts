// A1: quantify full_page_writes=off (and A1.3 wal_compression) on shipped WAL
// volume + compaction frequency, at ~1/50/500 MB databases.
//
// Postgres writes a full 8KB page image (FPI) into WAL on the first change to
// each page after a checkpoint, to repair torn pages during LOCAL crash
// recovery. zeropg never recovers from a torn local datadir (it restores from a
// post-CHECKPOINT snapshot on tmpfs and replays complete, CRC/page-address
// verified WAL over it — see E2b), so FPIs are plausibly redundant bytes we
// ship every commit. This measures exactly how many.
//
// WAL volume is a property of Postgres, independent of the object store, so this
// runs against an in-process MemBlobStore (fast, deterministic, no GCS 1/s cap).
// The CORRECTNESS gate for FPW=off is the E2b crash matrix + e4b run with FPW
// off — this file only quantifies the win.
//
//   tsx experiments/efpw.ts                 # 1/50/500 MB
//   EFPW_SIZES=1,50 EFPW_COMMITS=200 tsx experiments/efpw.ts
//
// Writes results/fpw.jsonl.

import { randomBytes } from 'node:crypto'
import { ZeroPG, decodeManifest, MANIFEST_KEY } from '@zeropg/objectstore-fs'
import { MemBlobStore } from './_memstore.js'
import { logResult, section, round } from './_util.js'

const SIZES_MB = (process.env.EFPW_SIZES ?? '1,50,500').split(',').map(Number)
const COMMITS = Number(process.env.EFPW_COMMITS ?? 300)
const WORK_ROWS = Number(process.env.EFPW_WORKROWS ?? 30000)
const ROWS_PER_COMMIT = Number(process.env.EFPW_RPC ?? 250)

let seed: Uint8Array

interface RunResult {
  sizeMB: number
  fpw: boolean
  walCompression: string
  liveFpw: string
  dbMB: number
  snapshotMB: number
  commits: number
  compactions: number
  walShippedBytes: number
  walPerCommitBytes: number
}

/** Build the DB to ~targetMB with incompressible TOASTed bytea, then compact to
 * a clean snapshot. Then create the `work` table the update workload hammers. */
async function setup(db: ZeroPG, targetMB: number): Promise<{ dbMB: number; snapshotMB: number }> {
  await db.exec('CREATE TABLE IF NOT EXISTS pad (id serial primary key, v bytea)')
  const dbSize = async () =>
    Number((await db.raw.query<{ b: string }>('SELECT pg_database_size(current_database())::text b')).rows[0].b)
  const chunk = 4 * 1024 * 1024
  while ((await dbSize()) < targetMB * 1e6) {
    await db.raw.query('INSERT INTO pad (v) VALUES ($1)', [randomBytes(chunk)])
  }
  // work table: rows ~512B of incompressible pad => ~12 rows / 8KB page, so an
  // update of ROWS_PER_COMMIT random ids first-touches ~that many distinct
  // pages after each checkpoint (where FPW on writes an FPI, off writes none).
  await db.exec('CREATE TABLE work (id int primary key, n int, pad text)')
  // ~512 chars of high-entropy text per row (16 md5(random()) = 512 hex chars).
  // random() is VOLATILE so the subquery re-evaluates per outer row.
  await db.raw.query(
    `INSERT INTO work SELECT g, 0,
       (SELECT string_agg(md5(random()::text), '') FROM generate_series(1,16))
     FROM generate_series(1,$1) g`,
    [WORK_ROWS],
  )
  db.markDirty()
  const snap = await db.compact() // clean snapshot, empty WAL tail, CHECKPOINT done
  const dbMB = round((await dbSize()) / 1e6)
  return { dbMB, snapshotMB: round((snap?.snapshotBytes ?? 0) / 1e6) }
}

async function runWorkload(db: ZeroPG): Promise<{ walShipped: number; compactions: number; commits: number }> {
  let walShipped = 0
  let compactions = 0
  let commits = 0
  for (let i = 0; i < COMMITS; i++) {
    // ROWS_PER_COMMIT random distinct ids.
    const ids = new Set<number>()
    while (ids.size < ROWS_PER_COMMIT) ids.add(1 + Math.floor(Math.random() * WORK_ROWS))
    const list = [...ids].join(',')
    const r = await db.query(`UPDATE work SET n = n + 1 WHERE id IN (${list})`)
    if (r.commit) {
      commits++
      if (r.commit.mode === 'snapshot') compactions++
      else walShipped += r.commit.snapshotBytes
    }
  }
  return { walShipped, compactions, commits }
}

async function oneRun(sizeMB: number, fpw: boolean, walCompression?: 'off' | 'pglz'): Promise<RunResult> {
  const store = new MemBlobStore({ discardBody: (k) => k.startsWith('generations/') })
  const db = await ZeroPG.open({
    store,
    seedSnapshot: seed,
    durability: 'strict',
    commitIntervalMs: 0,
    noLease: true,
    fullPageWrites: fpw,
    walCompression,
  })
  const liveFpw = (await db.raw.query<{ s: string }>("SELECT current_setting('full_page_writes') s")).rows[0].s
  const liveWalc = (await db.raw.query<{ s: string }>("SELECT current_setting('wal_compression') s")).rows[0].s
  const { dbMB, snapshotMB } = await setup(db, sizeMB)
  const w = await runWorkload(db)
  await db.close()
  const res: RunResult = {
    sizeMB,
    fpw,
    walCompression: liveWalc,
    liveFpw,
    dbMB,
    snapshotMB,
    commits: w.commits,
    compactions: w.compactions,
    walShippedBytes: w.walShipped,
    walPerCommitBytes: w.commits ? Math.round(w.walShipped / Math.max(1, w.commits - w.compactions)) : 0,
  }
  return res
}

async function main() {
  seed = await ZeroPG.buildEmptySnapshot()
  const all: RunResult[] = []

  for (const sizeMB of SIZES_MB) {
    section(`DB ~${sizeMB}MB — full_page_writes on vs off (${COMMITS} update commits, ${ROWS_PER_COMMIT} rows each)`)
    const on = await oneRun(sizeMB, true)
    const off = await oneRun(sizeMB, false)
    // Sanity: the running engine actually honored the setting.
    if (on.liveFpw !== 'on') console.log(`    ! WARN: fpw=on run shows full_page_writes=${on.liveFpw}`)
    if (off.liveFpw !== 'off') console.log(`    ! WARN: fpw=off run shows full_page_writes=${off.liveFpw} (NOT off — measurement invalid)`)
    all.push(on, off)
    const walRatio = off.walShippedBytes ? round(on.walShippedBytes / Math.max(1, off.walShippedBytes)) : 0
    console.log(
      `  fpw=on : walShipped=${round(on.walShippedBytes / 1e6)}MB over ${on.commits - on.compactions} incr commits ` +
        `(~${round(on.walPerCommitBytes / 1e3)}KB/commit), compactions=${on.compactions}, snapshot=${on.snapshotMB}MB, fpw_live=${on.liveFpw}`,
    )
    console.log(
      `  fpw=off: walShipped=${round(off.walShippedBytes / 1e6)}MB over ${off.commits - off.compactions} incr commits ` +
        `(~${round(off.walPerCommitBytes / 1e3)}KB/commit), compactions=${off.compactions}, snapshot=${off.snapshotMB}MB, fpw_live=${off.liveFpw}`,
    )
    const pctSmaller = on.walShippedBytes
      ? round((1 - off.walShippedBytes / on.walShippedBytes) * 100)
      : 0
    console.log(
      `  => FPW off ships ${walRatio}x less WAL (${pctSmaller}% smaller); ` +
        `compactions ${on.compactions} -> ${off.compactions}` +
        (off.snapshotMB ? ` (each avoided compaction saves a ~${off.snapshotMB}MB snapshot upload)` : ''),
    )
    logResult('fpw.jsonl', { probe: 'fpw', on, off, walRatio })
  }

  // A1.3: wal_compression=pglz with FPW ON (compresses the FPIs). Lower value
  // if FPW is off (no FPIs to compress), measured here for the record.
  section('A1.3: wal_compression=pglz vs off, FPW on, ~50MB DB')
  const wc50 = SIZES_MB.includes(50) ? 50 : SIZES_MB[SIZES_MB.length - 1]
  const plain = all.find((r) => r.sizeMB === wc50 && r.fpw && r.walCompression === 'off')
    ?? (await oneRun(wc50, true))
  const lz = await oneRun(wc50, true, 'pglz')
  console.log(
    `  fpw=on wal_compression=off : walShipped=${round(plain.walShippedBytes / 1e6)}MB, compactions=${plain.compactions}`,
  )
  console.log(
    `  fpw=on wal_compression=${lz.walCompression}: walShipped=${round(lz.walShippedBytes / 1e6)}MB, compactions=${lz.compactions}`,
  )
  const wcPct = plain.walShippedBytes ? round((1 - lz.walShippedBytes / plain.walShippedBytes) * 100) : 0
  console.log(
    `  => wal_compression=${lz.walCompression}: ${wcPct}% smaller WAL than off, FPW still on ` +
      `(compresses the full-page images in-WAL; less valuable once FPW is off — few/no FPIs left to compress)`,
  )
  logResult('fpw.jsonl', { probe: 'wal_compression', off: plain, pglz: lz, pctSmaller: wcPct })

  section('Done — results in results/fpw.jsonl')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
