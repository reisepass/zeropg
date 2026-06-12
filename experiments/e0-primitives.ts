// E0: GCS conditional-write primitives.
//
// The entire design rests on ifGenerationMatch doing what the docs say. This
// probe verifies it against real GCS. Kill criterion: any race round with two
// winners, or 412s not behaving as documented.

import { GcsBlobStore, PreconditionFailedError } from '@zeropg/blobstore'
import {
  BUCKET,
  runId,
  logResult,
  stats,
  timed,
  randomBytes,
  section,
  assert,
  failureCount,
  resetFailures,
} from './_util.js'

const RUN = runId()
const store = new GcsBlobStore({ bucket: BUCKET, prefix: `e0/${RUN}` })
const enc = new TextEncoder()
const dec = new TextDecoder()

async function probe1_createIfAbsent() {
  section('Probe 1: create-if-absent')
  const key = 'p1/object'
  const r1 = await store.put(key, enc.encode('first'), { ifNoneMatch: true })
  assert(!!r1.etag, `first create-if-absent succeeds (gen=${r1.etag})`)
  let threw = false
  try {
    await store.put(key, enc.encode('second'), { ifNoneMatch: true })
  } catch (e) {
    threw = e instanceof PreconditionFailedError
  }
  assert(threw, 'second create-if-absent on existing key fails with PreconditionFailedError (412)')
  const got = await store.get(key)
  assert(got !== null && dec.decode(got.bytes) === 'first', 'value is still the first writer\'s')
}

async function probe2_compareAndSwap() {
  section('Probe 2: compare-and-swap')
  const key = 'p2/object'
  const r1 = await store.put(key, enc.encode('v1'), { ifNoneMatch: true })
  const r2 = await store.put(key, enc.encode('v2'), { ifMatch: r1.etag })
  assert(r2.etag !== r1.etag, `CAS on current generation succeeds, gen advances ${r1.etag} -> ${r2.etag}`)
  let threw = false
  try {
    // r1.etag is now stale.
    await store.put(key, enc.encode('v3'), { ifMatch: r1.etag })
  } catch (e) {
    threw = e instanceof PreconditionFailedError
  }
  assert(threw, 'CAS on a stale generation fails with PreconditionFailedError (412)')
  const got = await store.get(key)
  assert(got !== null && dec.decode(got.bytes) === 'v2', 'value is the last winning writer\'s (v2)')
}

async function probe3_race(rounds = 100, concurrency = 20) {
  section(`Probe 3: race — ${concurrency} concurrent writers x ${rounds} rounds`)

  // 3a: concurrent create-if-absent. Exactly one winner per round.
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

  // 3b: concurrent CAS against the same base generation. Exactly one winner.
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

  logResult('e0.jsonl', {
    run: RUN,
    probe: 'race',
    rounds,
    concurrency,
    createTwoWinners,
    createNoWinner,
    casTwoWinners,
    casNoWinner,
  })
}

async function probe4_readAfterWrite(rounds = 50) {
  section(`Probe 4: read-after-write consistency x ${rounds}`)
  let mismatches = 0
  for (let i = 0; i < rounds; i++) {
    const key = `p4/${i}`
    const payload = `winner-${i}-${Math.floor(performance.now())}`
    await store.put(key, enc.encode(payload), { ifNoneMatch: true })
    const got = await store.get(key)
    if (!got || dec.decode(got.bytes) !== payload) mismatches++
  }
  assert(mismatches === 0, `immediate get after winning put returns the winner's body (mismatches: ${mismatches})`)
}

async function probe5_latency() {
  section('Probe 5: latency baseline (from this VM, in-region)')
  const sizes = [
    { label: '1KB', n: 1024 },
    { label: '1MB', n: 1024 * 1024 },
    { label: '16MB', n: 16 * 1024 * 1024 },
  ]
  const N = 20
  for (const { label, n } of sizes) {
    const body = randomBytes(n)
    const putMs: number[] = []
    const condPutMs: number[] = []
    const getMs: number[] = []
    for (let i = 0; i < N; i++) {
      const key = `p5/${label}/${i}`
      const [, t1] = await timed(() => store.put(key, body))
      putMs.push(t1)
      const condKey = `p5c/${label}/${i}`
      const [, t2] = await timed(() => store.put(condKey, body, { ifNoneMatch: true }))
      condPutMs.push(t2)
      const [, t3] = await timed(() => store.get(key))
      getMs.push(t3)
    }
    const row = {
      run: RUN,
      probe: 'latency',
      size: label,
      put: stats(putMs),
      condPut: stats(condPutMs),
      get: stats(getMs),
    }
    logResult('e0.jsonl', row)
    console.log(
      `  ${label.padEnd(5)} PUT p50=${row.put.p50}ms p99=${row.put.p99}ms | ` +
        `condPUT p50=${row.condPut.p50}ms p99=${row.condPut.p99}ms | ` +
        `GET p50=${row.get.p50}ms p99=${row.get.p99}ms`,
    )
  }
}

async function cleanup() {
  section('Cleanup')
  let n = 0
  for await (const e of store.list('')) {
    await store.delete(e.key)
    n++
  }
  console.log(`  deleted ${n} objects under e0/${RUN}`)
}

async function main() {
  resetFailures()
  console.log(`E0 primitives — bucket=${BUCKET} prefix=e0/${RUN}`)
  await probe1_createIfAbsent()
  await probe2_compareAndSwap()
  await probe3_race()
  await probe4_readAfterWrite()
  await probe5_latency()
  await cleanup()

  const fails = failureCount()
  section('Result')
  if (fails === 0) {
    console.log('  ✅ E0 PASSED — GCS conditional writes behave as the design requires.')
  } else {
    console.log(`  ❌ E0 FAILED — ${fails} assertion(s) failed. KILL CRITERION territory.`)
    process.exitCode = 1
  }
  logResult('e0.jsonl', { run: RUN, probe: 'summary', failures: fails })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
