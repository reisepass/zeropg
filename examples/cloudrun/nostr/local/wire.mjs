// Local zeropg wire for nostream testing, with the contrib extensions its
// knex migrations need: uuid_ossp (uuid_generate_v4) and btree_gin.
// Run from the repo root so @zeropg/client resolves:
//   WIRE_PORT=5601 npx tsx examples/cloudrun/nostr/local/wire.mjs
import { serveWire } from '@zeropg/client'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin'

const dataDir = process.env.WIRE_DATADIR || '/tmp/nostr-zeropg-data'
const port = Number(process.env.WIRE_PORT || 5601)
const srv = await serveWire({
  dataDir,
  host: '0.0.0.0',
  port,
  maxConnections: 20,
  extensions: { uuid_ossp, btree_gin },
})
console.log(`[nostr-wire] up on 0.0.0.0:${port} datadir=${dataDir}`)
