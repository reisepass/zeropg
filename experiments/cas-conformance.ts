// CAS conformance suite — transport-agnostic (TODO B2).
//
// The entire zeropg design rests on ONE primitive: an atomic conditional PUT
// (create-if-absent + compare-and-swap). This suite takes ANY BlobStore and
// hammers that primitive with the same probes E0 ran against GCS, generalised
// so a new backend can be admitted only after it passes. It is the per-backend
// CI gate the TODO calls non-negotiable: R2 has shipped real conditional-write
// bugs (workers-sdk #6411, workerd #2572), and this is how you catch them the
// moment R2 creds exist.
//
// Probes (kill criteria — any failure means the lease/manifest design does not
// hold on that backend):
//   P1  create-if-absent exclusivity      — second create on a live key fails
//   P2  compare-and-swap                   — CAS on current advances; on stale fails
//   P3  20-way concurrent race             — exactly one winner, create AND cas
//   P4  fencing-token monotonicity         — CAS counter under contention, strictly +1
//   P5  read-after-write consistency       — a winning write is immediately visible
//
// Run:  npx tsx experiments/cas-conformance.ts
//   - GCS runs always (creds present here), under a throwaway timestamped prefix.
//   - R2 runs iff R2 creds are in the env (R2_*/AWS_*), else it is skipped with
//     a clear message — a one-liner away from being live.

import {
  GcsBlobStore,
  R2BlobStore,
  PreconditionFailedError,
  type BlobStore,
} from '@zeropg/blobstore'
import {
  BUCKET,
  runId,
  logResult,
  section,
  assert,
  failureCount,
  resetFailures,
} from './_util.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const RUN = runId()

interface ProbeResult {
  name: string
  failures: number
}

async function probe1_createIfAbsent(store: BlobStore): Promise<void> {
  section('P1: create-if-absent exclusivity')
  const key = 'p1/object'
  const r1 = await store.put(key, enc.encode('first'), { ifNoneMatch: true })
  assert(!!r1.etag, `first create-if-absent succeeds (etag=${r1.etag})`)
  let threw = false
  try {
    await store.put(key, enc.encode('second'), { ifNoneMatch: true })
  } catch (e) {
    threw = e instanceof PreconditionFailedError
  }
  assert(threw, 'second create-if-absent on existing key fails with PreconditionFailedError')
  const got = await store.get(key)
  assert(got !== null && dec.decode(got.bytes) === 'first', "value is still the first writer's")
}

async function probe2_compareAndSwap(store: BlobStore): Promise<void> {
  section('P2: compare-and-swap')
  const key = 'p2/object'
  const r1 = await store.put(key, enc.encode('v1'), { ifNoneMatch: true })
  const r2 = await store.put(key, enc.encode('v2'), { ifMatch: r1.etag })
  assert(r2.etag !== r1.etag, `CAS on current version succeeds, token advances ${r1.etag} -> ${r2.etag}`)
  let threw = false
  try {
    await store.put(key, enc.encode('v3'), { ifMatch: r1.etag }) // r1.etag now stale
  } catch (e) {
    threw = e instanceof PreconditionFailedError
  }
  assert(threw, 'CAS on a stale version fails with PreconditionFailedError')
  const got = await store.get(key)
  assert(got !== null && dec.decode(got.bytes) === 'v2', "value is the last winner's (v2)")
}

async function probe3_race(store: BlobStore, rounds = 50, concurrency = 20): Promise<void> {
  section(`P3: race — ${concurrency} concurrent writers x ${rounds} rounds`)

  // 3a: concurrent create-if-absent on a fresh key. Exactly one winner.
  let createTwoWinners = 0
  let createNoWinner = 0
  for (let round = 0; round < rounds; round++) {
    const key = `p3a/${round}`
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) =>
        store.put(key, enc.encode(`w${i}`), { ifNoneMatch: true }),
      ),
    )
    const winners = results.filter((r) => r.status === 'fulfilled').length
    if (winners > 1) createTwoWinners++
    if (winners === 0) createNoWinner++
  }
  assert(createTwoWinners === 0, `create-if-absent: never two winners (offending rounds: ${createTwoWinners})`)
  assert(createNoWinner === 0, `create-if-absent: always at least one winner (empty rounds: ${createNoWinner})`)

  // 3b: concurrent CAS against the same base version. Exactly one winner.
  let casTwoWinners = 0
  let casNoWinner = 0
  for (let round = 0; round < rounds; round++) {
    const key = `p3b/${round}`
    const base = await store.put(key, enc.encode('base'), { ifNoneMatch: true })
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) =>
        store.put(key, enc.encode(`w${i}`), { ifMatch: base.etag }),
      ),
    )
    const winners = results.filter((r) => r.status === 'fulfilled').length
    if (winners > 1) casTwoWinners++
    if (winners === 0) casNoWinner++
  }
  assert(casTwoWinners === 0, `CAS: never two winners (offending rounds: ${casTwoWinners})`)
  assert(casNoWinner === 0, `CAS: always exactly one winner (empty rounds: ${casNoWinner})`)
}

async function probe4_fencingMonotonicity(
  store: BlobStore,
  rounds = 12,
  contenders = 10,
): Promise<void> {
  section(`P4: fencing-token monotonicity — ${contenders} contenders x ${rounds} takeover rounds`)
  // Simulate the lease's core invariant at the primitive level: a single
  // "lease" object holds a fencing token; each round, N contenders read it and
  // race a CAS to token+1. Exactly one wins per round, the token increases by
  // exactly 1, and it never goes backwards or sideways (no two winners share a
  // token). This is the property the whole single-writer guarantee inherits.
  const key = 'p4/lease'
  let cur = await store.put(key, enc.encode(JSON.stringify({ token: 0 })), { ifNoneMatch: true })
  let token = 0
  let nonMonotonic = 0
  let multiWinner = 0
  const seenTokens = new Set<number>([0])

  for (let round = 0; round < rounds; round++) {
    const base = cur
    const nextToken = token + 1
    const results = await Promise.allSettled(
      Array.from({ length: contenders }, () =>
        store.put(key, enc.encode(JSON.stringify({ token: nextToken })), { ifMatch: base.etag }),
      ),
    )
    const winners = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      etag: string
    }>[]
    if (winners.length !== 1) multiWinner++
    // Re-read the authoritative state: the token must have advanced by exactly
    // 1 and never reappeared (a reused token would be the ABA failure mode).
    const got = await store.get(key)
    const observed = got ? (JSON.parse(dec.decode(got.bytes)) as { token: number }).token : -1
    if (observed !== nextToken || seenTokens.has(observed)) nonMonotonic++
    seenTokens.add(observed)
    token = observed
    cur = winners[0] ? { etag: winners[0].value.etag } : (await store.head(key))!
  }
  assert(multiWinner === 0, `exactly one winner per takeover round (offending rounds: ${multiWinner})`)
  assert(nonMonotonic === 0, `token advanced by exactly 1 every round, never reused (violations: ${nonMonotonic})`)
  assert(token === rounds, `final token equals round count (${token} === ${rounds})`)
}

async function probe5_readAfterWrite(store: BlobStore, rounds = 30): Promise<void> {
  section(`P5: read-after-write consistency x ${rounds}`)
  let mismatches = 0
  for (let i = 0; i < rounds; i++) {
    const key = `p5/${i}`
    const payload = `winner-${i}-${Math.floor(performance.now())}`
    await store.put(key, enc.encode(payload), { ifNoneMatch: true })
    const got = await store.get(key)
    if (!got || dec.decode(got.bytes) !== payload) mismatches++
  }
  assert(mismatches === 0, `immediate get after winning put returns the winner's body (mismatches: ${mismatches})`)
}

async function cleanup(store: BlobStore): Promise<void> {
  section('Cleanup')
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects`)
}

/** Run the full suite against one store. Returns probe-level results. */
async function runConformance(store: BlobStore, backend: string): Promise<ProbeResult[]> {
  console.log(`\n${'#'.repeat(64)}\n# CAS conformance — backend=${backend}` +
    (store.cost?.casStrength ? ` (casStrength=${store.cost.casStrength})` : '') +
    `\n${'#'.repeat(64)}`)
  const probes: Array<[string, (s: BlobStore) => Promise<void>]> = [
    ['createIfAbsent', probe1_createIfAbsent],
    ['compareAndSwap', probe2_compareAndSwap],
    ['race20way', probe3_race],
    ['fencingMonotonicity', probe4_fencingMonotonicity],
    ['readAfterWrite', probe5_readAfterWrite],
  ]
  const results: ProbeResult[] = []
  for (const [name, fn] of probes) {
    resetFailures()
    try {
      await fn(store)
    } catch (e) {
      console.error(`  ✗ probe "${name}" threw:`, e)
      results.push({ name, failures: failureCount() + 1 })
      continue
    }
    results.push({ name, failures: failureCount() })
  }
  await cleanup(store).catch((e) => console.error('  cleanup error:', e))

  const total = results.reduce((a, r) => a + r.failures, 0)
  section(`Result — ${backend}`)
  for (const r of results) console.log(`  ${r.failures === 0 ? '✅' : '❌'} ${r.name} (${r.failures} failures)`)
  if (total === 0) console.log(`  ✅ ${backend} PASSED — conditional writes are a correct CAS.`)
  else console.log(`  ❌ ${backend} FAILED — ${total} assertion(s). KILL CRITERION territory.`)

  logResult('cas-conformance.jsonl', {
    run: RUN,
    backend,
    casStrength: store.cost?.casStrength ?? null,
    probes: Object.fromEntries(results.map((r) => [r.name, r.failures === 0 ? 'pass' : `fail(${r.failures})`])),
    totalFailures: total,
    verdict: total === 0 ? 'PASS' : 'FAIL',
  })
  return results
}

async function main(): Promise<void> {
  let anyFail = false

  // --- GCS: always (creds present in this environment) -------------------
  const gcsPrefix = `cas-conformance/${RUN}`
  console.log(`GCS: bucket=${BUCKET} prefix=${gcsPrefix}`)
  const gcs = new GcsBlobStore({ bucket: BUCKET, prefix: gcsPrefix })
  const gcsResults = await runConformance(gcs, 'gcs')
  anyFail ||= gcsResults.some((r) => r.failures > 0)

  // --- R2: only when creds are present -----------------------------------
  const r2 = R2BlobStore.fromEnv(`cas-conformance/${RUN}`)
  if (r2) {
    console.log(`\nR2: creds detected — running suite live.`)
    const r2Results = await runConformance(r2, 'r2')
    anyFail ||= r2Results.some((r) => r.failures > 0)
  } else {
    console.log(
      `\n⏭  R2: SKIPPED — no R2 credentials in the environment.\n` +
        `   Set R2_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY + R2_BUCKET\n` +
        `   (or AWS_* + R2_ENDPOINT) and re-run; the suite then gates R2 identically.`,
    )
    logResult('cas-conformance.jsonl', { run: RUN, backend: 'r2', verdict: 'SKIPPED', reason: 'no creds' })
  }

  if (anyFail) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
