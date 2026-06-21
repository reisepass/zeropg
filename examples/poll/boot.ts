// Boot the poll app on zeropg using the proven Prisma path:
//   1. serveWire() stands up a localhost postgres:// wire over a PGlite (file://
//      datadir, held under the E1 lock — one writer).
//   2. We apply the committed migration SQL (authored by `prisma migrate diff`)
//      to that single writer at boot, tracked in a _migrations table. The native
//      `prisma migrate` engine is NOT used (it can't drive pglite-socket).
//   3. The Prisma client talks to the wire via @prisma/adapter-pg.
//
// Swap the dataDir for a bucket-backed zeropg + this same code is a scale-to-zero
// Postgres app; graduate by pointing PrismaPg at a real postgres:// — no app change.

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWire, type WireServer } from '@zeropg/client'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(HERE, 'prisma', 'migrations')

export interface Booted {
  prisma: PrismaClient
  wire: WireServer
  applied: string[]
  stop: () => Promise<void>
}

export async function boot(opts: { dataDir?: string } = {}): Promise<Booted> {
  const wire = await serveWire({ dataDir: opts.dataDir ?? join(HERE, 'data', 'poll') })
  const applied = await applyMigrations(wire)
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: wire.url }) })
  return {
    prisma,
    wire,
    applied,
    stop: async () => {
      await prisma.$disconnect()
      await wire.stop()
    },
  }
}

/** Apply every committed migration SQL file not yet recorded, in name order, via
 * the single writer. exec() runs the whole multi-statement file at once. */
async function applyMigrations(wire: WireServer): Promise<string[]> {
  await wire.pglite.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
  )
  const done = new Set(
    (await wire.pglite.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
  )
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const f of files) {
    if (done.has(f)) continue
    await wire.pglite.exec(await readFile(join(MIGRATIONS, f), 'utf8'))
    await wire.pglite.query('INSERT INTO _migrations (name) VALUES ($1)', [f])
    applied.push(f)
  }
  return applied
}
