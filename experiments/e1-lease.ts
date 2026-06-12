// E1: lease protocol library, against real GCS with an injected fake clock.
//
// Kill criterion: any interleaving where two holders both believe they hold the
// lease AND both can advance the manifest.

import { GcsBlobStore, PreconditionFailedError, type BlobStore } from '@zeropg/blobstore'
import { Lease, LockedError, FencedError } from '@zeropg/lease'
import { BUCKET, runId, logResult, section, assert, failureCount, resetFailures } from './_util.js'

const RUN = runId()

function makeStore(sub: string): BlobStore {
  return new GcsBlobStore({ bucket: BUCKET, prefix: `e1/${RUN}/${sub}` })
}

// A shared mutable clock the lease reads via now().
function clock(startMs = 1_000_000_000_000) {
  const c = { ms: startMs }
  return { c, now: () => c.ms }
}

async function probe1_secondAcquirerLocked() {
  section('Probe 1: second acquirer gets LockedError')
  const store = makeStore('p1')
  const { now } = clock()
  const a = new Lease(store, { holder: 'A', ttlMs: 30_000, now })
  const tokenA = await a.acquire()
  assert(tokenA === 1, `A acquires fresh lease, token=1 (got ${tokenA})`)

  const b = new Lease(store, { holder: 'B', ttlMs: 30_000, now })
  let err: unknown
  try {
    await b.acquire()
  } catch (e) {
    err = e
  }
  const locked = err instanceof LockedError
  assert(locked, 'B gets LockedError while A holds an unexpired lease')
  if (locked) {
    const le = err as LockedError
    assert(le.holder === 'A', `LockedError names the holder (holder="${le.holder}")`)
    assert(!!le.expiresAt, `LockedError carries expiry (${le.expiresAt})`)
  }
  await a.release()
}

async function probe2_takeoverRace() {
  section('Probe 2: two simultaneous takeovers on expired lease — exactly one wins, token +1 once')
  const store = makeStore('p2')
  const { c, now } = clock()
  const a = new Lease(store, { holder: 'A', ttlMs: 10_000, now })
  const startToken = await a.acquire() // token 1
  // Advance clock past expiry.
  c.ms += 20_000

  const b = new Lease(store, { holder: 'B', ttlMs: 10_000, now })
  const d = new Lease(store, { holder: 'D', ttlMs: 10_000, now })
  const results = await Promise.allSettled([b.acquire(), d.acquire()])
  const winners = results.filter((r) => r.status === 'fulfilled')
  const losers = results.filter((r) => r.status === 'rejected')
  assert(winners.length === 1, `exactly one takeover wins (winners=${winners.length})`)
  assert(
    losers.length === 1 && (losers[0] as PromiseRejectedResult).reason instanceof LockedError,
    'the loser gets LockedError (sees the new unexpired holder)',
  )
  const winToken = (winners[0] as PromiseFulfilledResult<number>).value
  assert(winToken === startToken + 1, `fencing token incremented exactly once (${startToken} -> ${winToken})`)
}

async function probe3_zombie(iterations = 100) {
  section(`Probe 3: zombie — A expires, B takes over, A cannot renew nor advance manifest (x${iterations})`)
  let renewFenced = 0
  let manifestRejected = 0
  for (let i = 0; i < iterations; i++) {
    const store = makeStore(`p3/${i}`)
    const { c, now } = clock()

    // Seed a "manifest" object guarded by CAS; writers must hold its etag.
    const manifestKey = 'manifest.json'
    const enc = new TextEncoder()
    const seed = await store.put(manifestKey, enc.encode(JSON.stringify({ token: 0, lsn: 0 })), {
      ifNoneMatch: true,
    })
    let manifestEtag = seed.etag

    const a = new Lease(store, { holder: 'A', ttlMs: 10_000, now })
    await a.acquire()
    // A reads manifest etag (its snapshot of the commit point).
    const aManifestEtag = manifestEtag

    // A goes silent; lease expires; B takes over.
    c.ms += 20_000
    const b = new Lease(store, { holder: 'B', ttlMs: 10_000, now, tokenFloor: 0 })
    const bToken = await b.acquire()
    // B commits: advances the manifest via CAS on the etag it just read.
    const bManifest = await store.put(
      manifestKey,
      enc.encode(JSON.stringify({ token: bToken, lsn: 1 })),
      { ifMatch: manifestEtag },
    )
    manifestEtag = bManifest.etag

    // A wakes up (zombie). 1) renew must fence. 2) manifest CAS with A's stale
    // etag must fail — A physically cannot commit.
    try {
      await a.renew()
    } catch (e) {
      if (e instanceof FencedError) renewFenced++
    }
    try {
      await store.put(manifestKey, enc.encode(JSON.stringify({ token: 1, lsn: 99 })), {
        ifMatch: aManifestEtag,
      })
    } catch (e) {
      if (e instanceof PreconditionFailedError) manifestRejected++
    }
  }
  assert(renewFenced === iterations, `A's renew fenced every time (${renewFenced}/${iterations})`)
  assert(manifestRejected === iterations, `A's stale-etag manifest commit rejected every time (${manifestRejected}/${iterations})`)
  logResult('e1.jsonl', { run: RUN, probe: 'zombie', iterations, renewFenced, manifestRejected })
}

async function probe4_heartbeatJitter(rounds = 60) {
  section(`Probe 4: heartbeat under jitter — invariant "A renews XOR B takes over", never both (x${rounds})`)
  let violations = 0
  for (let i = 0; i < rounds; i++) {
    const store = makeStore(`p4/${i}`)
    const { c, now } = clock()
    const ttl = 10_000
    const a = new Lease(store, { holder: 'A', ttlMs: ttl, now })
    await a.acquire()

    // Advance by a random fraction 0..2x of the TTL, then A attempts renew and
    // B attempts takeover "simultaneously".
    const jitter = Math.floor(ttl * 2 * pseudoRandom(i))
    c.ms += jitter

    const b = new Lease(store, { holder: 'B', ttlMs: ttl, now })
    const [renewRes, takeoverRes] = await Promise.allSettled([a.renew(), b.acquire()])
    const aRenewed = renewRes.status === 'fulfilled'
    const bTookOver = takeoverRes.status === 'fulfilled'
    // Invariant: not both. (Either A renewed and B is Locked, or A is Fenced
    // and B took over.) Exactly one of them owns the lease afterward.
    if (aRenewed && bTookOver) violations++
  }
  assert(violations === 0, `never both A-renews and B-takes-over in the same round (violations=${violations})`)
  logResult('e1.jsonl', { run: RUN, probe: 'jitter', rounds, violations })
}

// Deterministic pseudo-random (no Math.random in workflow/clean reproducibility).
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

async function cleanup() {
  section('Cleanup')
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: `e1/${RUN}` })
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects under e1/${RUN}`)
}

async function main() {
  resetFailures()
  console.log(`E1 lease — bucket=${BUCKET} prefix=e1/${RUN}`)
  await probe1_secondAcquirerLocked()
  await probe2_takeoverRace()
  await probe3_zombie()
  await probe4_heartbeatJitter()
  await cleanup()

  const fails = failureCount()
  section('Result')
  if (fails === 0) console.log('  ✅ E1 PASSED — lease is single-writer and zombie-proof.')
  else {
    console.log(`  ❌ E1 FAILED — ${fails} assertion(s). KILL CRITERION territory.`)
    process.exitCode = 1
  }
  logResult('e1.jsonl', { run: RUN, probe: 'summary', failures: fails })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
