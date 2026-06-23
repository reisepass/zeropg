// A plain zeropg wire (no contrib extensions) for testing znostr-relay, which
// needs only built-in types + a jsonb GIN index. Run from the repo root:
//   WIRE_PORT=5605 WIRE_DATADIR=/tmp/znostr-data npx tsx examples/cloudrun/nostr/local/plain-wire.mjs
import { serveWire } from '@zeropg/client'
const port = Number(process.env.WIRE_PORT || 5605)
await serveWire({
  dataDir: process.env.WIRE_DATADIR || '/tmp/znostr-data',
  host: '0.0.0.0',
  port,
  maxConnections: 20,
})
console.log(`[plain-wire] up on 0.0.0.0:${port}`)
