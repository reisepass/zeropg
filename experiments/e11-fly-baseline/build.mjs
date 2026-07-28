// Bundle the standalone server into a single ESM file for a slim image (same
// approach as experiments/e3-service/build.mjs). @electric-sql/pglite and
// @electric-sql/pglite-socket are left external so PGlite's WASM/data assets
// resolve from node_modules at runtime; all @zeropg/* workspace code is inlined.
// PostgREST is NOT bundled — it is a separate static binary the Dockerfile adds.

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
  external: ['@electric-sql/pglite', '@electric-sql/pglite-socket'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})
console.log('bundled server.mjs')

// Build the empty-datadir seed snapshot once and ship it in the image so a fresh
// DB skips initdb.
const seed = await ZeroPG.buildEmptySnapshot()
writeFileSync(join(outdir, 'seed.tar.gz'), seed)
console.log(`wrote seed.tar.gz (${(seed.byteLength / 1e6).toFixed(2)} MB)`)
process.exit(0)
