// Read replica in ~20 lines: a leaseless follower that serves queries from
// the bucket's latest commit. Point it at any zeropg prefix — it never
// writes, never takes the lease, and converges within the poll interval.
//
//   ZEROPG_PREFIX=apps/guestbook npx tsx examples/replica-reader/index.ts

import { createServer } from 'node:http'
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPGReplica } from '@zeropg/objectstore-fs'

const store = new GcsBlobStore({
  bucket: process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1',
  prefix: process.env.ZEROPG_PREFIX ?? 'examples/guestbook',
})

const replica = await ZeroPGReplica.open({ store, pollIntervalMs: 5000 })

createServer(async (req, res) => {
  const { rows } = await replica.query(
    'SELECT name, msg, at FROM entries ORDER BY id DESC LIMIT 50',
  )
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ commitSeq: replica.commitSeq, asOf: replica.committedAt, rows }, null, 2))
}).listen(Number(process.env.PORT ?? 8081), () =>
  console.log(`replica on :${process.env.PORT ?? 8081} at commitSeq=${replica.commitSeq}`),
)
