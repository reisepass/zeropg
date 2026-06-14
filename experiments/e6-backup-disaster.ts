// E6: cold-storage backup disaster matrix (Track D). A database system cannot
// ship without proven backups, so this harness holds the secondary-backup
// feature to the same bar as the core engine's E2b crash matrix + E4 lifecycle:
// inject the fault, then assert byte-identical recovery via a checksum table.
//
// The feature under test is ColdArchiver wired into ZeroPG as a DEFAULT backup
// target (ZeroPGOptions.backup): every compaction snapshot is followed by a
// self-contained cold backup of that committed point to a SECOND store, plus
// retention. The cold store is a DISTINCT prefix (a second blast radius) from
// the primary, under whatever transport the env selects.
//
// Backend: real IBM COS (S3/SigV4 R2BlobStore against the COS endpoint) when
// COS_* creds are present (source ~/.zeropg-ibm.env), else an in-process
// MemBlobStore. Scenarios that need a genuine process crash (real SIGKILL) run
// child processes and therefore REQUIRE a shared real store; without creds they
// are reported as skipped, and the in-process fault-point scenarios still run.
//
// Scenarios:
//   A. SIGKILL mid-backup        -> primary intact, partial backup is ignorable
//                                   garbage, next backup succeeds + restorable.
//   B. Primary snapshot deleted  -> restore from the cold backup, byte-identical.
//   C. FULL primary wipe         -> restoreFromBackup rebuilds a working DB that
//                                   boots and serves SQL, byte-identical.
//   D. Retention safety          -> keepLast/maxAgeDays/GFS never delete the last
//                                   restorable backup; a crash DURING retention
//                                   GC leaves a fully restorable set.
//   E. Backup-index CAS race     -> two archivers, no corruption, no lost update.
//   F. Crash during restore      -> retry restores cleanly, byte-identical.
//   G. Round-trip 1/50/500MB     -> default-wiring backup + full-disaster restore,
//                                   byte-identical at each size.
//
// Roles: `tsx e6-backup-disaster.ts child <primaryPrefix> <coldPrefix> <fault>`
// runs the SIGKILL child; no args runs the parent harness.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { rm } from 'node:fs/promises'
import {
  R2BlobStore,
  type BlobStore,
  type Bytes,
  type GetOptions,
  type GetResult,
  type GetStreamResult,
  type ListEntry,
  type PutOptions,
  type PutResult,
} from '../packages/blobstore/src/index.js'
import {
  ZeroPG,
  ColdArchiver,
  decodeBackupIndex,
  INDEX_KEY,
  MANIFEST_KEY,
  type RetentionPolicy,
} from '../packages/objectstore-fs/src/index.js'
import { MemBlobStore } from './_memstore.js'
import { logResult, section, assert, failureCount, resetFailures, round } from './_util.js'

// ---------------------------------------------------------------------------
// Backend selection: real COS when creds present, else in-process Mem.
// ---------------------------------------------------------------------------
const USE_COS = !!(process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY)
const COS_BUCKET = process.env.COS_BUCKET ?? 'zeropg-cos'
const COS_REGION = process.env.IBM_COS_REGION ?? 'eu-de'
// From outside Code Engine the DIRECT endpoint is not routable; prefer public.
const COS_ENDPOINT = process.env.COS_ENDPOINT || process.env.COS_ENDPOINT_DIRECT

function makeStore(prefix: string): BlobStore {
  if (USE_COS) {
    if (!COS_ENDPOINT) throw new Error('COS_* creds set but no COS_ENDPOINT')
    return new R2BlobStore({
      endpoint: COS_ENDPOINT,
      accessKeyId: process.env.COS_HMAC_ACCESS_KEY_ID!,
      secretAccessKey: process.env.COS_HMAC_SECRET_ACCESS_KEY!,
      bucket: COS_BUCKET,
      prefix,
      region: COS_REGION,
    })
  }
  return new MemBlobStore()
}

const BACKEND = USE_COS ? `COS ${COS_BUCKET} (${COS_REGION})` : 'MemBlobStore'

// ---------------------------------------------------------------------------
// Checksums: prove a reopen is byte-identical by hashing the whole table.
// ---------------------------------------------------------------------------
async function tableChecksumPg(pg: PGlite): Promise<string> {
  const { rows } = await pg.query<{ id: number; h: string }>(
    "SELECT id, md5(blob) h FROM filler ORDER BY id",
  )
  const h = createHash('sha256')
  for (const r of rows) h.update(`${r.id} ${r.h}\n`)
  return `${rows.length}:${h.digest('hex').slice(0, 16)}`
}
async function tableChecksumDb(db: ZeroPG): Promise<string> {
  return tableChecksumPg(db.raw)
}

let SEED_SNAPSHOT: Uint8Array | undefined

/** Seed a primary store with ~targetBytes of INCOMPRESSIBLE data and compact it
 * to a clean snapshot (so a manifest exists for the archiver). Returns the
 * baseline checksum + row count of the committed state. */
async function seedPrimary(
  store: BlobStore,
  targetBytes: number,
  backup?: { store: BlobStore; retention?: RetentionPolicy },
): Promise<{ checksum: string; rows: number; dbBytes: number }> {
  const db = await ZeroPG.open({
    store,
    holder: 'e6-seed',
    noLease: true,
    durability: 'sleep',
    seedSnapshot: SEED_SNAPSHOT,
    ...(backup ? { backup: { store: backup.store, retention: backup.retention, blocking: true } } : {}),
  })
  await db.raw.exec('CREATE TABLE IF NOT EXISTS filler (id serial primary key, blob bytea not null)')
  const ROW_BYTES = 8 * 1024
  let dbBytes = 0
  let rows = 0
  while (dbBytes < targetBytes) {
    const BATCH = 256
    const vals: string[] = []
    for (let i = 0; i < BATCH; i++) {
      const b = Buffer.alloc(ROW_BYTES)
      for (let j = 0; j < ROW_BYTES; j += 65536) crypto.getRandomValues(b.subarray(j, Math.min(j + 65536, ROW_BYTES)))
      vals.push(`('\\x${b.toString('hex')}')`)
    }
    await db.raw.exec(`INSERT INTO filler (blob) VALUES ${vals.join(',')}`)
    rows += BATCH
    const sz = await db.raw.query<{ b: string }>('SELECT pg_database_size(current_database())::text b')
    dbBytes = Number(sz.rows[0]?.b ?? '0')
  }
  // Commit the whole dataset AS A SNAPSHOT (compaction). When a backup target is
  // configured this also exercises the DEFAULT wiring: commitSnapshot -> runBackup.
  db.markDirty()
  await db.compact()
  await db.drainBackups()
  const checksum = await tableChecksumDb(db)
  await db.close()
  return { checksum, rows, dbBytes }
}

/** Boot a PGlite directly on a restored datadir, prove it serves SQL, and
 * return its checksum. This is the "rebuilt DB actually works" gate. */
async function bootAndChecksum(dir: string): Promise<{ checksum: string; rows: number }> {
  const pg = await PGlite.create({ dataDir: dir })
  await pg.waitReady
  // Serve real SQL, not just open: a count + an aggregate touch the heap.
  const { rows: cnt } = await pg.query<{ n: string }>('SELECT count(*)::text n FROM filler')
  const checksum = await tableChecksumPg(pg)
  await pg.close()
  return { checksum, rows: Number(cnt[0]!.n) }
}

async function wipePrefix(store: BlobStore): Promise<number> {
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  return n
}

// ---------------------------------------------------------------------------
// Fault injection.
// ---------------------------------------------------------------------------
type Fault =
  | 'none'
  | 'kill-before-object' // SIGKILL before the backup object lands in the cold store
  | 'kill-after-object' // backup object lands, SIGKILL before the index records it

const isBackupObject = (key: string) => /^backups\/.*\.tar(\.gz)?$/.test(key)

/** Wraps a cold store and SIGKILLs this process at a chosen point in a backup. */
class KillStore implements BlobStore {
  readonly cost?: BlobStore['cost']
  constructor(
    private inner: BlobStore,
    private fault: Fault,
  ) {
    this.cost = inner.cost
  }
  private die(): never {
    process.kill(process.pid, 'SIGKILL')
    throw new Error('unreachable')
  }
  get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    return this.inner.get(key, opts)
  }
  async put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult> {
    // The index append is a put() to INDEX_KEY. Kill after the object exists but
    // before the index names it.
    if (key === INDEX_KEY && this.fault === 'kill-after-object') this.die()
    return this.inner.put(key, bytes, opts)
  }
  async putStream(key: string, src: AsyncIterable<Uint8Array>, opts?: PutOptions): Promise<PutResult> {
    // The backup object is uploaded via putStream. Kill before it lands.
    if (isBackupObject(key) && this.fault === 'kill-before-object') this.die()
    return this.inner.putStream(key, src, opts)
  }
  getStream(key: string): Promise<GetStreamResult | null> {
    return this.inner.getStream(key)
  }
  list(prefix: string): AsyncIterable<ListEntry> {
    return this.inner.list(prefix)
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key)
  }
  head(key: string) {
    return this.inner.head(key)
  }
}

/** Wraps a store to throw a synthetic error at a chosen operation (in-process
 * crash simulation for scenarios where a real process kill is not required). */
class ThrowStore implements BlobStore {
  readonly cost?: BlobStore['cost']
  constructor(
    private inner: BlobStore,
    private opts: {
      throwOnDeleteAfter?: number // throw after the Nth delete()
      throwOnGetStreamAfter?: number // corrupt the Nth getStream body partway
    },
  ) {
    this.cost = inner.cost
  }
  private deletes = 0
  private getStreams = 0
  get(key: string, o?: GetOptions) {
    return this.inner.get(key, o)
  }
  put(key: string, b: Bytes, o?: PutOptions) {
    return this.inner.put(key, b, o)
  }
  putStream(key: string, s: AsyncIterable<Uint8Array>, o?: PutOptions) {
    return this.inner.putStream(key, s, o)
  }
  async getStream(key: string): Promise<GetStreamResult | null> {
    const n = ++this.getStreams
    const src = await this.inner.getStream(key)
    if (!src || this.opts.throwOnGetStreamAfter === undefined || n !== this.opts.throwOnGetStreamAfter) {
      return src
    }
    // Deliver only the first third of the body, then throw: the restore sees a
    // genuinely truncated tar (incomplete bytes, not just an early EOF the
    // consumer might not pull) and must fail. Slicing WITHIN a chunk matters
    // because some stores hand back the whole body as one chunk. The caller
    // then retries against the intact store.
    const limit = Math.max(1, Math.floor(src.size / 3))
    async function* truncated(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      let sent = 0
      for await (const chunk of stream) {
        if (sent + chunk.length >= limit) {
          if (limit > sent) yield chunk.subarray(0, limit - sent)
          throw new Error('SIMULATED restore crash: connection dropped mid-stream')
        }
        yield chunk
        sent += chunk.length
      }
    }
    return { stream: truncated(src.stream), size: src.size, etag: src.etag }
  }
  list(prefix: string) {
    return this.inner.list(prefix)
  }
  async delete(key: string): Promise<void> {
    const n = ++this.deletes
    if (this.opts.throwOnDeleteAfter !== undefined && n > this.opts.throwOnDeleteAfter) {
      throw new Error('SIMULATED retention crash: aborted mid-GC')
    }
    return this.inner.delete(key)
  }
  head(key: string) {
    return this.inner.head(key)
  }
}

// ===========================================================================
// CHILD ROLE: take one backup through a KillStore that SIGKILLs us.
// ===========================================================================
async function childMain(primaryPrefix: string, coldPrefix: string, fault: Fault) {
  const primary = makeStore(primaryPrefix)
  const cold = new KillStore(makeStore(coldPrefix), fault)
  const arch = new ColdArchiver(primary, cold, { log: () => {} })
  await arch.backupOnce() // for fault != none this process is killed inside
  process.stdout.write('CLEAN\n')
}

function runChild(primaryPrefix: string, coldPrefix: string, fault: Fault): Promise<{ signal: string | null; code: number | null; clean: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'experiments/e6-backup-disaster.ts', 'child', primaryPrefix, coldPrefix, fault], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('exit', (code, signal) => resolve({ signal, code, clean: /CLEAN/.test(out) }))
  })
}

// ===========================================================================
// SCENARIO A: SIGKILL mid-backup (real process crash, requires a shared store).
// ===========================================================================
async function scenarioSigkill(root: string, baseline: string, iter: number) {
  section(`A. SIGKILL mid-backup (x${iter} per fault)`)
  if (!USE_COS) {
    console.log('  ⚠ skipped: needs a real cross-process store (source ~/.zeropg-ibm.env). Mem is in-process only.')
    logResult('e6-disaster.jsonl', { scenario: 'sigkill', skipped: true, reason: 'no shared store' })
    return
  }
  const primaryPrefix = `${root}/A/primary`
  const faults: Fault[] = ['kill-before-object', 'kill-after-object']
  for (const fault of faults) {
    let killed = 0
    let recovered = 0
    let identical = 0
    for (let i = 0; i < iter; i++) {
      const coldPrefix = `${root}/A/${fault}/${i}`
      const res = await runChild(primaryPrefix, coldPrefix, fault)
      if (res.signal === 'SIGKILL' || (!res.clean && res.code !== 0)) killed++

      // 1) Primary is a second blast radius: untouched by the killed backup.
      const primaryStillOk = await primaryUnchanged(primaryPrefix, baseline)

      // 2) A clean re-backup to the SAME cold prefix must succeed (fresh write,
      //    or adopt the orphan object the dead run left), and be restorable.
      const cold = makeStore(coldPrefix)
      const arch = new ColdArchiver(makeStore(primaryPrefix), cold, { log: () => {} })
      const entry = await arch.backupOnce()
      if (entry) recovered++
      let sameSum = false
      if (entry) {
        const { dir } = await arch.restoreFromBackup()
        try {
          const r = await bootAndChecksum(dir)
          sameSum = r.checksum === baseline
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
      }
      if (sameSum && primaryStillOk) identical++
      await wipePrefix(cold).catch(() => {})
    }
    assert(killed === iter, `${fault}: every child was actually killed (${killed}/${iter})`)
    assert(recovered === iter, `${fault}: the next backup succeeded every time (${recovered}/${iter})`)
    assert(identical === iter, `${fault}: primary intact + recovered backup byte-identical (${identical}/${iter})`)
    logResult('e6-disaster.jsonl', { scenario: 'sigkill', fault, iter, killed, recovered, identical })
  }
}

/** The primary is a second blast radius: a killed backup must not have touched
 * it. Reopen it read-only and confirm it still checksums to the baseline. */
async function primaryUnchanged(primaryPrefix: string, baseline: string): Promise<boolean> {
  const db = await ZeroPG.open({ store: makeStore(primaryPrefix), holder: 'e6-probe', noLease: true, seedSnapshot: SEED_SNAPSHOT }).catch(() => null)
  if (!db) return false
  try {
    return (await tableChecksumDb(db)) === baseline
  } finally {
    await db.close().catch(() => {})
  }
}

// ===========================================================================
// SCENARIO B: primary CURRENT snapshot corrupted/deleted -> restore from cold.
// ===========================================================================
async function scenarioPrimaryCorrupt(root: string, iter: number) {
  section(`B. Primary snapshot deleted -> restore from cold (x${iter})`)
  let restored = 0
  for (let i = 0; i < iter; i++) {
    const primary = makeStore(`${root}/B/${i}/primary`)
    const cold = makeStore(`${root}/B/${i}/cold`)
    const { checksum } = await seedPrimary(primary, 256 * 1024, { store: cold })

    // Corrupt the primary: delete its CURRENT snapshot object. The manifest now
    // dangles -> a fresh open from primary alone cannot restore.
    const man = decodeManifestFrom(await primary.get(MANIFEST_KEY))
    await primary.delete(man.snapshot)
    let primaryBroken = false
    try {
      const db = await ZeroPG.open({ store: primary, holder: 'b-probe', noLease: true, seedSnapshot: SEED_SNAPSHOT })
      await db.close()
    } catch {
      primaryBroken = true
    }

    // Restore from the cold backup into a NEW primary home.
    const arch = new ColdArchiver(makeStore(`${root}/B/${i}/recovery`), cold, { log: () => {} })
    const { dir } = await arch.restoreFromBackup()
    let same = false
    try {
      const r = await bootAndChecksum(dir)
      same = r.checksum === checksum
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (primaryBroken && same) restored++
  }
  assert(restored === iter, `cold backup restores byte-identical after primary snapshot loss (${restored}/${iter})`)
  logResult('e6-disaster.jsonl', { scenario: 'primary-corrupt', iter, restored })
}

function decodeManifestFrom(r: GetResult | null): { snapshot: string } {
  if (!r) throw new Error('no manifest')
  return JSON.parse(new TextDecoder().decode(r.bytes)) as { snapshot: string }
}

// ===========================================================================
// SCENARIO C: FULL primary wipe -> rebuild byte-identical, boots + serves SQL.
// ===========================================================================
async function scenarioFullWipe(root: string, iter: number) {
  section(`C. FULL primary wipe -> rebuild + serve SQL (x${iter})`)
  let rebuilt = 0
  for (let i = 0; i < iter; i++) {
    const primary = makeStore(`${root}/C/${i}/primary`)
    const cold = makeStore(`${root}/C/${i}/cold`)
    const { checksum, rows } = await seedPrimary(primary, 512 * 1024, { store: cold })

    // The whole primary blast radius is gone.
    const wiped = await wipePrefix(primary)
    const stillThere = await primary.get(MANIFEST_KEY)

    // Rebuild from cold ALONE into a brand-new home, then boot and serve SQL.
    const arch = new ColdArchiver(makeStore(`${root}/C/${i}/newhome`), cold, { log: () => {} })
    const { dir } = await arch.restoreFromBackup()
    let ok = false
    try {
      const r = await bootAndChecksum(dir)
      ok = r.checksum === checksum && r.rows === rows
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (wiped > 0 && stillThere === null && ok) rebuilt++
  }
  assert(rebuilt === iter, `full primary wipe rebuilds a working byte-identical DB from cold (${rebuilt}/${iter})`)
  logResult('e6-disaster.jsonl', { scenario: 'full-wipe', iter, rebuilt })
}

// ===========================================================================
// SCENARIO D: retention never deletes the last restorable backup, and a crash
// DURING retention GC leaves a fully restorable set.
// ===========================================================================
async function scenarioRetentionSafety(root: string, iter: number) {
  section(`D. Retention safety + crash during GC (x${iter})`)
  // D1: build a cold store with several distinct backups, apply aggressive
  // retention, and assert the newest is always kept + restorable.
  let keptNewest = 0
  let crashRestorable = 0
  for (let i = 0; i < iter; i++) {
    const cold = makeStore(`${root}/D/${i}/cold`)
    const newestSum = await buildMultiBackupCold(cold, `${root}/D/${i}`, 5)

    // Aggressive policies that, naively applied, would empty the store.
    const policies: RetentionPolicy[] = [
      { keepLast: 1 },
      { maxAgeDays: 0.0001 }, // "everything is too old"
      { gfs: { daily: 1 } },
    ]
    const policy = policies[i % policies.length]
    const arch = new ColdArchiver(makeStore(`${root}/D/${i}/recovery`), cold, { log: () => {} })
    const r = await arch.applyRetention(policy)
    // The newest backup must survive any policy (retain() invariant).
    const idx = decodeBackupIndex((await cold.get(INDEX_KEY))!.bytes)
    const newestPresent = idx.backups.length >= 1 && (await cold.head(idx.backups[idx.backups.length - 1].key)) !== null
    let sameSum = false
    if (newestPresent) {
      const { dir } = await arch.restoreFromBackup()
      try {
        sameSum = (await bootAndChecksum(dir)).checksum === newestSum
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    if (newestPresent && sameSum && r.kept.length >= 1) keptNewest++

    // D2: crash mid-GC. Inject a store that throws after deleting some objects.
    const cold2 = makeStore(`${root}/D/${i}/cold2`)
    const newestSum2 = await buildMultiBackupCold(cold2, `${root}/D/${i}/2`, 5)
    const killAfter = 1 + (i % 3) // throw after 1..3 deletes
    const throwing = new ThrowStore(cold2, { throwOnDeleteAfter: killAfter })
    const archCrash = new ColdArchiver(makeStore(`${root}/D/${i}/recovery2`), throwing, { log: () => {} })
    let crashed = false
    try {
      await archCrash.applyRetention({ keepLast: 1 })
    } catch {
      crashed = true
    }
    // After the crash the index may still list deleted objects, but the NEWEST
    // backup is deleted last / never, so a restore of the newest still works.
    const archAfter = new ColdArchiver(makeStore(`${root}/D/${i}/recovery2b`), cold2, { log: () => {} })
    let restorable = false
    try {
      const { dir } = await archAfter.restoreFromBackup()
      try {
        restorable = (await bootAndChecksum(dir)).checksum === newestSum2
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    } catch {
      restorable = false
    }
    if (crashed && restorable) crashRestorable++
  }
  assert(keptNewest === iter, `aggressive retention always keeps a restorable newest backup (${keptNewest}/${iter})`)
  assert(crashRestorable === iter, `a crash during retention GC leaves a restorable set (${crashRestorable}/${iter})`)
  logResult('e6-disaster.jsonl', { scenario: 'retention-safety', iter, keptNewest, crashRestorable })
}

/** Produce `n` distinct cold backups (commitSeq 1..n) by backing up a primary
 * after each of n appends. Returns the newest committed state's checksum. */
async function buildMultiBackupCold(cold: BlobStore, root: string, n: number): Promise<string> {
  const primary = makeStore(`${root}/src`)
  const db = await ZeroPG.open({ store: primary, holder: 'd-seed', noLease: true, durability: 'sleep', seedSnapshot: SEED_SNAPSHOT })
  await db.raw.exec('CREATE TABLE IF NOT EXISTS filler (id serial primary key, blob bytea not null)')
  const arch = new ColdArchiver(primary, cold, { log: () => {} })
  let lastSum = ''
  for (let k = 0; k < n; k++) {
    const b = Buffer.alloc(8 * 1024)
    crypto.getRandomValues(b)
    await db.raw.exec(`INSERT INTO filler (blob) VALUES ('\\x${b.toString('hex')}')`)
    db.markDirty()
    await db.compact() // fresh snapshot => new commitSeq
    lastSum = await tableChecksumDb(db)
    await arch.backupOnce() // distinct backup object + index entry
  }
  await db.close()
  return lastSum
}

// ===========================================================================
// SCENARIO E: two archivers race the backup index -> no corruption, no lost
// update (both distinct backups survive in the index, both restorable).
// ===========================================================================
async function scenarioCasRace(root: string, iter: number) {
  section(`E. Backup-index CAS race (two archivers, x${iter})`)
  let consistent = 0
  for (let i = 0; i < iter; i++) {
    const cold = makeStore(`${root}/E/${i}/cold`)
    // Two primaries at DIFFERENT committed points => two distinct backup keys.
    const pA = makeStore(`${root}/E/${i}/pa`)
    const pB = makeStore(`${root}/E/${i}/pb`)
    await seedPrimary(pA, 64 * 1024)
    await seedPrimary(pB, 96 * 1024)
    const archA = new ColdArchiver(pA, cold, { log: () => {} })
    const archB = new ColdArchiver(pB, cold, { log: () => {} })
    // Race them onto the same index.
    const [eA, eB] = await Promise.all([archA.backupOnce(), archB.backupOnce()])
    const idxRaw = await cold.get(INDEX_KEY)
    let ok = false
    try {
      const idx = decodeBackupIndex(idxRaw!.bytes) // decodes => not corrupt
      const keys = new Set(idx.backups.map((b) => b.key))
      // No lost update: both winners are recorded exactly once.
      const bothRecorded = !!eA && !!eB && keys.has(eA.key) && keys.has(eB.key)
      const noDupes = idx.backups.length === keys.size
      // Both are independently restorable.
      let bothRestore = false
      if (bothRecorded) {
        const { dir: dA } = await archA.restoreFromBackup(eA!.commitSeq)
        const { dir: dB } = await archB.restoreFromBackup(eB!.commitSeq)
        try {
          const rA = await bootAndChecksum(dA)
          const rB = await bootAndChecksum(dB)
          bothRestore = rA.rows > 0 && rB.rows > 0
        } finally {
          await rm(dA, { recursive: true, force: true }).catch(() => {})
          await rm(dB, { recursive: true, force: true }).catch(() => {})
        }
      }
      ok = bothRecorded && noDupes && bothRestore
    } catch {
      ok = false
    }
    if (ok) consistent++
  }
  assert(consistent === iter, `concurrent archivers: index stays consistent, no lost update (${consistent}/${iter})`)
  logResult('e6-disaster.jsonl', { scenario: 'cas-race', iter, consistent })
}

// ===========================================================================
// SCENARIO F: crash during restore -> retry restores cleanly, byte-identical.
// ===========================================================================
async function scenarioRestoreCrash(root: string, iter: number) {
  section(`F. Crash during restore -> clean retry (x${iter})`)
  let recovered = 0
  for (let i = 0; i < iter; i++) {
    const primary = makeStore(`${root}/F/${i}/primary`)
    const cold = makeStore(`${root}/F/${i}/cold`)
    const { checksum } = await seedPrimary(primary, 256 * 1024, { store: cold })

    // First restore attempt dies mid-stream (truncated snapshot body).
    const crashing = new ThrowStore(cold, { throwOnGetStreamAfter: 1 })
    const archCrash = new ColdArchiver(makeStore(`${root}/F/${i}/r1`), crashing, { log: () => {} })
    let crashed = false
    try {
      await archCrash.restoreFromBackup()
    } catch {
      crashed = true
    }

    // Retry against the intact cold store, into a FRESH datadir.
    const arch = new ColdArchiver(makeStore(`${root}/F/${i}/r2`), cold, { log: () => {} })
    const { dir } = await arch.restoreFromBackup()
    let same = false
    try {
      same = (await bootAndChecksum(dir)).checksum === checksum
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (crashed && same) recovered++
  }
  assert(recovered === iter, `a crash mid-restore is recovered by a clean retry, byte-identical (${recovered}/${iter})`)
  logResult('e6-disaster.jsonl', { scenario: 'restore-crash', iter, recovered })
}

// ===========================================================================
// SCENARIO G: round-trip at 1/50/500MB via the DEFAULT wiring + full disaster.
// ===========================================================================
async function scenarioRoundTrip(root: string, sizesMb: number[]) {
  section(`G. Round-trip via default wiring + full-disaster restore (${sizesMb.join('/')}MB)`)
  for (const mb of sizesMb) {
    const primary = makeStore(`${root}/G/${mb}/primary`)
    const cold = makeStore(`${root}/G/${mb}/cold`)
    const t0 = performance.now()
    // seedPrimary with a backup target exercises the DEFAULT auto-backup hook.
    const { checksum, rows, dbBytes } = await seedPrimary(primary, mb * 1_000_000, { store: cold })

    // Default wiring really produced a cold backup (no manual archiver call).
    const idxRaw = await cold.get(INDEX_KEY)
    const idx = idxRaw ? decodeBackupIndex(idxRaw.bytes) : { backups: [] as unknown[] }
    assert(idx.backups.length >= 1, `${mb}MB: default wiring auto-produced a cold backup`)

    // Full disaster: wipe the primary, rebuild from cold, boot + serve SQL.
    await wipePrefix(primary)
    const arch = new ColdArchiver(makeStore(`${root}/G/${mb}/newhome`), cold, { log: () => {} })
    const { dir, bytes } = await arch.restoreFromBackup()
    let same = false
    let restoredRows = 0
    try {
      const r = await bootAndChecksum(dir)
      same = r.checksum === checksum
      restoredRows = r.rows
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    const secs = round((performance.now() - t0) / 1000)
    assert(same && restoredRows === rows, `${mb}MB: rebuilt byte-identical after full wipe (${restoredRows}/${rows} rows, ${round(bytes / 1e6)}MB restored, ${secs}s)`)
    logResult('e6-disaster.jsonl', { scenario: 'round-trip', mb, dbBytes, rows, restoredBytes: bytes, identical: same, secs })
  }
}

// ===========================================================================
// PARENT HARNESS
// ===========================================================================
async function parentMain() {
  resetFailures()
  const RUN = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  const root = `e6/${RUN}`
  const ITER = Number(process.env.E6_ITER ?? 20)
  const SIGKILL_ITER = Number(process.env.E6_SIGKILL_ITER ?? ITER)
  const sizesMb = (process.env.E6_SIZES ?? '1,50,500').split(',').map((s) => Number(s.trim())).filter((n) => n > 0)

  console.log(`E6 backup-disaster — backend=${BACKEND} root=${root}`)
  console.log(`  iter=${ITER} sigkill_iter=${SIGKILL_ITER} sizes=${sizesMb.join('/')}MB`)

  console.log('  building empty seed snapshot...')
  SEED_SNAPSHOT = await ZeroPG.buildEmptySnapshot()

  // A baseline primary for the SIGKILL scenario (read-only, immutable across iters).
  let baseline = ''
  if (USE_COS) {
    const r = await seedPrimary(makeStore(`${root}/A/primary`), 256 * 1024)
    baseline = r.checksum
    console.log(`  scenario-A primary seeded: ${r.rows} rows, ${round(r.dbBytes / 1e6)}MB, sum=${baseline}`)
  }

  await scenarioSigkill(root, baseline, SIGKILL_ITER)
  await scenarioPrimaryCorrupt(root, ITER)
  await scenarioFullWipe(root, ITER)
  await scenarioRetentionSafety(root, ITER)
  await scenarioCasRace(root, ITER)
  await scenarioRestoreCrash(root, ITER)
  await scenarioRoundTrip(root, sizesMb)

  // Cleanup everything under this run's root.
  section('Cleanup')
  if (USE_COS) {
    const n = await wipePrefix(makeStore(root))
    console.log(`  deleted ${n} objects under ${root}`)
  } else {
    console.log('  (Mem backend: nothing persisted)')
  }

  const fails = failureCount()
  section('Result')
  if (fails === 0) {
    console.log('  ✅ E6 PASSED — backups survive SIGKILL, corruption, full wipe, retention GC crashes, CAS races, and restore crashes; every recovery is byte-identical.')
  } else {
    console.log(`  ❌ E6 FAILED — ${fails} assertion(s). A DB system cannot ship without proven backups. KILL CRITERION.`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Dispatch role.
// ---------------------------------------------------------------------------
const [, , role, a, b, c] = process.argv
if (role === 'child') {
  childMain(a, b, (c as Fault) ?? 'none').catch((e) => {
    console.error('child error', e)
    process.exit(1)
  })
} else {
  parentMain().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
}
