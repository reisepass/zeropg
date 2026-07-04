// Minimal postgres-meta launcher: the main introspection app ONLY.
//
// The package's own dist/server/server.js also starts an "admin" app on
// PG_META_PORT+1 and process.exit(1)s if that port is taken (it ran as root on
// :1 inside the Docker image; as a plain node child it is a landmine). The
// studio never calls the admin app, so we build() and listen the main app
// alone - no admin app, no PG_META_PORT+1 requirement. Connection + timeout
// come from the same env vars the package reads (PG_META_DB_URL etc.).

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { build } = await import(require.resolve('@supabase/postgres-meta/dist/server/app.js'))

const host = process.env.PG_META_HOST || '127.0.0.1'
const port = Number(process.env.PG_META_PORT || 8080)

const app = build({})
await app.listen({ host, port })
