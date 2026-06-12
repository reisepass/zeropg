// Minimal streaming ustar — just enough to round-trip a Postgres datadir
// without ever materializing the archive in memory.
//
// Why not `tar` from npm: the formats we must read are (a) PGlite's own
// dumpDataDir output (plain ustar, absolute-ish names like "/base/5/16384")
// and (b) our own output. ~150 lines beats a dependency in the Docker bundle,
// and both ends are under our control. GNU longname ('L') and pax ('x','g')
// entries are tolerated on read for safety.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'

const BLOCK = 512

function parseOctal(buf: Uint8Array, off: number, len: number): number {
  const s = Buffer.from(buf.subarray(off, off + len)).toString('ascii').replace(/\0.*$/, '').trim()
  return s ? parseInt(s, 8) : 0
}

function isZeroBlock(b: Uint8Array): boolean {
  for (let i = 0; i < BLOCK; i++) if (b[i] !== 0) return false
  return true
}

/** Reject absolute escapes and `..` traversal; returns a safe relative path. */
function sanitizeEntryName(raw: string): string | null {
  const name = raw.replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!name || name === '.') return null
  const parts = name.split('/')
  if (parts.some((p) => p === '..' || p === '')) {
    throw new Error(`tar entry with unsafe path: ${JSON.stringify(raw)}`)
  }
  return parts.join('/')
}

/**
 * Extract a tar byte stream into destDir. Handles file ('0'/NUL) and dir ('5')
 * entries; GNU longname 'L' is honored; pax headers are skipped. File bytes are
 * streamed straight to disk with backpressure — peak memory is one chunk.
 */
export async function extractTarStream(
  source: AsyncIterable<Uint8Array>,
  destDir: string,
): Promise<{ files: number; bytes: number }> {
  await mkdir(destDir, { recursive: true })
  let files = 0
  let bytes = 0

  // Buffered reader over the source with exact-size reads.
  const it = source[Symbol.asyncIterator]()
  let chunk: Uint8Array | null = null
  let off = 0
  async function read(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      if (!chunk || off >= chunk.length) {
        const r = await it.next()
        if (r.done) return filled === 0 ? null : (() => { throw new Error('truncated tar stream') })()
        chunk = r.value
        off = 0
        continue
      }
      const take = Math.min(n - filled, chunk.length - off)
      out.set(chunk.subarray(off, off + take), filled)
      off += take
      filled += take
    }
    return out
  }
  /** Stream exactly n bytes (+ padding to 512) into a writer callback. */
  async function readBody(n: number, sink: ((b: Uint8Array) => Promise<void>) | null): Promise<void> {
    let remaining = n
    while (remaining > 0) {
      if (!chunk || off >= chunk.length) {
        const r = await it.next()
        if (r.done) throw new Error('truncated tar entry body')
        chunk = r.value
        off = 0
        continue
      }
      const take = Math.min(remaining, chunk.length - off)
      if (sink) await sink(chunk.subarray(off, off + take))
      off += take
      remaining -= take
    }
    const pad = (BLOCK - (n % BLOCK)) % BLOCK
    if (pad > 0) await read(pad)
  }

  let pendingLongName: string | null = null
  for (;;) {
    const header = await read(BLOCK)
    if (header === null || isZeroBlock(header)) break

    const rawName = Buffer.from(header.subarray(0, 100)).toString('utf8').replace(/\0.*$/, '')
    const prefix = Buffer.from(header.subarray(345, 500)).toString('utf8').replace(/\0.*$/, '')
    const size = parseOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] === 0 ? 48 : header[156])

    let name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    pendingLongName = null

    if (typeflag === 'L') {
      // GNU long name: body is the real name of the NEXT entry.
      const parts: Buffer[] = []
      await readBody(size, async (b) => void parts.push(Buffer.from(b)))
      pendingLongName = Buffer.concat(parts).toString('utf8').replace(/\0.*$/, '')
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      await readBody(size, null) // pax metadata — not needed for our archives
      continue
    }

    const safe = sanitizeEntryName(name)
    if (safe === null) {
      await readBody(size, null)
      continue
    }
    const dest = join(destDir, safe)

    if (typeflag === '5') {
      await mkdir(dest, { recursive: true })
      await readBody(size, null)
      continue
    }
    if (typeflag !== '0') {
      await readBody(size, null) // links/devices: irrelevant for a PG datadir
      continue
    }

    await mkdir(join(destDir, posix.dirname(safe)), { recursive: true })
    const ws = createWriteStream(dest, { mode: 0o600 })
    await readBody(size, (b) => {
      // Copy: the chunk buffer is reused by the reader loop's source.
      const copy = Buffer.from(b)
      return new Promise<void>((resolve, reject) => {
        ws.write(copy, (err) => (err ? reject(err) : resolve()))
      })
    })
    await new Promise<void>((resolve, reject) => ws.end((err: unknown) => (err ? reject(err) : resolve())))
    files++
    bytes += size
  }
  return { files, bytes }
}

function octal(n: number, len: number): Buffer {
  const b = Buffer.alloc(len, 0)
  b.write(n.toString(8).padStart(len - 1, '0'), 0, 'ascii')
  return b
}

function tarHeader(name: string, size: number, type: '0' | '5', mtimeSec: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0)
  if (Buffer.byteLength(name) > 100) {
    // Postgres datadir paths are short; if this ever fires something is wrong.
    throw new Error(`tar entry name too long: ${name}`)
  }
  h.write(name, 0, 'utf8')
  octal(type === '5' ? 0o700 : 0o600, 8).copy(h, 100) // mode
  octal(0, 8).copy(h, 108) // uid
  octal(0, 8).copy(h, 116) // gid
  octal(size, 12).copy(h, 124)
  octal(mtimeSec, 12).copy(h, 136)
  h.write('        ', 148, 'ascii') // checksum placeholder = spaces
  h.write(type, 156, 'ascii')
  h.write('ustar', 257, 'ascii')
  h.write('00', 263, 'ascii')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  // Checksum: 6 octal digits, NUL, space.
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(h, 148)
  return h
}

/**
 * Stream a directory as a tar archive (files + dirs, sorted walk). Yields
 * header blocks and raw file chunks; never holds more than one read chunk.
 */
export async function* createTarStream(rootDir: string): AsyncGenerator<Uint8Array> {
  const mtimeSec = Math.floor(Date.now() / 1000)
  async function* walk(rel: string): AsyncGenerator<Uint8Array> {
    const abs = rel ? join(rootDir, rel) : rootDir
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        yield tarHeader(childRel + '/', 0, '5', mtimeSec)
        yield* walk(childRel)
      } else if (e.isFile()) {
        const st = await stat(join(rootDir, childRel))
        yield tarHeader(childRel, st.size, '0', mtimeSec)
        let written = 0
        if (st.size <= 4 * 1024 * 1024) {
          // One syscall for the long tail of small datadir files; per-stream
          // setup over ~1000 files otherwise dominates the snapshot time.
          const buf = await readFile(join(rootDir, childRel))
          written = buf.length
          yield buf
        } else {
          for await (const chunk of createReadStream(join(rootDir, childRel), {
            highWaterMark: 4 * 1024 * 1024,
          })) {
            written += (chunk as Buffer).length
            yield chunk as Buffer
          }
        }
        if (written !== st.size) {
          // The datadir must be quiescent during a snapshot (we CHECKPOINT and
          // hold the single connection). A size change mid-read means that
          // invariant broke — corrupt archive, fail loudly.
          throw new Error(`file ${childRel} changed size during snapshot (${st.size} -> ${written})`)
        }
        const pad = (BLOCK - (st.size % BLOCK)) % BLOCK
        if (pad > 0) yield Buffer.alloc(pad, 0)
      }
    }
  }
  yield* walk('')
  yield Buffer.alloc(BLOCK * 2, 0)
}

/** Convenience: extract with mkdir -p semantics from a Node Readable/iterable, via pipeline-safe consumption. */
export { pipeline }
