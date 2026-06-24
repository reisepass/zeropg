// Local zeropg wire for testing the httpbin + requestbin backend without GCS.
// The requestbin schema is created by the app at boot (CREATE TABLE IF NOT
// EXISTS) and needs NO contrib extensions (vanilla bigserial/text/jsonb/
// timestamptz). Run from the zeropg repo root:
//   WIRE_PORT=5610 npx tsx examples/cloudrun/httpbin/local/wire.mjs
import { serveWire } from '@zeropg/client'

const dataDir = process.env.WIRE_DATADIR || '/tmp/httpbin-zeropg-data'
const port = Number(process.env.WIRE_PORT || 5610)
const srv = await serveWire({ dataDir, host: '127.0.0.1', port, maxConnections: 10 })
console.log(`[httpbin-wire] up on 127.0.0.1:${port} datadir=${dataDir}`)
