// Export / migrate: the docs/GRADUATION.md runbook, mechanized.
//
// A zeropg database's durable home is the bucket, and the Cloud Run wire port
// is loopback-only, so the dump path is: boot a local ZeroPG writer against
// the bucket (lease takeover quiesces the cloud instance - the same verified
// mechanism the nightly reset uses; the cloud instance recovers on its next
// boot), serve the local wire on a loopback port, and run a stock pg_dump
// against it. Migration pipes pg_dump straight into psql (streaming, nothing
// buffered on disk) toward any Postgres the user provisioned themselves.
// Deliberately NO vendor provisioning APIs (Neon/Supabase/Cloud SQL): a
// connection string is the universal interface.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Instance } from './types.js'

interface WireHandle {
  url: string
  close(): Promise<void>
}

async function loadExtensions(names: string[]): Promise<Record<string, unknown>> {
  const extensions: Record<string, unknown> = {}
  for (const n of names) {
    const mod = (await import(`@electric-sql/pglite/contrib/${n}`)) as Record<string, unknown>
    extensions[n] = mod[n] ?? Object.values(mod)[0]
  }
  return extensions
}

/**
 * Quiesce before takeover. With `sleep` durability an awake instance holds
 * committed-to-it writes in memory until it sleeps, and its lease lapses while
 * idle (no background renewal). Taking the lease in that window fences it and
 * its eventual shutdown flush is physically rejected - lostPendingWrites
 * (verified live: a row inserted just before an un-quiesced export was absent
 * from the dump; Cloud Run logs showed shutdown-flush-failed/FencedError).
 * Rolling the service does NOT help: the new revision boots and steals the
 * lease before the old instance's SIGTERM flush runs (also verified live).
 *
 * So: ask the instance to commit NOW via POST /flush (server images from
 * 2026-07-03 on). On older images without /flush, check /metrics.pendingFlush
 * and refuse rather than silently drop writes; --accept-data-loss overrides.
 * An unreachable (sleeping) instance already flushed on sleep - proceed.
 */
async function quiesce(inst: Instance, opts: { acceptDataLoss?: boolean }, log: (msg: string) => void): Promise<void> {
  if (!inst.url) return
  let flushRes: Response
  try {
    flushRes = await fetch(`${inst.url}/flush`, { method: 'POST', signal: AbortSignal.timeout(60_000) })
  } catch {
    return // unreachable/asleep: the sleep-flush already committed its state
  }
  if (flushRes.ok) {
    // Two live response shapes: e3-service says {flushed, commit: {...}|null},
    // @zeropg/server says {flushed, committed: boolean}.
    const body = (await flushRes.json()) as { committed?: boolean; commit?: unknown }
    const committed = body.committed === true || (body.commit !== undefined && body.commit !== null)
    log(committed ? 'flushed pending writes to the bucket' : 'instance was already clean')
    return
  }
  // 503 = still booting: it just restored from the bucket, so nothing can be
  // pending yet; the takeover below simply fences a clean instance.
  if (flushRes.status === 503) return
  if (flushRes.status !== 404) {
    throw new Error(`${inst.name}: POST /flush answered ${flushRes.status}: ${await flushRes.text()}`)
  }
  // Old image without /flush: only pendingFlush tells us whether a takeover loses data.
  let pending = false
  try {
    const r = await fetch(`${inst.url}/metrics`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return
    pending = ((await r.json()) as { pendingFlush?: boolean }).pendingFlush === true
  } catch {
    return
  }
  if (!pending) return
  if (opts.acceptDataLoss) {
    log('WARNING: instance has unflushed writes and its image predates POST /flush; proceeding per --accept-data-loss (those writes will NOT be in the export)')
    return
  }
  throw new Error(
    `${inst.name} is awake with writes not yet committed to the bucket, and its deployed image predates the POST /flush endpoint. ` +
      `Taking the writer lease now would silently drop those writes. Options: ` +
      `(1) stop traffic and let the instance go idle - it commits when the platform stops it - then retry; ` +
      `(2) redeploy the service with a current image (adds /flush) and retry; ` +
      `(3) re-run with --accept-data-loss to export the last bucket-committed state anyway.`,
  )
}

/** Boot the database from its bucket and expose it on a local loopback wire.
 *  Requires bucket read/write credentials (gcloud ADC) and takes the writer
 *  lease: the cloud instance is fenced until its next boot. */
export async function serveFromBucket(
  inst: Instance,
  opts: { port?: number; acceptDataLoss?: boolean } = {},
): Promise<WireHandle> {
  if (!inst.bucket || !inst.prefix) {
    throw new Error(`${inst.name}: no ZEROPG_BUCKET/ZEROPG_PREFIX on the service; cannot locate its bucket state`)
  }
  await quiesce(inst, { acceptDataLoss: opts.acceptDataLoss }, (m) => console.error(`  ${m}`))
  const [{ GcsBlobStore }, { ZeroPG }, { PGLiteSocketServer }] = await Promise.all([
    import('@zeropg/blobstore'),
    import('@zeropg/objectstore-fs'),
    import('@electric-sql/pglite-socket'),
  ])
  const store = new GcsBlobStore({ bucket: inst.bucket, prefix: inst.prefix })
  const extensions = await loadExtensions(inst.extensions)
  const db = await ZeroPG.open({
    store,
    holder: 'zeropg-fleet-export',
    durability: 'sleep',
    // Wait out the cloud instance's lease (idle instances stop renewing within
    // the 60s TTL); on takeover the manifest is fence-stamped.
    acquireTimeoutMs: 120_000,
    extensions,
  })
  const port = opts.port ?? 15_432
  const wire = new PGLiteSocketServer({ db: db.raw, host: '127.0.0.1', port, maxConnections: 5 })
  await wire.start()
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    close: async () => {
      await wire.stop()
      await db.close()
    },
  }
}

function run(cmd: string, args: string[], stdout: 'inherit' | 'pipe' | number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', stdout, 'inherit'] })
    child.on('error', (e) =>
      reject(
        e.message.includes('ENOENT')
          ? new Error(`${cmd} not found on PATH. Install the Postgres client tools (pg_dump/psql >= the PGlite major).`)
          : e,
      ),
    )
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))))
  })
}

const DUMP_ARGS = ['--no-owner', '--no-acl'] // per docs/GRADUATION.md

export interface TakeoverOptions {
  acceptDataLoss?: boolean
}

/** pg_dump the instance to a plain-SQL file. */
export async function exportToFile(inst: Instance, outFile: string, opts: TakeoverOptions = {}): Promise<void> {
  const wire = await serveFromBucket(inst, opts)
  try {
    const out = createWriteStream(outFile)
    const fd: number = await new Promise((res, rej) => {
      out.on('open', (n) => res(n))
      out.on('error', rej)
    })
    await run('pg_dump', [wire.url, ...DUMP_ARGS], fd)
    out.close()
  } finally {
    await wire.close()
  }
}

/** Stream pg_dump | psql into a user-provisioned Postgres. */
export async function migrateTo(inst: Instance, targetUrl: string, opts: TakeoverOptions = {}): Promise<void> {
  const wire = await serveFromBucket(inst, opts)
  try {
    await new Promise<void>((resolve, reject) => {
      const dump = spawn('pg_dump', [wire.url, ...DUMP_ARGS], { stdio: ['ignore', 'pipe', 'inherit'] })
      const restore = spawn('psql', [targetUrl, '--set', 'ON_ERROR_STOP=1'], {
        stdio: [dump.stdout, 'inherit', 'inherit'],
      })
      let failed = false
      const fail = (e: Error) => {
        if (failed) return
        failed = true
        dump.kill()
        restore.kill()
        reject(e)
      }
      dump.on('error', (e) => fail(new Error(`pg_dump: ${e.message}`)))
      restore.on('error', (e) => fail(new Error(`psql: ${e.message}`)))
      dump.on('exit', (code) => {
        if (code !== 0) fail(new Error(`pg_dump exited with code ${code}`))
      })
      restore.on('exit', (code) => {
        if (failed) return
        if (code === 0) resolve()
        else fail(new Error(`psql exited with code ${code}`))
      })
    })
  } finally {
    await wire.close()
  }
}
