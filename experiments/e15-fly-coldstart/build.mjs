// Bundle the E15 server, same shape as experiments/e11-fly-baseline/build.mjs.
// PGlite and pglite-socket stay external so their WASM/data assets resolve from
// node_modules at runtime; all @zeropg/* workspace code is inlined.
//
// One deliberate difference from E11: this build also emits meta.json and prints
// the bundle size. Experiment 3 asks whether a smaller image and a faster Node
// start are worth anything, and that question needs a before number.

import { build } from 'esbuild'
import { ZeroPG } from '@zeropg/objectstore-fs'
import { writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = join(here, 'dist')
mkdirSync(outdir, { recursive: true })

const result = await build({
  entryPoints: [join(here, 'server.ts')],
  outfile: join(outdir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  metafile: true,
  external: ['@electric-sql/pglite', '@electric-sql/pglite-socket'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})
writeFileSync(join(outdir, 'meta.json'), JSON.stringify(result.metafile))
console.log(`bundled server.mjs (${(statSync(join(outdir, 'server.mjs')).size / 1024).toFixed(0)} KB)`)

copyFileSync(join(here, 'boot-trace.mjs'), join(outdir, 'boot-trace.mjs'))
console.log('copied boot-trace.mjs')

const seed = await ZeroPG.buildEmptySnapshot()
writeFileSync(join(outdir, 'seed.tar.gz'), seed)
console.log(`wrote seed.tar.gz (${(seed.byteLength / 1e6).toFixed(2)} MB)`)
process.exit(0)
