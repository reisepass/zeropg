// Bundle the nightly-reset job into a single ESM file (same pattern as
// experiments/e3-service/build.mjs): all @zeropg/* workspace code inlined,
// @electric-sql/pglite external so its WASM/data assets resolve at runtime.

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = join(here, 'dist')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [join(here, 'reset.ts')],
  outfile: join(outdir, 'reset.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['@electric-sql/pglite'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
})
console.log('bundled reset.mjs')
process.exit(0)
