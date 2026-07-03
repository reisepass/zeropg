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

/** Boot the database from its bucket and expose it on a local loopback wire.
 *  Requires bucket read/write credentials (gcloud ADC) and takes the writer
 *  lease: the cloud instance is fenced until its next boot. */
export async function serveFromBucket(inst: Instance, opts: { port?: number } = {}): Promise<WireHandle> {
  if (!inst.bucket || !inst.prefix) {
    throw new Error(`${inst.name}: no ZEROPG_BUCKET/ZEROPG_PREFIX on the service; cannot locate its bucket state`)
  }
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

/** pg_dump the instance to a plain-SQL file. */
export async function exportToFile(inst: Instance, outFile: string): Promise<void> {
  const wire = await serveFromBucket(inst)
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
export async function migrateTo(inst: Instance, targetUrl: string): Promise<void> {
  const wire = await serveFromBucket(inst)
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
