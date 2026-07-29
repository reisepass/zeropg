// E15 experiment 2, the correctness half: take the writer lease from OUTSIDE
// while the Fly Machine is frozen, then resume it and see what a client gets.
//
//   npx tsx steal-lease.ts <prefix> <action>
//     action = inspect   read lease.json + manifest, print holder/token/expiry
//              steal     take the lease over (only possible once it has expired)
//              write     as the new holder, commit a row the old holder cannot see
//
// WHY THIS IS THE TEST. A suspended Machine's lease keeps expiring in real time
// while the VM is frozen: the lease lives in the bucket with a wall-clock
// expiresAt, and a frozen guest renews nothing. The TTL is 60s, so ANY suspend
// longer than a minute leaves the lease expired and takeable. On resume the
// process comes back believing it is the writer, with a PGlite instance in RAM
// that is now stale by however much the new holder wrote.
//
// That is the same class as the false-success bug E11 found in step 4: the
// bucket is protected by the fencing token, but nothing stops the loser from
// SERVING. The difference is that E11 needed two Machines to produce it, while
// suspend produces it with one - which makes it a property of the configuration
// rather than of an operator mistake.
//
// This process is the "elsewhere" that takes the lease: a plain ZeroPG opened
// against the same bucket and prefix from this box. It reuses the engine's own
// acquire path rather than hand-writing lease.json, so a takeover here is
// exactly the takeover a second Machine would perform.

import { R2BlobStore } from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'

const PREFIX = process.argv[2] ?? 'e15/coldstart'
const ACTION = process.argv[3] ?? 'inspect'

const store = new R2BlobStore({
  endpoint: process.env.AWS_ENDPOINT_URL_S3!,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  bucket: process.env.BUCKET_NAME!,
  prefix: PREFIX,
  region: process.env.AWS_REGION ?? 'auto',
})

async function inspect() {
  const lease = await store.get('lease.json')
  if (!lease) {
    console.log(JSON.stringify({ lease: null }))
  } else {
    const body = JSON.parse(new TextDecoder().decode(lease.bytes))
    const msLeft = Date.parse(body.expiresAt) - Date.now()
    console.log(
      JSON.stringify({
        holder: body.holder,
        fencingToken: body.fencingToken,
        acquiredAt: body.acquiredAt,
        expiresAt: body.expiresAt,
        expiresInMs: msLeft,
        // The whole point: once this is true, anyone may take the lease, and a
        // frozen Machine cannot stop them because it is not running to renew.
        expired: msLeft <= 0,
      }),
    )
  }
}

async function takeover(write: boolean) {
  // acquireTimeoutMs 0: fail immediately rather than waiting the lease out. If
  // the lease is still live we want to SEE that, not block until it lapses -
  // "we had to wait" is itself the result for a short-gap run.
  const db = await ZeroPG.open({
    store,
    holder: `steal-${process.pid}`,
    durability: 'strict',
    acquireTimeoutMs: 0,
  })
  console.log(
    JSON.stringify({
      event: 'lease-taken',
      boot: db.bootTimings,
    }),
  )
  const before = await db.query<{ id: number; body: string }>('SELECT id, body FROM notes ORDER BY id')
  console.log(JSON.stringify({ event: 'rows-as-new-holder', rows: before.rows }))

  if (write) {
    await db.query("INSERT INTO notes(body) VALUES ('written-by-thief')")
    // strict durability: this returns only once the manifest CAS has landed, so
    // by the time it resolves the bucket genuinely holds the row and the frozen
    // Machine's fencing token is genuinely behind.
    await db.commit()
    const after = await db.query<{ id: number; body: string }>('SELECT id, body FROM notes ORDER BY id')
    console.log(JSON.stringify({ event: 'committed-as-new-holder', rows: after.rows }))
  }
  await db.close()
}

if (ACTION === 'inspect') await inspect()
else if (ACTION === 'steal') await takeover(false)
else if (ACTION === 'write') await takeover(true)
else {
  console.error('action must be inspect | steal | write')
  process.exit(2)
}
process.exit(0)
