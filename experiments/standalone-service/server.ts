// Standalone "dedicated Postgres instance" entry point. Wires a BlobStore
// (IBM COS or GCS, exactly like experiments/e3-service) into ZeroPGServer, which
// composes the storage core + Postgres wire protocol (loopback) + default-on
// PostgREST + the HTTP control face (/wake, /ready, POST /sql, /metrics, /rest).
//
// Deployed to a scale-to-zero, HTTP-only platform (Cloud Run / IBM Code Engine),
// so it exposes the HTTP faces only. The raw 5432 wire port stays loopback (it
// is there to make this Fly.io-ready, not to be reached on Cloud Run/CE which
// cannot accept raw Postgres TCP).

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'
import type { BlobStore } from '@zeropg/blobstore'
import type { Durability } from '@zeropg/objectstore-fs'
import { ZeroPGServer } from '@zeropg/server'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Same transport selection as e3-service: COS_* HMAC creds present -> drive the
// S3/SigV4 R2BlobStore against the IBM COS endpoint; otherwise GCS. No new
// transport code. Fresh bucket prefix for this demo (demo/standalone).
const USE_COS = !!(process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY)
const DB_PREFIX = process.env.ZEROPG_PREFIX ?? 'demo/standalone'

function selectStore(): BlobStore {
  if (USE_COS) {
    const endpoint = process.env.COS_ENDPOINT_DIRECT || process.env.COS_ENDPOINT
    if (!endpoint) throw new Error('COS_* creds set but no COS_ENDPOINT/COS_ENDPOINT_DIRECT')
    return new R2BlobStore({
      endpoint,
      accessKeyId: process.env.COS_HMAC_ACCESS_KEY_ID!,
      secretAccessKey: process.env.COS_HMAC_SECRET_ACCESS_KEY!,
      bucket: process.env.COS_BUCKET ?? 'zeropg-cos',
      prefix: DB_PREFIX,
      region: process.env.IBM_COS_REGION ?? 'eu-de',
    })
  }
  return new GcsBlobStore({
    bucket: process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1',
    prefix: DB_PREFIX,
  })
}

const DURABILITY: Durability = (['strict', 'interval', 'sleep'].includes(process.env.ZEROPG_DURABILITY ?? '')
  ? process.env.ZEROPG_DURABILITY
  : 'sleep') as Durability

// Seed snapshot (empty datadir) shipped in the image so a fresh DB skips initdb.
function loadSeed(): Uint8Array | undefined {
  const p = join(__dirname, 'seed.tar.gz')
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

const server = await ZeroPGServer.start({
  store: selectStore(),
  holder: `${process.env.K_REVISION ?? 'local'}-${process.pid}`,
  durability: DURABILITY,
  seedSnapshot: loadSeed(),
  // A demo table so the auto-REST surface has something to show immediately.
  schemaSql: `CREATE TABLE IF NOT EXISTS notes (
    id serial primary key,
    body text not null,
    created_at timestamptz default now()
  );`,
  label: process.env.APP_LABEL ?? 'zeropg standalone (dedicated Postgres)',
})
server.installSignalHandlers()
