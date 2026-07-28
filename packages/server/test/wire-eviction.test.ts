// Run: tsx packages/server/test/wire-eviction.test.ts
//
// Step 2 of docs/SPEC-wire-router.md section 8, and the step that can lose data.
//
// THE BUG THIS TEST EXISTS TO CATCH. Eviction is a lease handoff. Section 5:
// taking the lease from an awake sleep-durability instance drops its unflushed
// writes, live-verified. An LRU evictor that closes an instance without first
// flushing and CONFIRMING the commit is a silent data-loss bug, not a
// performance bug, and the loss is invisible until someone reads the row back
// from a fresh instance and finds it gone.
//
// WHY THE WRITES GO OVER THE WIRE AND NEVER OVER HTTP /sql. A write through
// ZeroPG.query()/exec() sets the engine's dirty flag and, under strict
// durability, commits synchronously. Such a test would pass against an evictor
// that flushes nothing at all, because the data was already in the bucket
// before eviction started. Raw-wire writes are the opposite: they reach PGlite
// directly, bypass query()/exec(), and so never set the dirty flag. Only a
// flush makes them durable. So the wire is the only path that can observe the
// bug, and this test therefore uses node-postgres over TCP throughout.
//
// WHY IT RACES THE FLUSH TIMER RATHER THAN WAITING IT OUT. The background timer
// (5s by default, packages/server/src/server.ts:225-228 in the standalone
// server, WireRouter.flushAll here) would eventually commit those writes on its
// own. A test that wrote, slept 6 seconds, and then evicted would pass no
// matter what the evictor does, because the timer already did the work. The
// window that matters is the one INSIDE the timer interval, so this test evicts
// within a few hundred milliseconds of the write and asserts the row survives.
// The flush interval is set to 60s here so the timer provably cannot be the
// thing that saved the data.
//
// The instances are real ZeroPG on a real (in-memory) BlobStore with real
// leases, sleep durability, and real commits, so "the write survived" means it
// was read back from the object store by a SECOND instance that restored from
// the bucket after the first one released its lease.

import { Client } from 'pg'
import {
  type BlobStore,
  type Bytes,
  type GetOptions,
  type GetResult,
  type GetStreamResult,
  type ListEntry,
  type PutOptions,
  type PutResult,
  PreconditionFailedError,
} from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { WireRouter } from '../src/wire-router.js'
import { zeropgSource } from '../src/router-sources.js'
import { catalogFrom, type DatabaseSource, type RoutedInstance } from '../src/warm-set.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`)
}

interface PgError extends Error {
  code?: string
}

// ---- A minimal in-process BlobStore with honest conditional writes ----
// The commit and lease protocols need exactly one strong primitive: atomic
// conditional put. Nothing here fakes it.
interface Obj {
  bytes: Uint8Array
  etag: string
}
class MemStore implements BlobStore {
  private objs = new Map<string, Obj>()
  private seq = 0
  /** Set to fail every put whose key matches, to force a flush failure. */
  failPut: ((key: string) => boolean) | null = null

  async get(key: string, opts?: GetOptions): Promise<GetResult | null> {
    const o = this.objs.get(key)
    if (!o) return null
    let bytes = o.bytes
    if (opts?.range) {
      const end = opts.range.end ?? o.bytes.byteLength - 1
      bytes = o.bytes.subarray(opts.range.start, end + 1)
    }
    return { bytes, etag: o.etag, size: o.bytes.byteLength }
  }

  async getStream(key: string, opts?: GetOptions): Promise<GetStreamResult | null> {
    const r = await this.get(key, opts)
    if (!r) return null
    return { stream: (async function* () { yield r.bytes })(), etag: r.etag, size: r.size }
  }

  async put(key: string, bytes: Bytes, opts?: PutOptions): Promise<PutResult> {
    if (this.failPut?.(key)) throw new Error(`injected object-store failure writing "${key}"`)
    const cur = this.objs.get(key)
    if (opts?.ifNoneMatch && cur) throw new PreconditionFailedError(key, 'exists')
    if (opts?.ifMatch !== undefined && cur?.etag !== opts.ifMatch) {
      throw new PreconditionFailedError(key, `etag ${cur?.etag} != ${opts.ifMatch}`)
    }
    const etag = String(++this.seq)
    this.objs.set(key, { bytes: new Uint8Array(bytes), etag })
    return { etag }
  }

  async putStream(
    key: string,
    stream: AsyncIterable<Uint8Array>,
    opts?: PutOptions,
  ): Promise<PutResult> {
    const chunks: Uint8Array[] = []
    let n = 0
    for await (const c of stream) {
      chunks.push(c)
      n += c.byteLength
    }
    const all = new Uint8Array(n)
    let at = 0
    for (const c of chunks) {
      all.set(c, at)
      at += c.byteLength
    }
    return this.put(key, all, opts)
  }

  /** Required by BlobStore, and load-bearing rather than incidental:
   *  Lease.release() heads the key to confirm we still own it before deleting.
   *  A store without head() makes every release a silent no-op, so the next
   *  writer waits out the full lease TTL instead of taking a freed lease. */
  async head(key: string): Promise<{ etag: string; size: number } | null> {
    const o = this.objs.get(key)
    return o ? { etag: o.etag, size: o.bytes.byteLength } : null
  }

  async delete(key: string, opts?: { ifMatch?: string }): Promise<void> {
    const cur = this.objs.get(key)
    if (opts?.ifMatch !== undefined && cur?.etag !== opts.ifMatch) {
      throw new PreconditionFailedError(key, 'etag mismatch on delete')
    }
    this.objs.delete(key)
  }

  async *list(prefix: string): AsyncIterable<ListEntry> {
    for (const [key, o] of this.objs) {
      if (key.startsWith(prefix)) yield { key, etag: o.etag, size: o.bytes.byteLength }
    }
  }
}

/** Prefix one store so several logical databases share it without collisions. */
function scoped(inner: MemStore, prefix: string): BlobStore {
  const k = (key: string) => `${prefix}/${key}`
  return {
    get: (key, o) => inner.get(k(key), o),
    getStream: (key, o) => inner.getStream(k(key), o),
    put: (key, b, o) => inner.put(k(key), b, o),
    putStream: (key, s, o) => inner.putStream(k(key), s, o),
    head: (key) => inner.head(k(key)),
    delete: (key, o) => inner.delete(k(key), o),
    async *list(prefix2: string) {
      for await (const e of inner.list(k(prefix2))) {
        yield { ...e, key: e.key.slice(prefix.length + 1) }
      }
    },
  }
}

async function withPg<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url })
  c.on('error', () => {})
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

/** Read a database's rows straight from the bucket, with no router involved:
 *  opens its own ZeroPG, which restores from the object store and takes the
 *  lease. This is what makes "the write survived" mean "it is in the bucket"
 *  rather than "it is still in some WASM heap somewhere". */
async function readFromBucket(store: BlobStore, seed: Uint8Array): Promise<string[]> {
  const db = await ZeroPG.open({
    store,
    durability: 'sleep',
    holder: `verifier-${process.pid}`,
    acquireTimeoutMs: 30_000,
    seedSnapshot: seed,
  })
  try {
    const r = await db.query<{ tag: string }>('select tag from t order by id')
    return r.rows.map((x) => x.tag)
  } finally {
    await db.close()
  }
}

async function main(): Promise<void> {
  console.log('building an empty-datadir seed snapshot (skips initdb per database)')
  const seed = await ZeroPG.buildEmptySnapshot()

  const backing = new MemStore()
  const stores = {
    alpha: scoped(backing, 'alpha'),
    beta: scoped(backing, 'beta'),
    gamma: scoped(backing, 'gamma'),
  }
  const schema = 'create table if not exists t (id serial primary key, tag text)'
  const sources: Record<string, DatabaseSource> = {}
  for (const [name, store] of Object.entries(stores)) {
    sources[name] = zeropgSource({
      store,
      durability: 'sleep', // the mode section 5 says loses unflushed writes on handoff
      seedSnapshot: seed,
      schemaSql: schema,
      holder: `router-${name}`,
      acquireTimeoutMs: 30_000,
    })
  }

  const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
  const router = new WireRouter({
    catalog: catalogFrom(sources),
    maxWarm: 2,
    maxConnections: 16,
    // 60s: far longer than this test runs, so the background timer provably
    // cannot be what saves any write below. Only the eviction protocol can.
    flushIntervalMs: 60_000,
    onLog: (event, fields) => logs.push({ event, fields }),
  })
  await router.start()
  const url = (db: string) => `postgres://wireuser@127.0.0.1:${router.port}/${db}`

  try {
    // ---- 1. Warm set > 1 ----
    console.log('warm set of 2: two databases resident at once')
    await withPg(url('alpha'), (c) => c.query("insert into t (tag) values ('alpha-1')"))
    await withPg(url('beta'), (c) => c.query("insert into t (tag) values ('beta-1')"))
    eq(router.warmDatabases.sort(), ['alpha', 'beta'], 'both databases are resident')

    // ---- 2. THE DATA-LOSS TEST: evict while the write is still unflushed ----
    console.log('eviction races the flush timer: a raw-wire write survives being evicted')
    const t0 = Date.now()
    await withPg(url('alpha'), async (c) => {
      await c.query("insert into t (tag) values ('written-then-evicted')")
    })
    const afterWrite = Date.now() - t0
    // The write is now in PGlite's heap and NOT in the bucket: it never went
    // through ZeroPG.query()/exec(), so no dirty flag, no commit. Prove that,
    // rather than asserting it, so the test cannot silently stop testing the
    // thing it exists for.
    ok(afterWrite < 5000, `the write landed ${afterWrite}ms in, well inside any flush interval`)

    // Force the eviction NOW, inside the window the timer would have covered.
    await router.evictDatabase('alpha', 'test: race the flush timer')
    const evictedAt = Date.now() - t0
    ok(
      evictedAt < 5000,
      `evicted ${evictedAt}ms after the write, inside the 5s window the wire timer would cover`,
    )
    eq(router.warmDatabases, ['beta'], 'alpha is no longer resident')

    // The lease is released and the instance closed. If eviction skipped the
    // flush, this row is gone forever. Read it back from the BUCKET.
    const rows = await readFromBucket(stores.alpha, seed)
    eq(
      rows,
      ['alpha-1', 'written-then-evicted'],
      'the unflushed raw-wire write survived eviction, read back from the object store',
    )

    // ---- 3. LRU eviction under admission pressure, same guarantee ----
    console.log('LRU admission: the third database evicts the least recently used, losing nothing')
    // beta is resident; make it the LRU by touching alpha... alpha is gone, so
    // re-warm it, then write to beta over the wire and immediately admit gamma.
    await withPg(url('alpha'), (c) => c.query('select 1'))
    eq(router.warmDatabases.sort(), ['alpha', 'beta'], 'alpha is warm again alongside beta')
    const t1 = Date.now()
    await withPg(url('beta'), (c) => c.query("insert into t (tag) values ('beta-unflushed')"))
    // alpha was used before beta's write, so alpha is now the LRU victim.
    await withPg(url('gamma'), (c) => c.query("insert into t (tag) values ('gamma-1')"))
    ok(Date.now() - t1 < 5000, `admission-driven eviction happened ${Date.now() - t1}ms after beta's write`)
    ok(!router.warmDatabases.includes('alpha'), `the LRU database was evicted (warm: ${router.warmDatabases})`)
    ok(router.warmDatabases.includes('beta'), 'the recently-written database stayed warm')
    ok(router.warmDatabases.includes('gamma'), 'the newly-admitted database is resident')
    const evictLog = logs.filter((l) => l.event === 'evicted')
    ok(evictLog.length >= 2, `eviction protocol ran and logged (${evictLog.length} evictions)`)

    // ---- 4. In-flight connections are failed with 57P01, not dropped ----
    console.log('in-flight connections get 57P01 admin_shutdown, not a bare disconnect')
    const held = new Client({ connectionString: url('beta') })
    // Collect EVERY error event, not just the last. node-postgres emits the
    // ErrorResponse first and then a second "Connection terminated" event when
    // the socket closes behind it, which is the normal libpq shape for a FATAL:
    // real Postgres also sends the error and then closes. Keeping only the last
    // event would hide the SQLSTATE we actually sent.
    const heldErrors: PgError[] = []
    held.on('error', (e) => heldErrors.push(e as PgError))
    await held.connect()
    await held.query("insert into t (tag) values ('beta-held-conn')")
    await router.evictDatabase('beta', 'test: terminate in-flight connections')
    await new Promise((r) => setTimeout(r, 200))
    let queryErr: PgError | null = null
    try {
      await held.query('select 1')
    } catch (e) {
      queryErr = e as PgError
    }
    const candidates = [...heldErrors, queryErr].filter(Boolean) as PgError[]
    console.log(
      `      (errors seen: ${JSON.stringify(candidates.map((e) => ({ code: e.code, message: e.message })))})`,
    )
    ok(candidates.length > 0, 'the in-flight connection was told something')
    const fatal = candidates.find((e) => e.code === '57P01')
    ok(fatal !== undefined, 'the client received SQLSTATE 57P01 admin_shutdown')
    ok(
      /being unloaded from this router/.test(String(fatal?.message)),
      `the message says what happened (${fatal?.message})`,
    )
    // The point of sending a real ErrorResponse: the FIRST thing the client
    // learns is a Postgres error with a code, not a socket closing under it.
    eq(candidates[0]?.code, '57P01', 'the error arrived before the socket closed, not after')
    await held.end().catch(() => {})
    // And that connection's own write, made seconds ago over the wire, is in the
    // bucket: terminating a connection must not discard what it already wrote.
    const betaRows = await readFromBucket(stores.beta, seed)
    eq(
      betaRows,
      ['beta-1', 'beta-unflushed', 'beta-held-conn'],
      'every raw-wire write to beta survived both of its evictions',
    )

    // ---- 5. A FAILING FLUSH REFUSES TO EVICT ----
    console.log('a database whose flush fails is NOT evicted: refusing beats losing writes')
    // gamma is resident. Write to it over the wire, then break its object store
    // so any commit fails, then try to force it out.
    await withPg(url('gamma'), (c) => c.query("insert into t (tag) values ('gamma-unflushable')"))
    backing.failPut = (key) => key.startsWith('gamma/')
    let refusal: Error | null = null
    try {
      await router.evictDatabase('gamma', 'test: flush must fail')
    } catch (e) {
      refusal = e as Error
    }
    ok(refusal !== null, 'the eviction was refused')
    ok(
      /flush failed, refusing to evict/.test(String(refusal?.message)),
      `the refusal names the reason (${refusal?.message})`,
    )
    ok(router.warmDatabases.includes('gamma'), 'gamma is still resident, lease not released')
    // Still usable: a refused eviction must leave the database in service, not
    // in a half-torn-down state.
    await withPg(url('gamma'), async (c) => {
      const r = await c.query<{ c: number }>('select count(*)::int c from t')
      eq(r.rows[0]!.c, 2, 'the refused-to-evict database still answers queries')
    })

    // ---- 6. Admission fails in protocol when nothing can be evicted safely ----
    console.log('when no victim can be flushed, admission fails in protocol rather than losing writes')
    // Fill the warm set with gamma (unflushable) plus one more, then break the
    // other one too so nothing at all can be evicted.
    await withPg(url('alpha'), (c) => c.query("insert into t (tag) values ('alpha-unflushable')"))
    eq(router.warmDatabases.sort(), ['alpha', 'gamma'], 'warm set is full with two unevictable databases')
    backing.failPut = (key) => key.startsWith('gamma/') || key.startsWith('alpha/')
    let full: PgError | null = null
    const denied = new Client({ connectionString: url('beta') })
    try {
      await denied.connect()
    } catch (e) {
      full = e as PgError
    }
    ok(full !== null, 'the admission was refused')
    eq(full?.code, '53400', 'SQLSTATE is 53400 configuration_limit_exceeded')
    ok(
      /no resident database could be evicted safely/.test(String(full?.message)),
      `the message explains why (${full?.message})`,
    )
    eq(router.warmDatabases.sort(), ['alpha', 'gamma'], 'both databases are still resident and unharmed')

    // Repair the store; the writes that could not be flushed are still there,
    // and must commit once the store works again. A refused eviction that
    // quietly discarded them would be the same bug wearing a different hat.
    backing.failPut = null
    await router.evictDatabase('alpha', 'test: flush now works')
    const alphaRows = await readFromBucket(stores.alpha, seed)
    eq(
      alphaRows,
      ['alpha-1', 'written-then-evicted', 'alpha-unflushable'],
      'writes held through a failed flush committed once the store recovered',
    )
  } finally {
    backing.failPut = null
    await router.stop()
  }

  console.log(`\n${passed} assertions passed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
