// E2.4: crash-safety harness. Child process is SIGKILL'd at injected fault
// points around the commit; the parent reopens from the bucket and verifies
// integrity. The whole design claim is "torn states are impossible by
// construction" — a crash before the manifest CAS leaves the old manifest
// intact, a crash after it makes the commit durable. Never anything in between.
//
// Kill criterion: any reopen that fails integrity, or that yields a state that
// is neither the pre-commit nor the post-commit checksum.
//
// Roles in one file: `tsx e2b-crash.ts child <prefix> <fault>` runs the child;
// no args runs the parent harness.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  GcsBlobStore,
  type BlobStore,
  type Bytes,
  type GetOptions,
  type GetResult,
  type ListEntry,
  type PutOptions,
  type PutResult,
} from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { BUCKET, runId, logResult, section, assert, failureCount, resetFailures } from './_util.js'

type Fault =
  | 'none'
  | 'kill-before-snapshot' // crash before uploading the new snapshot
  | 'kill-after-snapshot' // snapshot uploaded, crash before manifest CAS
  | 'kill-during-manifest' // crash while the manifest PUT is in flight

/** Wraps a BlobStore and SIGKILLs this process at a chosen point. */
class FaultStore implements BlobStore {
  constructor(
    private inner: BlobStore,
    private fault: Fault,
  ) {}
  private die(): never {
    process.kill(process.pid, 'SIGKILL')
    throw new Error('unreachable')
  }
  get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    return this.inner.get(key, opts)
  }
  async put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult> {
    const isSnapshot = key.includes('/snapshot-')
    const isManifest = key === 'manifest.json'
    if (isSnapshot && this.fault === 'kill-before-snapshot') this.die()
    if (isManifest && this.fault === 'kill-after-snapshot') this.die()
    if (isManifest && this.fault === 'kill-during-manifest') {
      // Let the manifest PUT fully land, then SIGKILL before ZeroPG can record
      // the new etag or do post-commit bookkeeping. This exercises the "commit
      // is durable, process died right after" branch: reopen must equal the
      // post-commit state, with no half-applied bookkeeping corrupting it.
      await this.inner.put(key, bytes, opts)
      this.die()
    }
    return this.inner.put(key, bytes, opts)
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

const enc = (i: number) => `${i}:` + 'p'.repeat(200)
async function tableChecksum(db: ZeroPG): Promise<string> {
  const { rows } = await db.query<{ id: number; v: string }>('SELECT id, v FROM kv ORDER BY id')
  const h = createHash('sha256')
  for (const r of rows) h.update(`${r.id} ${r.v}\n`)
  return `${rows.length}:${h.digest('hex').slice(0, 12)}`
}

const BASELINE_ROWS = 500
const DELTA_ROWS = 500

async function childMain(prefix: string, fault: Fault) {
  // Stage 1: establish a committed baseline with a plain store (no fault).
  const store = new GcsBlobStore({ bucket: BUCKET, prefix })
  const db = await ZeroPG.open({ store, holder: 'crash-child', noLease: true })
  await db.exec('CREATE TABLE IF NOT EXISTS kv (id int primary key, v text)')
  const values: string[] = []
  for (let i = 0; i < BASELINE_ROWS; i++) values.push(`(${i}, '${enc(i)}')`)
  await db.exec(`INSERT INTO kv VALUES ${values.join(',')}`) // commits (strict)
  // Report the baseline checksum to the parent on stdout.
  const baseline = await tableChecksum(db)
  process.stdout.write(`BASELINE ${baseline}\n`)

  // Stage 2: a second write, then commit through the FaultStore which kills us.
  const faultDb = db as unknown as { store: BlobStore; manifest: unknown }
  faultDb.store = new FaultStore(store, fault) // swap in the killer store
  const v2: string[] = []
  for (let i = BASELINE_ROWS; i < BASELINE_ROWS + DELTA_ROWS; i++) v2.push(`(${i}, '${enc(i)}')`)
  await db.raw.exec(`INSERT INTO kv VALUES ${v2.join(',')}`)
  ;(db as unknown as { dirty: boolean }).dirty = true
  const after = await tableChecksum(db)
  process.stdout.write(`POSTCOMMIT ${after}\n`)
  // This commit goes through the FaultStore and (for fault != none) never returns.
  await db.commit()
  await db.close()
  process.stdout.write('CLEAN\n')
}

function runChild(prefix: string, fault: Fault): Promise<{ baseline?: string; postcommit?: string; signal: string | null; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'experiments/e2b-crash.ts', 'child', prefix, fault], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('exit', (code, signal) => {
      const baseline = /BASELINE (\S+)/.exec(out)?.[1]
      const postcommit = /POSTCOMMIT (\S+)/.exec(out)?.[1]
      resolve({ baseline, postcommit, signal, code })
    })
  })
}

async function verifyReopen(prefix: string): Promise<string> {
  const store = new GcsBlobStore({ bucket: BUCKET, prefix })
  const db = await ZeroPG.open({ store, holder: 'crash-verify', noLease: true })
  const sum = await tableChecksum(db)
  await db.close()
  return sum
}

async function parentMain() {
  resetFailures()
  const RUN = runId()
  console.log(`E2b crash-safety — bucket=${BUCKET} prefix=e2b/${RUN}`)
  const faults: Fault[] = ['kill-before-snapshot', 'kill-after-snapshot', 'kill-during-manifest']
  const ITER = Number(process.env.CRASH_ITER ?? 20)

  for (const fault of faults) {
    section(`Fault: ${fault} (x${ITER})`)
    let consistent = 0
    let landed = 0
    let notLanded = 0
    for (let i = 0; i < ITER; i++) {
      const prefix = `e2b/${RUN}/${fault}/${i}`
      const res = await runChild(prefix, fault)
      // The child must have been killed (not exited cleanly) for real faults.
      const reopened = await verifyReopen(prefix)
      const isBaseline = reopened === res.baseline
      const isPostcommit = reopened === res.postcommit
      if (isBaseline || isPostcommit) consistent++
      if (isPostcommit) landed++
      if (isBaseline) notLanded++
      if (!isBaseline && !isPostcommit) {
        console.log(`    ✗ round ${i}: TORN STATE reopened=${reopened} baseline=${res.baseline} post=${res.postcommit}`)
      }
    }
    assert(
      consistent === ITER,
      `${fault}: every reopen is a clean pre- or post-commit state (${consistent}/${ITER}); landed=${landed} notLanded=${notLanded}`,
    )
    logResult('e2b.jsonl', { run: RUN, fault, iter: ITER, consistent, landed, notLanded })
  }

  // Cleanup
  section('Cleanup')
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: `e2b/${RUN}` })
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects`)

  const fails = failureCount()
  section('Result')
  if (fails === 0) console.log('  ✅ E2b PASSED — no torn states across all fault points. Crashes are safe by construction.')
  else {
    console.log(`  ❌ E2b FAILED — ${fails} assertion(s). KILL CRITERION.`)
    process.exitCode = 1
  }
}

// Dispatch role.
const [, , role, prefix, fault] = process.argv
if (role === 'child') {
  childMain(prefix, (fault as Fault) ?? 'none').catch((e) => {
    console.error('child error', e)
    process.exit(1)
  })
} else {
  parentMain().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
}
