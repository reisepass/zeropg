// Recover original TypeScript source from the published npm artifacts.
//
// The vendoring plan assumed "the tarball ships dist only, so vendoring means
// cloning an unmerged GitHub branch". That is wrong. tsup emits sourcemaps with
// `sourcesContent` inlined, and those maps ARE in the tarball (files:
// ["dist/**/*"] matches dist/*.js.map). So the exact source that produced the
// published, tested binary is already sitting in node_modules.
//
// That is a better provenance story than the git branch: it is the source for
// the artifact we actually ran, not whatever `next` has drifted to since.
//
// Run: node experiments/pg-gateway/extract-source.mjs [outDir]

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ?? '/tmp/recovered-src'

// Resolved by path, not require.resolve: pg-gateway's `exports` map does not
// expose ./package.json, so the usual resolve trick throws ERR_PACKAGE_PATH_NOT_EXPORTED.
function mapsFor(pkg) {
  const root = realpathSync(join(HERE, '..', '..', 'node_modules', pkg))
  const dist = join(root, 'dist')
  if (!existsSync(dist)) return []
  const found = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      // .js.map only: the .cjs.map duplicates the same sourcesContent
      else if (e.name.endsWith('.js.map')) found.push(p)
    }
  }
  walk(dist)
  return found
}

let total = 0
for (const pkg of ['pg-gateway', '@electric-sql/pglite-socket']) {
  const maps = mapsFor(pkg)
  const seen = new Set()
  for (const mapPath of maps) {
    const m = JSON.parse(readFileSync(mapPath, 'utf8'))
    if (!m.sourcesContent) continue
    m.sources.forEach((src, i) => {
      const content = m.sourcesContent[i]
      if (!content || seen.has(src)) return
      seen.add(src)
      // strip leading ../ segments, keep the package-relative shape
      const rel = src.replace(/^(\.\.\/)+/, '')
      const out = join(OUT, pkg, rel)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, content)
      total++
    })
  }
  console.log(`${pkg}: recovered ${seen.size} source files from ${maps.length} sourcemap(s)`)
}
console.log(`\nwrote ${total} files under ${OUT}`)
console.log(`(note: pg-gateway's map also inlines its @std/* deps, including the`)
console.log(` 196 KB generated wasm-bindgen crypto module that vendoring must strip)`)
