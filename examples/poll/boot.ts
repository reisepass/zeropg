// Boot the poll app on zeropg using the proven Prisma path:
//   1. @zeropg/cli's migrateDeploy() applies the committed migrations (authored
//      by `prisma migrate diff` / `zeropg migrate dev`) to the app's PGlite
//      datadir — the SAME single-applier path the CLI uses, dogfooded here. The
//      native `prisma migrate` engine is NOT used (it can't drive PGlite).
//   2. serveWire() then stands up a localhost postgres:// wire over that PGlite
//      (file:// datadir, held under the E1 lock — one writer).
//   3. The Prisma client talks to the wire via @prisma/adapter-pg.
//
// Swap the dataDir for a bucket-backed zeropg + this same code is a scale-to-zero
// Postgres app; graduate by pointing PrismaPg at a real postgres:// — no app change.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWire, type WireServer } from '@zeropg/client'
import { migrateDeploy } from '@zeropg/cli'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface Booted {
  prisma: PrismaClient
  wire: WireServer
  applied: number
  stop: () => Promise<void>
}

export async function boot(opts: { dataDir?: string } = {}): Promise<Booted> {
  const dataDir = opts.dataDir ?? join(HERE, 'data', 'poll')
  // Apply committed migrations first (migrateDeploy opens + closes its own wire
  // on the datadir); PGlite is single-writer, so this must finish before we open
  // the app's own wire below.
  const { applied } = await migrateDeploy({ cwd: HERE, data: dataDir, log: () => {} })
  const wire = await serveWire({ dataDir })
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
