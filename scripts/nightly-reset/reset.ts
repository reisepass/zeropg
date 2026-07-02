// Nightly demo reset (Cloud Run job, scheduled 04:10 UTC daily).
//
// Every live public demo lets anonymous visitors write to the database (that is
// the point of the demo), so each night this job returns every demo DB to a
// clean state. The mechanism is the same lease/fencing machinery the demos
// already run on - no bucket surgery, no new protocol:
//
//   1. Boot a real ZeroPG writer against the demo's prefix. acquireTimeoutMs
//      waits out an unexpired lease (idle instances stop renewing within the
//      60s TTL); on takeover the boot path fence-stamps the manifest, so a
//      still-running instance becomes a zombie whose commits physically fail
//      (FencedError -> HTTP 423). This is the live-verified E4 mechanism.
//   2. Reset content as the legitimate writer:
//        - drop-schemas: drop every non-system schema and recreate an empty
//          `public`. Apps rebuild themselves: self-migrating apps (NocoDB,
//          PrivateBin, GoTrue, ...) re-run their migrations on next boot, and
//          the migrate-sidecar apps (Rallly, Documenso) re-apply their full
//          migration set because the marker table is gone.
//        - truncate: TRUNCATE the listed tables only (the benchmark demos keep
//          their size-calibrated `filler` table).
//   3. close() - the flush commits the reset state (first commit of a writer
//      life is a full-snapshot compaction, so the bucket also sheds bloat)
//      and releases the lease.
//   4. Roll the Cloud Run service (bump ZEROPG_RESTART_NONCE via the Admin
//      API) so schema-caching sidecars (PostgREST, GoTrue, NocoDB, Prisma)
//      restart against the fresh DB instead of serving a stale cache.
//   5. Smoke-poll the public URL until it answers again.
//
// Excluded on purpose: cocoon PDS (holds real AT-Proto identities and has real
// federation traffic), Cal.com (not in the live set), nostream + webhookx (not
// publicly promoted), and the Tigris/R2/IBM demos (different clouds/creds).
//
// Env:
//   DEMOS_FILTER  comma-separated demo names to run a subset (default: all)
//   DRY_RUN=1     acquire + report only; no SQL, no roll
//   SKIP_ROLL=1   reset DBs but do not roll services (local testing)

import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'blob-pglite'
const REGION = 'europe-west1'
const BUCKET = 'zeropg-experiments-euw1'

interface Demo {
  name: string
  service: string
  prefix: string
  mode: 'drop-schemas' | 'truncate'
  truncateTables?: string[]
  /** contrib extensions the demo's DB objects depend on (mirror of the service's ZEROPG_EXTENSIONS) */
  extensions?: string[]
  smokeUrl: string
  /** generous ceiling for apps that re-run their whole migration set on the post-reset boot */
  smokeTimeoutMs?: number
}

const DEMOS: Demo[] = [
  { name: 'demo-1mb', service: 'zeropg-demo-1mb', prefix: 'demo/app-1mb', mode: 'truncate', truncateTables: ['notes'], smokeUrl: 'https://zeropg-demo-1mb-71428757273.europe-west1.run.app/up' },
  { name: 'demo-50mb', service: 'zeropg-demo-50mb', prefix: 'demo/app-50mb', mode: 'truncate', truncateTables: ['notes'], smokeUrl: 'https://zeropg-demo-50mb-71428757273.europe-west1.run.app/up' },
  { name: 'demo-500mb', service: 'zeropg-demo-500mb', prefix: 'demo/app-500mb', mode: 'truncate', truncateTables: ['notes'], smokeUrl: 'https://zeropg-demo-500mb-71428757273.europe-west1.run.app/up' },
  { name: 'supabase', service: 'supabase-zeropg', prefix: 'cloudrun-supabase-v5', mode: 'drop-schemas', smokeUrl: 'https://supabase-scale-to-zero.0rs.org/' },
  { name: 'privatebin', service: 'privatebin-zeropg', prefix: 'cloudrun-privatebin', mode: 'drop-schemas', smokeUrl: 'https://privatebin-scale-to-zero.0rs.org/' },
  { name: 'nocodb', service: 'nocodb-zeropg', prefix: 'cloudrun-nocodb', mode: 'drop-schemas', smokeUrl: 'https://nocodb-scale-to-zero.0rs.org/', smokeTimeoutMs: 12 * 60_000 },
  { name: 'rallly', service: 'rallly-zeropg', prefix: 'cloudrun-rallly', mode: 'drop-schemas', extensions: ['citext', 'pgcrypto'], smokeUrl: 'https://rallly-scale-to-zero.0rs.org/', smokeTimeoutMs: 12 * 60_000 },
  { name: 'documenso', service: 'documenso-zeropg', prefix: 'cloudrun-documenso', mode: 'drop-schemas', extensions: ['pgcrypto', 'pg_trgm'], smokeUrl: 'https://documenso-scale-to-zero.0rs.org/', smokeTimeoutMs: 12 * 60_000 },
  { name: 'airtable', service: 'airtable-zeropg', prefix: 'cloudrun-airtable', mode: 'drop-schemas', smokeUrl: 'https://airtable-scale-to-zero.0rs.org/' },
  { name: 'httpbin', service: 'httpbin-zeropg', prefix: 'cloudrun-httpbin', mode: 'drop-schemas', smokeUrl: 'https://httpbin-ui-scale-to-zero.0rs.org/' },
  { name: 'znostr', service: 'znostr-zeropg', prefix: 'cloudrun-znostr', mode: 'drop-schemas', smokeUrl: 'https://znostr-zeropg-71428757273.europe-west1.run.app/' },
]

const DRY_RUN = process.env.DRY_RUN === '1'
const SKIP_ROLL = process.env.SKIP_ROLL === '1'
const log = (name: string, obj: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), demo: name, ...obj }))

async function loadExtensions(names: string[] = []): Promise<Record<string, unknown>> {
  const extensions: Record<string, unknown> = {}
  for (const n of names) {
    const mod = (await import(`@electric-sql/pglite/contrib/${n}`)) as Record<string, unknown>
    extensions[n] = mod[n] ?? Object.values(mod)[0]
  }
  return extensions
}

/** Access token: metadata server on Cloud Run, gcloud ADC locally. */
async function accessToken(): Promise<string> {
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
    )
    if (r.ok) return ((await r.json()) as { access_token: string }).access_token
  } catch {}
  return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()
}

/** Roll a new revision by bumping ZEROPG_RESTART_NONCE on every container. */
async function rollService(service: string): Promise<void> {
  const token = await accessToken()
  const base = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${service}`
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const svc = (await (await fetch(base, { headers: auth })).json()) as {
    template: { containers: Array<{ env?: Array<{ name: string; value?: string }> }> }
  }
  const nonce = String(Date.now())
  for (const c of svc.template.containers) {
    c.env = c.env ?? []
    const existing = c.env.find((e) => e.name === 'ZEROPG_RESTART_NONCE')
    if (existing) existing.value = nonce
    else c.env.push({ name: 'ZEROPG_RESTART_NONCE', value: nonce })
  }
  const res = await fetch(`${base}?updateMask=template`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ template: svc.template }),
  })
  if (!res.ok) throw new Error(`roll ${service} failed: ${res.status} ${await res.text()}`)
}

async function smoke(url: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'manual' })
      last = r.status
      // Any answer below 500 means the stack is up again (426 = websocket
      // endpoint, 3xx = app redirect, 401/403 = auth wall - all alive).
      if (r.status < 500) return r.status
    } catch {
      last = -1
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  throw new Error(`smoke ${url} never answered <500 within ${timeoutMs}ms (last: ${last})`)
}

async function resetOne(demo: Demo): Promise<void> {
  const t0 = performance.now()
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: demo.prefix })
  const extensions = await loadExtensions(demo.extensions)
  log(demo.name, { event: 'acquiring', prefix: demo.prefix })
  const db = await ZeroPG.open({
    store,
    holder: 'nightly-reset',
    durability: 'sleep',
    acquireTimeoutMs: 120_000,
    extensions,
  })
  try {
    if (DRY_RUN) {
      const schemas = await db.raw.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`,
      )
      log(demo.name, { event: 'dry-run', schemas: schemas.rows.map((r) => r.nspname) })
      return
    }
    if (demo.mode === 'truncate') {
      for (const t of demo.truncateTables ?? []) {
        await db.raw.exec(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`)
      }
      log(demo.name, { event: 'truncated', tables: demo.truncateTables })
    } else {
      const schemas = await db.raw.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`,
      )
      for (const { nspname } of schemas.rows) {
        await db.raw.exec(`DROP SCHEMA "${nspname.replace(/"/g, '""')}" CASCADE`)
      }
      await db.raw.exec(`CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;`)
      log(demo.name, { event: 'dropped-schemas', schemas: schemas.rows.map((r) => r.nspname) })
    }
  } finally {
    await db.close() // flush commits the reset (full-snapshot compaction) + releases the lease
  }
  log(demo.name, { event: 'committed', ms: Math.round(performance.now() - t0) })

  if (!SKIP_ROLL && !DRY_RUN) {
    await rollService(demo.service)
    log(demo.name, { event: 'rolled', service: demo.service })
  }
  if (!DRY_RUN) {
    const status = await smoke(demo.smokeUrl, demo.smokeTimeoutMs ?? 5 * 60_000)
    log(demo.name, { event: 'smoke-ok', url: demo.smokeUrl, status, totalMs: Math.round(performance.now() - t0) })
  }
}

async function main() {
  const filter = (process.env.DEMOS_FILTER ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const targets = filter.length ? DEMOS.filter((d) => filter.includes(d.name)) : DEMOS
  if (filter.length && targets.length !== filter.length) {
    const known = new Set(DEMOS.map((d) => d.name))
    throw new Error(`unknown demo name(s) in DEMOS_FILTER: ${filter.filter((f) => !known.has(f)).join(', ')}`)
  }
  let failed = 0
  for (const demo of targets) {
    try {
      await resetOne(demo)
    } catch (e) {
      failed++
      log(demo.name, { event: 'FAIL', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
    }
  }
  log('-', { event: 'done', demos: targets.length, failed })
  process.exit(failed > 0 ? 1 : 0)
}

void main()
