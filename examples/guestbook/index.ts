// The smallest real zeropg app: an HTTP guestbook whose Postgres lives in a
// GCS bucket. Run it anywhere Node 22 runs — laptop, VM, Cloud Run at
// min-instances=0. Kill it whenever you like; the database is the bucket.
//
//   ZEROPG_BUCKET=my-bucket ZEROPG_PREFIX=apps/guestbook npx tsx examples/guestbook/index.ts
//
// Durability: `sleep` — writes return at memory speed; the WAL ships on
// shutdown/idle. Switch to 'strict' for commit-before-ack (~200ms on GCS).

import { createServer } from 'node:http'
import { GcsBlobStore } from '@zeropg/blobstore'
import { ZeroPG } from '@zeropg/objectstore-fs'

const store = new GcsBlobStore({
  bucket: process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1',
  prefix: process.env.ZEROPG_PREFIX ?? 'examples/guestbook',
})

const db = await ZeroPG.open({
  store,
  durability: 'sleep',
  acquireTimeoutMs: 90_000, // ride out a previous instance's lease
  seedSnapshot: undefined, // first boot runs initdb once (~6s); ship a seed to skip it
})
await db.exec(`CREATE TABLE IF NOT EXISTS entries (
  id serial PRIMARY KEY, name text NOT NULL, msg text NOT NULL,
  at timestamptz DEFAULT now()
)`)

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'POST' && url.pathname === '/sign') {
    const body = await new Promise<string>((ok) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => ok(b))
    })
    const p = new URLSearchParams(body)
    await db.query('INSERT INTO entries (name, msg) VALUES ($1, $2)', [
      (p.get('name') || 'anon').slice(0, 40),
      (p.get('msg') || '').slice(0, 280),
    ])
    res.writeHead(302, { location: '/' }).end()
    return
  }
  const { rows } = await db.query<{ name: string; msg: string; at: string }>(
    'SELECT name, msg, at FROM entries ORDER BY id DESC LIMIT 50',
  )
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>guestbook — zeropg</title>
<body style="font:16px system-ui;max-width:640px;margin:2rem auto;padding:0 1rem">
<h1>Guestbook</h1><p>A real Postgres, living in a bucket. Kill the server; the data stays.</p>
<form method=post action=/sign>
 <input name=name placeholder=name> <input name=msg placeholder="say something" size=40>
 <button>sign</button></form>
<ul>${rows.map((r) => `<li><b>${esc(r.name)}</b>: ${esc(r.msg)}</li>`).join('')}</ul>`)
})

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

server.listen(Number(process.env.PORT ?? 8080), () =>
  console.log(`guestbook on :${process.env.PORT ?? 8080} — db gen ${db.currentManifest.generation}`),
)

// Flush + release the lease when the platform says sleep.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => void db.close().finally(() => process.exit(0)))
}
