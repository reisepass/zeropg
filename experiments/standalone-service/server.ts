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
// Tigris (Fly) / generic S3 / R2: AWS_*/R2_* creds + an S3 endpoint. This is the
// raw-wire Fly demo's storage — same R2BlobStore (S3 + SigV4) as COS, just a
// different endpoint. CAS is already verified through R2BlobStore (no new code).
const USE_S3 = !USE_COS && !!(process.env.AWS_ENDPOINT_URL_S3 || process.env.R2_ENDPOINT)
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
  if (USE_S3) {
    // Build the R2BlobStore directly from AWS_*/R2_* env. The bucket on Tigris
    // arrives as TIGRIS_BUCKET (r2OptionsFromEnv would reject the config for the
    // missing AWS_BUCKET/S3_BUCKET, so don't route through it here).
    const endpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.R2_ENDPOINT
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY
    const bucket =
      process.env.TIGRIS_BUCKET ?? process.env.AWS_BUCKET ?? process.env.S3_BUCKET ?? process.env.R2_BUCKET
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error('S3 endpoint set but missing creds/bucket (AWS_*/TIGRIS_BUCKET)')
    }
    return new R2BlobStore({
      endpoint,
      accessKeyId,
      secretAccessKey,
      bucket,
      prefix: DB_PREFIX,
      region: process.env.AWS_REGION ?? 'auto',
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
