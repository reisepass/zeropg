// loadtest-contention — prove the single-writer lease under REAL concurrent
// contention, with a real app, multiple OS processes, and one shared GCS prefix.
//
// This is the thing we had only unit-tested. Here N independent writer
// processes all open ZeroPG against the SAME bucket prefix and continuously
// append to a hash-chained ledger (experiments/loadtest-service/ledger.ts). At
// most one of them can hold the lease and commit at any instant; the rest are
// fenced or waiting. The writers deliberately churn — clean releases, simulated
// crashes (exit without flush), and zombie stalls (stop renewing past the lease
// TTL while still alive, then try to commit) — to drive every takeover path:
//
//   * clean handoff   : holder releases -> waiter acquires fresh (token + 1)
//   * crash handoff   : holder exits dirty -> waiter waits TTL, takes over,
//                       fence-stamps the manifest (token + 1)
//   * zombie split    : holder stalls past TTL, a sibling takes over, then the
//                       zombie wakes and tries to commit -> MUST get FencedError
//                       and its orphaned WAL upload must never enter the chain
//
// A separate LEASELESS verifier process (ZeroPGReplica) polls the bucket and
// re-derives the whole chain continuously. If ZeroPG's lease is correct the
// chain is unbreakable no matter how hard the writers fight: dense seq, no
// fork, no fence regression, every row hash round-trips. The first crack is a
// real bug — verifyChain() names it.
//
// Roles (argv[2]): 'orchestrator' (default) forks the writers + verifier and
// runs the experiment; 'writer <id>' and 'verifier' are the child processes.
//
//   npx tsx experiments/loadtest-contention.ts [orchestrator]
//   env: ZEROPG_PREFIX (default demo/loadtest-stress), LOADTEST_WRITERS (4),
//        LOADTEST_SECONDS (900), LOADTEST_TTL_MS (8000), LOADTEST_COMMIT_MS (350)

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GcsBlobStore } from '@zeropg/blobstore'
import {
  ZeroPG,
  ZeroPGReplica,
  FencedError,
  LockedError,
  MANIFEST_KEY,
  decodeManifest,
} from '@zeropg/objectstore-fs'
import {
  LEDGER_DDL,
  appendRow,
  verifyChain,
  type ChainVerdict,
} from './loadtest-service/ledger.js'

const HERE = fileURLToPath(import.meta.url)

// ---- config ----
const BUCKET = process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'
// The prefix children actually use. The orchestrator resolves a UNIQUE prefix
// per run (base + run id) and pins it into the child env as ZEROPG_PREFIX_RESOLVED
// so writers + verifier all agree on it. Why unique-per-run matters: reusing a
// prefix across a hard-killed run leaves a half-committed manifest + a second
// generation + a stale lease on it; the next run then races TWO manifest
// lineages and the verifier (correctly) reports fence regressions that are an
// artifact of the polluted prefix, not the lease. A fresh prefix per run makes
// every run start from a coherent empty state. Set LOADTEST_REUSE_PREFIX=1 to
// opt out (e.g. the cross-host run that must target a service's live prefix).
const PREFIX_BASE = process.env.ZEROPG_PREFIX ?? 'demo/loadtest-stress'
const N_WRITERS = Number(process.env.LOADTEST_WRITERS ?? 4)
const DURATION_S = Number(process.env.LOADTEST_SECONDS ?? 900)
const TTL_MS = Number(process.env.LOADTEST_TTL_MS ?? 8000)
const COMMIT_MS = Number(process.env.LOADTEST_COMMIT_MS ?? 350)
const RUN_ID = process.env.LOADTEST_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-')
const EVENTS = `results/loadtest-${RUN_ID}-events.jsonl`
const FAIL_MARKER = `results/loadtest-${RUN_ID}-FAIL.txt`
const REUSE_PREFIX = /^(1|true|on)$/i.test(process.env.LOADTEST_REUSE_PREFIX ?? '')

// Children receive the orchestrator's already-resolved prefix; the orchestrator
// computes it once (unique per run unless reuse is requested).
const PREFIX =
  process.env.ZEROPG_PREFIX_RESOLVED ??
  (REUSE_PREFIX ? PREFIX_BASE : `${PREFIX_BASE}-${RUN_ID}`)

function store(): GcsBlobStore {
  return new GcsBlobStore({ bucket: BUCKET, prefix: PREFIX })
}

// A prebuilt empty-datadir snapshot so a fresh DB skips the ~6.5s initdb — the
// orchestrator builds it once and hands the path to the children via env. This
// is what the deployed image ships too; without it the first boot dominates a
// short run and starves the writers.
const SEED_PATH = process.env.LOADTEST_SEED_PATH
function loadSeed(): Uint8Array | undefined {
  if (SEED_PATH && existsSync(SEED_PATH)) return new Uint8Array(readFileSync(SEED_PATH))
  return undefined
}

/** One atomic JSONL event line (appendFileSync of a sub-PIPE_BUF line is atomic
 * across processes on Linux — that's why every writer can share one file). */
function emit(obj: Record<string, unknown>): void {
  mkdirSync('results', { recursive: true })
  appendFileSync(EVENTS, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (base: number, spread: number) => base + Math.floor(Math.random() * spread)

// ======================================================================
// WRITER child: contend for the lease, append to the chain, churn.
// ======================================================================
async function runWriter(id: string): Promise<void> {
  const deadline = Date.now() + DURATION_S * 1000
  const holder = `writer-${id}-${process.pid}`
  let lives = 0
  let totalRows = 0

  while (Date.now() < deadline) {
    lives++
    const life = `${holder}#${lives}`
    let db: ZeroPG | null = null
    // Decide up front how this life ends, to exercise every handoff path.
    const ending = pickEnding()
    try {
      const t0 = Date.now()
      db = await ZeroPG.open({
        store: store(),
        holder: life,
        durability: 'strict', // every append is its own fenced manifest CAS
        leaseTtlMs: TTL_MS,
        acquireTimeoutMs: Math.max(0, deadline - Date.now()), // wait out the holder
        // Leave commitIntervalMs unset: it defaults from the store cost model
        // (GCS caps sustained writes per object at ~1/s, so the manifest CAS is
        // paced to ~1s). Forcing it lower just fights the cap with 429 backoff.
        seedSnapshot: loadSeed(),
        scratchDir: join(tmpdir(), `zeropg-loadtest-${process.pid}`),
      })
      const token = db.fencingToken ?? 0 // non-null right after a held acquire
      const acquiredAt = Date.now()
      emit({ ev: 'acquired', life, token, waitedMs: acquiredAt - t0 })
      await db.raw.exec(LEDGER_DDL)
      await db.raw.exec(
        'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, n BIGINT NOT NULL DEFAULT 0)',
      )

      // The life window starts AFTER boot, not at t0 — a slow cold boot (initdb,
      // a long lease wait) must not eat the whole window and starve the writer.
      const lifeEnd = Math.min(deadline, acquiredAt + jitter(15000, 25000))
      let rowsThisLife = 0
      while (Date.now() < lifeEnd) {
        // Re-validate on the request path (catches a silent takeover) then
        // append one chain row in strict mode (the manifest CAS fences a zombie).
        await db.validateLease()
        const fence = db.fencingToken ?? token
        const tip = await appendRow(db, life, fence, `row by ${life} @${Date.now()}`)
        // A bit of realistic mixed CRUD so the WAL isn't a single table.
        await db.query(
          'INSERT INTO kv (k,v,n) VALUES ($1,$2,1) ON CONFLICT (k) DO UPDATE SET v=excluded.v, n=kv.n+1',
          [`k${tip.seq % 32}`, `v${tip.seq}`],
        )
        rowsThisLife++
        totalRows++
        if (rowsThisLife % 25 === 0) emit({ ev: 'progress', life, token: fence, tipSeq: tip.seq })

        // Zombie stall: stop committing past the lease TTL while still alive.
        // A sibling should take over; our next append's CAS must be fenced.
        if (ending === 'zombie' && rowsThisLife === 8) {
          emit({ ev: 'zombie-stall', life, token: fence, stallMs: TTL_MS * 2 })
          await sleep(TTL_MS * 2 + 500)
          // fall through: the next loop iteration's validateLease/append must throw
        }
        await sleep(jitter(COMMIT_MS, COMMIT_MS))
      }

      emit({ ev: 'life-end', life, ending: ending === 'zombie' ? 'survived-zombie' : ending, rowsThisLife })
      if (ending === 'crash') {
        // Simulate a crash: ABANDON the engine without flush or lease release.
        // The lease object is left behind in the bucket; a sibling must wait it
        // out (TTL) and take over via CAS, incrementing the fencing token —
        // exactly the crash-takeover path. We do NOT process.exit() here: that
        // would permanently remove this writer from contention (a writer that
        // drew 'crash' on its first life would never contend again, quietly
        // draining the run), whereas a real fleet keeps replacing crashed
        // instances. So this process loops into a NEW life and re-contends,
        // while the orphaned lease + leaked scratch dir reproduce the crash's
        // externally-visible state. (In strict mode nothing is pending, so no
        // committed row is lost; this tests the takeover, not durability.)
        emit({ ev: 'crash-exit', life })
        db = null // drop the ref WITHOUT close(): lease dangles until TTL expiry
        await sleep(jitter(500, 1500))
        continue
      }
      await db.close() // clean release -> next writer acquires fresh
      db = null
    } catch (e) {
      const fenced = e instanceof FencedError
      const locked = e instanceof LockedError
      const io = isTransientIo(e)
      emit({
        // Three distinct classes, only the last of which is a real problem:
        //  · fenced/locked : the single-writer guarantee WORKING — this writer
        //    lost (or never got) the lease and was correctly refused. Expected
        //    on every churn path (clean handoff, crash takeover, zombie wakeup).
        //  · io-error      : a transport blip to the object store (fetch failed,
        //    reset, 5xx, timeout). Orthogonal to the lease guarantee — the
        //    bucket is the source of truth and the chain on it is unaffected;
        //    the writer just retries from a fresh open. Reported, not fatal.
        //  · error         : a non-fenced, non-locked, non-IO throw. The only
        //    genuinely unexpected kind; it fails the run.
        ev: fenced ? 'fenced' : locked ? 'locked' : io ? 'io-error' : 'error',
        life,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        expected: fenced || locked,
        whileZombie: ending === 'zombie',
      })
      // Discard stale local state and re-open from the bucket (never blind-retry).
      if (db) await db.close().catch(() => {})
      db = null
      if (!fenced && !locked) await sleep(io ? 1500 : 1000) // back off before retry
    }
    await sleep(jitter(200, 600))
  }
  emit({ ev: 'writer-done', holder, lives, totalRows })
}

function pickEnding(): 'clean' | 'crash' | 'zombie' {
  const r = Math.random()
  if (r < 0.25) return 'crash'
  if (r < 0.5) return 'zombie'
  return 'clean'
}

/** A transport-layer blip talking to the object store, NOT a lease/logic fault.
 * These are operational noise on a real network and say nothing about the
 * single-writer guarantee: the bucket is authoritative and the committed chain
 * on it is untouched, so the writer just re-opens. Classified apart from a real
 * unexpected error so a dropped TCP connection can't masquerade as an integrity
 * failure (and a real integrity failure can't hide as "just a network blip"). */
function isTransientIo(e: unknown): boolean {
  const msg = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).toLowerCase()
  const cause = e instanceof Error && e.cause ? String((e.cause as { code?: string }).code ?? e.cause).toLowerCase() : ''
  return (
    /fetch failed|network|socket|econnreset|econnrefused|etimedout|enotfound|eai_again|terminated|aborted|503|502|500|429|tls|und_err/.test(
      msg,
    ) || /econnreset|econnrefused|etimedout|enotfound|eai_again|und_err/.test(cause)
  )
}

// ======================================================================
// VERIFIER child: leaseless, continuous chain integrity check.
// ======================================================================
async function runVerifier(): Promise<void> {
  const deadline = Date.now() + DURATION_S * 1000 + 5000
  // Wait for the database to exist (first writer seeds it).
  let replica: ZeroPGReplica | null = null
  while (Date.now() < deadline && !replica) {
    try {
      replica = await ZeroPGReplica.open({ store: store(), pollIntervalMs: 3000 })
    } catch {
      await sleep(2000)
    }
  }
  if (!replica) {
    emit({ ev: 'verifier-no-db' })
    return
  }
  emit({ ev: 'verifier-up' })
  let checks = 0
  let lastSeq = 0
  while (Date.now() < deadline) {
    await sleep(4000)
    try {
      await replica.refresh() // pull the latest committed state, atomically swapped
      const v = await verifyChain(replica)
      checks++
      emit({
        ev: 'verify',
        seq: v.tipSeq,
        rows: v.rows,
        writers: v.writers.length,
        maxFence: v.maxFence,
        handovers: v.handovers,
        ok: v.ok,
        violations: v.violations.length,
      })
      if (!v.ok) {
        // Persistent, on a consistent committed snapshot -> a real bug.
        emit({ ev: 'INTEGRITY-VIOLATION', commitSeq: replica.commitSeq, verdict: v })
        writeFileSync(
          FAIL_MARKER,
          `INTEGRITY VIOLATION at commitSeq ${replica.commitSeq}\n` +
            JSON.stringify(v.violations, null, 2) + '\n',
        )
      }
      // Liveness sanity: the chain should advance while writers churn.
      if (v.tipSeq <= lastSeq && checks > 3) {
        emit({ ev: 'verify-stalled', tipSeq: v.tipSeq, lastSeq })
      }
      lastSeq = v.tipSeq
    } catch (e) {
      emit({ ev: 'verify-error', error: e instanceof Error ? e.message : String(e) })
    }
  }
  await replica.close().catch(() => {})
  emit({ ev: 'verifier-done', checks })
}

// ======================================================================
// ORCHESTRATOR: fork everyone, wait, then do the authoritative final verify.
// ======================================================================
async function runOrchestrator(): Promise<void> {
  mkdirSync('results', { recursive: true })
  console.log(
    `\n══ loadtest-contention ══════════════════════════════════════════\n` +
      `  bucket prefix : gs://${BUCKET}/${PREFIX}\n` +
      `  writers       : ${N_WRITERS}  (strict durability, all on ONE prefix)\n` +
      `  lease TTL      : ${TTL_MS}ms   commit pacing: ${COMMIT_MS}ms\n` +
      `  duration       : ${DURATION_S}s\n` +
      `  run id         : ${RUN_ID}\n` +
      `  events         : ${EVENTS}\n` +
      `═════════════════════════════════════════════════════════════════\n`,
  )

  // Build the empty-datadir seed once so every writer's fresh boot skips initdb.
  const seedPath = join(tmpdir(), `zeropg-loadtest-seed-${process.pid}.tar.gz`)
  console.log('  building empty-datadir seed snapshot…')
  writeFileSync(seedPath, await ZeroPG.buildEmptySnapshot())

  const childEnv = {
    ...process.env,
    LOADTEST_RUN_ID: RUN_ID,
    LOADTEST_SEED_PATH: seedPath,
    ZEROPG_PREFIX_RESOLVED: PREFIX, // pin the resolved prefix so all children agree
  }
  const fork = (role: string, ...args: string[]): ChildProcess => {
    const c = spawn('npx', ['tsx', HERE, role, ...args], {
      env: childEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    return c
  }

  const children: ChildProcess[] = []
  children.push(fork('verifier'))
  for (let i = 0; i < N_WRITERS; i++) {
    children.push(fork('writer', String(i + 1)))
    await sleep(500) // stagger boots so they race the seed/lease, not initdb
  }

  // Periodic console heartbeat from the events file so a long run is watchable.
  const hb = setInterval(() => printHeartbeat(), 30_000)

  await new Promise<void>((resolve) => {
    let alive = children.length
    for (const c of children) {
      c.on('exit', () => {
        if (--alive === 0) resolve()
      })
    }
    // Safety: hard stop a bit after the duration in case a child hangs.
    setTimeout(() => {
      for (const c of children) c.kill('SIGKILL')
      resolve()
    }, (DURATION_S + 120) * 1000)
  })
  clearInterval(hb)

  console.log('\n── all children exited; running authoritative final verify ──')
  const final = await authoritativeVerify()
  const summary = summarize(final)
  console.log(renderReport(summary, final))

  const passed =
    final.ok &&
    summary.tokensSortMonotonic &&
    summary.fenceSharedCommits === 0 &&
    summary.verifyViolations === 0 &&
    summary.errors === 0 &&
    !existsSync(FAIL_MARKER)
  logResult('loadtest-contention.jsonl', {
    runId: RUN_ID,
    prefix: PREFIX,
    writers: N_WRITERS,
    durationS: DURATION_S,
    ttlMs: TTL_MS,
    passed,
    ...summary,
    verdict: { ok: final.ok, violations: final.violations },
  })
  process.exit(passed ? 0 : 1)
}

/** The final word: open a fresh leaseless replica on the last committed state
 * and verify the entire chain. This is the snapshot the experiment stands on. */
async function authoritativeVerify(): Promise<ChainVerdict> {
  const replica = await ZeroPGReplica.open({ store: store(), pollIntervalMs: 0 })
  await replica.refresh()
  const v = await verifyChain(replica)
  await replica.close().catch(() => {})
  return v
}

interface Summary {
  acquisitions: number
  cleanReleases: number
  crashes: number
  zombieStalls: number
  fencedExpected: number // zombie woke and was correctly fenced
  fencedUnexpected: number
  lockedEvents: number
  errors: number // non-fenced, non-locked, non-IO throws (the only fatal kind)
  ioErrors: number // transient transport blips (reported, not fatal)
  maxToken: number
  tokensSortMonotonic: boolean // issued tokens, sorted, strictly increase
  fenceSharedCommits: number // committed rows sharing a token across writers
  verifyChecks: number
  verifyViolations: number
  chainRows: number
  chainWriters: number
  chainHandovers: number
  writesPerSec: number
}

function readEvents(): Record<string, unknown>[] {
  if (!existsSync(EVENTS)) return []
  return readFileSync(EVENTS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function summarize(final: ChainVerdict): Summary {
  const evs = readEvents()
  const count = (ev: string) => evs.filter((e) => e.ev === ev).length
  // Fencing-token invariant. The SAFETY property is "no two writers ever COMMIT
  // under the same token" — checked authoritatively on the committed chain
  // (verifyChain kind 'fence-shared') plus "fence never regresses along
  // committed history" ('fence-regression'). At the *issuance* level the only
  // sound check is that the DISTINCT issued tokens, sorted, strictly increase:
  // a clean release before any commit lets the next writer reuse floor+1, so a
  // token value CAN legitimately be issued to two lives (neither committed
  // under it) — that is benign and must not fail the run. So we test the sorted
  // distinct set, not raw distinctness, and not append order.
  const tokens = evs.filter((e) => e.ev === 'acquired').map((e) => Number(e.token))
  const distinctSorted = [...new Set(tokens)].sort((a, b) => a - b)
  let sortMonotonic = true
  for (let i = 1; i < distinctSorted.length; i++) {
    if (distinctSorted[i] <= distinctSorted[i - 1]) sortMonotonic = false
  }
  // Fatal = a throw that was neither fenced, locked, nor a transient transport
  // blip. io-errors are reported separately and never fail the run (they say
  // nothing about the single-writer guarantee — the bucket chain is untouched).
  const errors = evs.filter((e) => e.ev === 'error').length
  const ioErrors = evs.filter((e) => e.ev === 'io-error').length
  const fenced = evs.filter((e) => e.ev === 'fenced').length
  const locked = evs.filter((e) => e.ev === 'locked').length
  const verifyChecks = evs.filter((e) => e.ev === 'verify')
  // Wall-clock span of the run from first acquire to last verify/done.
  const ts = evs.map((e) => Date.parse(String(e.ts))).filter((n) => !isNaN(n))
  const spanS = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 1000 : 1
  return {
    acquisitions: count('acquired'),
    cleanReleases: evs.filter((e) => e.ev === 'life-end' && e.ending === 'clean').length,
    crashes: count('crash-exit'),
    zombieStalls: count('zombie-stall'),
    fencedExpected: fenced,
    fencedUnexpected: errors, // non-fenced/non-locked throws
    lockedEvents: locked,
    errors,
    ioErrors,
    maxToken: tokens.length ? Math.max(...tokens) : 0,
    tokensSortMonotonic: sortMonotonic,
    fenceSharedCommits: final.violations.filter((v) => v.kind === 'fence-shared').length,
    verifyChecks: verifyChecks.length,
    verifyViolations: verifyChecks.reduce((n, e) => n + Number(e.violations ?? 0), 0),
    chainRows: final.rows,
    chainWriters: final.writers.length,
    chainHandovers: final.handovers,
    writesPerSec: Math.round((final.rows / spanS) * 100) / 100,
  }
}

function renderReport(s: Summary, final: ChainVerdict): string {
  const ok = (b: boolean) => (b ? '✓' : '✗ FAIL')
  return (
    `\n══ RESULT ═══════════════════════════════════════════════════════\n` +
    `  chain integrity (final, authoritative)   ${ok(final.ok)}\n` +
    `    rows in chain        ${s.chainRows}\n` +
    `    distinct writers     ${s.chainWriters}\n` +
    `    writer handovers     ${s.chainHandovers}\n` +
    `    violations           ${final.violations.length}\n` +
    (final.violations.length
      ? final.violations.slice(0, 10).map((v) => `      · [${v.kind}] seq ${v.seq}: ${v.detail}`).join('\n') + '\n'
      : '') +
    `  no shared-token commits (safety core)    ${ok(s.fenceSharedCommits === 0)}  (${s.fenceSharedCommits} shared)\n` +
    `  issued tokens sorted-monotonic           ${ok(s.tokensSortMonotonic)}  (max token ${s.maxToken})\n` +
    `  continuous verifier checks               ${s.verifyChecks}  (${s.verifyViolations} violations)\n` +
    `\n  contention resolved cleanly:\n` +
    `    lease acquisitions          ${s.acquisitions}\n` +
    `    clean releases (handoff)    ${s.cleanReleases}\n` +
    `    simulated crashes (takeover)${s.crashes}\n` +
    `    zombie stalls               ${s.zombieStalls}\n` +
    `    losers fenced/locked (OK)   ${s.fencedExpected + s.lockedEvents}\n` +
    `    transient IO blips (non-fatal) ${s.ioErrors}\n` +
    `    unexpected errors           ${s.errors}\n` +
    `\n  sustained ledger writes/sec   ${s.writesPerSec}\n` +
    `═════════════════════════════════════════════════════════════════\n` +
    `  VERDICT: ${final.ok && s.tokensSortMonotonic && s.verifyViolations === 0 && s.errors === 0 ? '✅ single-writer guarantee HELD under real contention' : '❌ INTEGRITY PROBLEM — see violations above'}\n`
  )
}

function printHeartbeat(): void {
  const evs = readEvents()
  const last = evs[evs.length - 1]
  const verifies = evs.filter((e) => e.ev === 'verify')
  const lastV = verifies[verifies.length - 1]
  const acq = evs.filter((e) => e.ev === 'acquired').length
  console.log(
    `  ·heartbeat· acquisitions=${acq} ` +
      `lastVerify=${lastV ? `seq ${lastV.seq}/rows ${lastV.rows}/ok ${lastV.ok}` : '—'} ` +
      `lastEvent=${last?.ev ?? '—'}`,
  )
}

function logResult(file: string, obj: Record<string, unknown>): void {
  const path = `results/${file}`
  mkdirSync('results', { recursive: true })
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n')
}

// ---- dispatch ----
const role = process.argv[2] ?? 'orchestrator'
try {
  if (role === 'writer') await runWriter(process.argv[3] ?? '0')
  else if (role === 'verifier') await runVerifier()
  else await runOrchestrator()
} catch (e) {
  emit({ ev: 'fatal', role, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
  console.error(e)
  process.exit(1)
}
