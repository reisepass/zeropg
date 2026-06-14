// Bundle the loadtest-service into a single ESM file (same recipe as e3-service:
// @electric-sql/pglite stays external so its WASM/data assets resolve at runtime;
// all @zeropg/* workspace code + the ledger module is inlined). Also writes the
// empty-datadir seed snapshot shipped in the image so a fresh DB skips initdb.

import { build } from 'esbuild'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = join(here, 'dist')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [join(here, 'server.ts')],
  outfile: join(outdir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@electric-sql/pglite'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})
console.log('bundled server.mjs')

const seed = await ZeroPG.buildEmptySnapshot()
writeFileSync(join(outdir, 'seed.tar.gz'), seed)
console.log(`wrote seed.tar.gz (${(seed.byteLength / 1e6).toFixed(2)} MB)`)
process.exit(0)
