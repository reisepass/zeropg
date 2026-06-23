// The zeropg "database" sidecar for Cloud Run: a GCS-backed, scale-to-zero
// Postgres that an app container reaches over localhost. It runs ZeroPGServer
// (@zeropg/server) = ObjectStoreFS (restore + WAL-ship to a GCS bucket) + the
// single-writer lease + the Postgres wire on 127.0.0.1:5432. Raw-wire writes are
// persisted by ZeroPGServer's row-counter-watching commit timer, so an app
// writing over the wire gets its data durably shipped to GCS.
//
// On Cloud Run this runs as a SIDECAR (not the ingress container); its HTTP
// control face (/healthz) is the startup probe. Env:
//   ZEROPG_BUCKET   GCS bucket (durable home)
//   ZEROPG_PREFIX   per-app key prefix in the bucket
//   PORT            HTTP control/health port (Cloud Run sets this; default 8081)
//   ZEROPG_WIRE_PORT  Postgres wire port on localhost (default 5432)

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'

const bucket = process.env.ZEROPG_BUCKET
if (!bucket) throw new Error('ZEROPG_BUCKET is required')
const prefix = process.env.ZEROPG_PREFIX || 'app'

const store = new GcsBlobStore({ bucket, prefix })

await ZeroPGServer.start({
  store,
  holder: process.env.ZEROPG_HOLDER || process.env.K_REVISION || 'cloudrun',
  port: Number(process.env.PORT || 8081), // HTTP control face — Cloud Run startup probe hits /healthz
  wireHost: '127.0.0.1', // shared-localhost sidecar; the app connects here
  wirePort: Number(process.env.ZEROPG_WIRE_PORT || 5432),
  postgrest: false, // the app talks the wire directly; no auto-REST needed
  schemaSql: process.env.ZEROPG_SCHEMA_SQL || undefined,
  label: process.env.APP_LABEL || 'zeropg sidecar',
})

console.log(
  `[zeropg-db] up: GCS=${bucket}/${prefix} wire=127.0.0.1:${process.env.ZEROPG_WIRE_PORT || 5432} control=:${process.env.PORT || 8081}`,
)
