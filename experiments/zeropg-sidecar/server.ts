// zeropg-sidecar entry point.
// Env-driven sidecar that exposes PGlite over the real Postgres wire protocol
// on :5432 (0.0.0.0) so an app container can reach it via localhost.
// Backs storage with GCS (default), S3-compatible (R2/Tigris), or IBM COS.
//
// Key env vars:
//   ZEROPG_BUCKET     - GCS bucket name (required for GCS backend)
//   ZEROPG_PREFIX     - object key prefix (default: "sidecar")
//   ZEROPG_DURABILITY - strict | interval | sleep (default: sleep)
//   ZEROPG_BACKEND    - gcs | s3 | cos (auto-detected from creds if unset)
//   AWS_ENDPOINT_URL_S3 / R2_ENDPOINT - S3 endpoint for S3/R2/Tigris backend
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY - S3 creds
//   TIGRIS_BUCKET / AWS_BUCKET - bucket for S3 backend
//   COS_ENDPOINT, COS_HMAC_ACCESS_KEY_ID, COS_HMAC_SECRET_ACCESS_KEY - IBM COS
//   ZEROPG_POSTGREST  - on | off (default: off in sidecar; app connects directly)
//   PORT              - HTTP control face port (default: 8080)
//   ZEROPG_WIRE_PORT  - wire port (default: 5432)
//   ZEROPG_WIRE_HOST  - wire bind host (default: 0.0.0.0 in sidecar)

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GcsBlobStore, R2BlobStore } from '@zeropg/blobstore'
import type { BlobStore } from '@zeropg/blobstore'
import type { Durability } from '@zeropg/objectstore-fs'
import { ZeroPGServer } from '@zeropg/server'

const __dirname = dirname(fileURLToPath(import.meta.url))

function selectStore(): BlobStore {
  const backend = (process.env.ZEROPG_BACKEND ?? '').toLowerCase()
  const useCos = backend === 'cos' || (!backend && !!(process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY))
  const useS3 = !useCos && (backend === 's3' || (!backend && !!(process.env.AWS_ENDPOINT_URL_S3 || process.env.R2_ENDPOINT)))

  const prefix = process.env.ZEROPG_PREFIX ?? 'sidecar'

  if (useCos) {
    const endpoint = process.env.COS_ENDPOINT_DIRECT || process.env.COS_ENDPOINT
    if (!endpoint) throw new Error('COS_* creds set but no COS_ENDPOINT')
    return new R2BlobStore({
      endpoint,
      accessKeyId: process.env.COS_HMAC_ACCESS_KEY_ID!,
      secretAccessKey: process.env.COS_HMAC_SECRET_ACCESS_KEY!,
      bucket: process.env.COS_BUCKET ?? 'zeropg',
      prefix,
      region: process.env.IBM_COS_REGION ?? 'eu-de',
    })
  }

  if (useS3) {
    const endpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.R2_ENDPOINT
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY
    const bucket = process.env.TIGRIS_BUCKET ?? process.env.AWS_BUCKET ?? process.env.S3_BUCKET ?? process.env.R2_BUCKET
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error('S3 backend: missing AWS_ENDPOINT_URL_S3/R2_ENDPOINT or creds/bucket')
    }
    return new R2BlobStore({ endpoint, accessKeyId, secretAccessKey, bucket, prefix, region: process.env.AWS_REGION ?? 'auto' })
  }

  // GCS default
  const bucket = process.env.ZEROPG_BUCKET
  if (!bucket) throw new Error('ZEROPG_BUCKET is required for the GCS backend (or set ZEROPG_BACKEND=s3/cos with matching creds)')
  return new GcsBlobStore({ bucket, prefix })
}

const DURABILITY: Durability = (['strict', 'interval', 'sleep'].includes(process.env.ZEROPG_DURABILITY ?? '')
  ? process.env.ZEROPG_DURABILITY
  : 'sleep') as Durability

function loadSeed(): Uint8Array | undefined {
  const p = join(__dirname, 'seed.tar.gz')
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

const server = await ZeroPGServer.start({
  store: selectStore(),
  holder: `${process.env.K_REVISION ?? process.env.HOSTNAME ?? 'sidecar'}-${process.pid}`,
  durability: DURABILITY,
  seedSnapshot: loadSeed(),
  // Sidecar: wire protocol is the primary app interface; PostgREST off by default.
  // App containers connect to localhost:5432 via standard DATABASE_URL.
  wireHost: process.env.ZEROPG_WIRE_HOST ?? '0.0.0.0',
  postgrest: /^(on|true|1)$/i.test(process.env.ZEROPG_POSTGREST ?? 'off'),
  label: process.env.APP_LABEL ?? 'zeropg-sidecar',
})
server.installSignalHandlers()
