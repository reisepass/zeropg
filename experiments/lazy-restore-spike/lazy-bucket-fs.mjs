// LazyBucketFS: the PRODUCTION lazy page-fault filesystem. Subclasses pglite's
// public BaseFilesystem (as the spike's LazyFS does) but faults intercepted
// relation blocks from a REAL object store (GCS / R2) through the Atomics+SAB
// bridge, instead of from a local "remote" directory.
//
// Layers:
//   - LazyBucketFS (this file, main thread): owns the node tree + the per-(key,
//     group) cache + the presence bitmap. Its synchronous read() copies the
//     caller's sub-range out of a cached 1MB group, or - on a miss - blocks on
//     the bridge until the worker has range-GET that group, then caches it.
//   - BucketBridge (this file, main thread): spawns bucket-bridge-worker.mjs,
//     exposes fetchGroupSync(keyId, groupIdx) (blocks on Atomics.wait), and an
//     async prefetch(groups) that fills the SAME cache concurrently for
//     query-plan frontrunning.
//   - bucket-bridge-worker.mjs (worker thread): one range-GET per request.
//
// 1MB-aligned page-group coalescing: a read for any 8KB block faults the whole
// 1MB group that contains it in one range-GET; the other 127 blocks of that
// group are then served from cache with no round-trip. This is the object-layer
// amortization the whole design rests on (V2 Section 4/6).

import { BaseFilesystem, ERRNO_CODES } from '@electric-sql/pglite/basefs'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'

const INITIAL_MODE = { DIR: 16384 | 0o755, FILE: 32768 | 0o644 }
const S_IFMT = 0xf000
const DEFAULT_GROUP_BYTES = 1 << 20 // 1MB

// Control SAB slot indices (mirror bucket-bridge-worker.mjs).
const REQUEST = 0
const RESPONSE = 1
const KEY_ID = 2
const GROUP_IDX = 3
const RESULT = 4
const LAT_US = 5
const COLD_PROC = 6
const SHUTDOWN = 7
const CTRL_SLOTS = 8

const WORKER_SRC = fileURLToPath(new URL('./bucket-bridge-worker.mjs', import.meta.url))
const HERE = nodePath.dirname(WORKER_SRC)

// The worker imports @zeropg/blobstore, which is TypeScript in this repo (no
// dist build) and does NOT inherit the parent's tsx loader inside a worker
// thread. Rather than hand-roll auth, bundle the worker (blobstore inlined,
// node builtins external) with esbuild on first use and run the JS bundle. The
// bundle reuses the EXACT GcsBlobStore/R2BlobStore code, just AOT-compiled.
let cachedBundlePath = null
function buildWorkerBundle() {
  if (cachedBundlePath && fs.existsSync(cachedBundlePath)) return cachedBundlePath
  const out = nodePath.join(os.tmpdir(), `bridge-worker-${process.pid}.bundle.mjs`)
  try {
    execFileSync(
      nodePath.join(HERE, '..', '..', 'node_modules', '.bin', 'esbuild'),
      [WORKER_SRC, '--bundle', '--platform=node', '--format=esm', '--log-level=error', `--outfile=${out}`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
  } catch (e) {
    throw new Error(`bridge worker bundle failed: ${e.stderr?.toString() ?? e.message}`)
  }
  cachedBundlePath = out
  return out
}

class FsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FsError'
    if (typeof code === 'number') this.code = code
    else if (typeof code === 'string') this.code = ERRNO_CODES[code]
  }
}

// --------------------------------------------------------------------------
// BucketBridge: sync fault path + async prefetch, sharing one group cache.
// --------------------------------------------------------------------------

export class BucketBridge {
  /**
   * @param {object} opts
   * @param {'gcs'|'r2'} opts.provider
   * @param {{bucket:string, prefix?:string}} [opts.gcs]
   * @param {object} [opts.r2]              R2Options resolved from env
   * @param {string[]} opts.relKeys         object keys indexed by keyId
   * @param {(string|undefined)[]} [opts.relVersions]  pinned generation/etag per key
   * @param {number} [opts.groupBytes]      page-group size (default 1MB)
   * @param {import('@zeropg/blobstore').BlobStore} opts.prefetchStore  async store on the main thread for frontrunning
   */
  constructor({ provider, gcs, r2, relKeys, relVersions, groupBytes = DEFAULT_GROUP_BYTES, prefetchStore }) {
    this.provider = provider
    this.relKeys = relKeys
    this.relVersions = relVersions
    this.groupBytes = groupBytes
    this.prefetchStore = prefetchStore

    // group cache: Map<keyId, Map<groupIdx, Uint8Array>>
    this.cache = new Map()

    // telemetry
    this.syncFaults = 0 // synchronous (request-path) group GETs through the worker
    this.prefetchFaults = 0 // background group GETs via prefetchStore
    this.cacheHits = 0 // sub-range reads served entirely from cache (no GET)
    this.bytesPulled = 0 // total object bytes fetched (sync + prefetch)
    this.latencies = [] // { keyId, groupIdx, latUs, coldProc, via }

    this.controlSab = new SharedArrayBuffer(CTRL_SLOTS * 4)
    this.dataSab = new SharedArrayBuffer(groupBytes)
    this.ctrl = new Int32Array(this.controlSab)
    this.data = new Uint8Array(this.dataSab)

    this.worker = new Worker(buildWorkerBundle(), {
      workerData: {
        controlSab: this.controlSab,
        dataSab: this.dataSab,
        provider,
        gcs,
        r2,
        relKeys,
        relVersions: relVersions ?? null,
        groupBytes,
      },
    })
    this.worker.on('message', (m) => {
      if (m?.type === 'error') this._lastWorkerError = m.message
    })
    this.worker.unref() // do not keep the process alive on its own
  }

  _cacheGet(keyId, groupIdx) {
    const m = this.cache.get(keyId)
    return m ? m.get(groupIdx) : undefined
  }
  _cachePut(keyId, groupIdx, buf) {
    let m = this.cache.get(keyId)
    if (!m) {
      m = new Map()
      this.cache.set(keyId, m)
    }
    m.set(groupIdx, buf)
  }

  /** SYNCHRONOUS: ensure (keyId, groupIdx) is cached, blocking on the worker if
   *  it must be fetched. Returns the cached group bytes. */
  ensureGroupSync(keyId, groupIdx) {
    const hit = this._cacheGet(keyId, groupIdx)
    if (hit !== undefined) return hit

    Atomics.store(this.ctrl, KEY_ID, keyId)
    Atomics.store(this.ctrl, GROUP_IDX, groupIdx)
    Atomics.store(this.ctrl, RESPONSE, 0)
    Atomics.store(this.ctrl, REQUEST, 1)
    Atomics.notify(this.ctrl, REQUEST, 1)
    // Block the calling (main) thread until the worker publishes the group.
    Atomics.wait(this.ctrl, RESPONSE, 0)

    const n = Atomics.load(this.ctrl, RESULT)
    if (n < 0) {
      throw new FsError('EIO', `bridge fault failed for key ${keyId} group ${groupIdx}: ${this._lastWorkerError ?? 'unknown'}`)
    }
    const latUs = Atomics.load(this.ctrl, LAT_US)
    const coldProc = Atomics.load(this.ctrl, COLD_PROC)
    const buf = new Uint8Array(n)
    buf.set(this.data.subarray(0, n))
    this._cachePut(keyId, groupIdx, buf)
    this.syncFaults++
    this.bytesPulled += n
    this.latencies.push({ keyId, groupIdx, latUs, coldProc, via: 'sync' })
    return buf
  }

  /** ASYNC: prefetch a list of {keyId, groupIdx} concurrently into the cache,
   *  for query-plan frontrunning. Uses the main-thread async store (separate
   *  client), so it can run several range-GETs in parallel between queries. */
  async prefetch(groups, concurrency = 8) {
    if (!this.prefetchStore) throw new Error('BucketBridge.prefetch: no prefetchStore configured')
    const todo = groups.filter(({ keyId, groupIdx }) => this._cacheGet(keyId, groupIdx) === undefined)
    let i = 0
    const worker = async () => {
      while (i < todo.length) {
        const { keyId, groupIdx } = todo[i++]
        if (this._cacheGet(keyId, groupIdx) !== undefined) continue
        const key = this.relKeys[keyId]
        const version = this.relVersions ? this.relVersions[keyId] : undefined
        const start = groupIdx * this.groupBytes
        const end = start + this.groupBytes - 1
        const opts = { range: { start, end } }
        if (version) opts.ifVersion = version
        const t0 = process.hrtime.bigint()
        const res = await this.prefetchStore.get(key, opts)
        const latUs = Number(process.hrtime.bigint() - t0) / 1000
        if (res) {
          this._cachePut(keyId, groupIdx, res.bytes)
          this.prefetchFaults++
          this.bytesPulled += res.bytes.length
          this.latencies.push({ keyId, groupIdx, latUs, coldProc: 0, via: 'prefetch' })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker))
  }

  /** Drain the worker's own latency log (cross-check against this.latencies). */
  async drainWorkerLatLog() {
    return new Promise((resolve) => {
      const onMsg = (m) => {
        if (m?.type === 'latLog') {
          this.worker.off('message', onMsg)
          resolve(m)
        }
      }
      this.worker.on('message', onMsg)
      this.worker.postMessage({ type: 'drainLatLog' })
    })
  }

  stats() {
    const lat = this.latencies.map((l) => l.latUs).sort((a, b) => a - b)
    const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0)
    const cold = this.latencies.filter((l) => l.coldProc === 1).map((l) => l.latUs)
    const warm = this.latencies.filter((l) => l.coldProc === 0 && l.via === 'sync').map((l) => l.latUs)
    return {
      syncFaults: this.syncFaults,
      prefetchFaults: this.prefetchFaults,
      cacheHits: this.cacheHits,
      bytesPulled: this.bytesPulled,
      groupsFetched: this.syncFaults + this.prefetchFaults,
      latP50Us: pct(50),
      latP99Us: pct(99),
      coldGetUs: cold.length ? Math.round(cold.reduce((a, b) => a + b, 0) / cold.length) : null,
      warmGetMeanUs: warm.length ? Math.round(warm.reduce((a, b) => a + b, 0) / warm.length) : null,
    }
  }

  close() {
    Atomics.store(this.ctrl, SHUTDOWN, 1)
    Atomics.store(this.ctrl, REQUEST, 1)
    Atomics.notify(this.ctrl, REQUEST, 1)
    return this.worker.terminate()
  }
}

// --------------------------------------------------------------------------
// LazyBucketFS: BaseFilesystem subclass that faults intercepted files via the
// bridge. Non-intercepted files (catalogs, control, WAL, the eager set) are
// backed by a real local datadir, exactly as the spike's LazyFS.
// --------------------------------------------------------------------------

export class LazyBucketFS extends BaseFilesystem {
  /**
   * @param {string} dataDir   local datadir holding the eager set + sparse placeholders
   * @param {object} opts
   * @param {BucketBridge} opts.bridge
   * @param {(realRelPath:string)=>number|undefined} opts.keyIdForPath  maps a
   *        relation segment path (relative to datadir, e.g. 'base/5/16384') to a
   *        bridge keyId, or undefined if the file is NOT lazy (served locally).
   * @param {boolean} [opts.debug]
   */
  constructor(dataDir, { bridge, keyIdForPath, debug = false } = {}) {
    super(dataDir, { debug })
    this.realRoot = nodePath.resolve(dataDir)
    this.bridge = bridge
    this.keyIdForPath = keyIdForPath
    this.groupBytes = bridge.groupBytes

    this.openHandlePaths = new Map()
    this.handleIdCounter = 1000

    this.faultReads = 0 // intercepted read() calls
    this.faultBytes = 0 // bytes returned through the fault path

    if (!fs.existsSync(this.realRoot)) fs.mkdirSync(this.realRoot, { recursive: true })
    this.root = { type: 'directory', mode: INITIAL_MODE.DIR, lastModified: Date.now(), children: {} }
    this.#scanInto(this.realRoot, this.root)
  }

  #scanInto(realDir, dirNode) {
    let entries
    try {
      entries = fs.readdirSync(realDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const realChild = nodePath.join(realDir, ent.name)
      if (ent.isDirectory()) {
        const child = { type: 'directory', mode: INITIAL_MODE.DIR, lastModified: Date.now(), children: {} }
        dirNode.children[ent.name] = child
        this.#scanInto(realChild, child)
      } else if (ent.isFile()) {
        dirNode.children[ent.name] = { type: 'file', mode: INITIAL_MODE.FILE, lastModified: Date.now(), backingPath: realChild }
      }
    }
  }

  #parts(path) {
    return path.split('/').filter(Boolean)
  }
  #realFor(path) {
    return nodePath.join(this.realRoot, ...this.#parts(path))
  }
  #relFor(path) {
    return this.#parts(path).join('/')
  }
  #resolve(path) {
    let node = this.root
    for (const part of this.#parts(path)) {
      if (node.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
      if (!Object.prototype.hasOwnProperty.call(node.children, part)) throw new FsError('ENOENT', 'No such file or directory: ' + path)
      node = node.children[part]
    }
    return node
  }
  #resolveParent(path) {
    const parts = this.#parts(path)
    const name = parts.pop()
    let node = this.root
    for (const part of parts) {
      if (node.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
      if (!Object.prototype.hasOwnProperty.call(node.children, part)) throw new FsError('ENOENT', 'No such file or directory: ' + path)
      node = node.children[part]
    }
    return { parent: node, name }
  }
  #getPathFromFd(fd) {
    const path = this.openHandlePaths.get(fd)
    if (path === undefined) throw new FsError('EBADF', 'Bad file descriptor')
    return path
  }
  #nextHandleId() {
    return ++this.handleIdCounter
  }
  #statFor(node, backingPath) {
    const size = node.type === 'file' && fs.existsSync(backingPath) ? fs.statSync(backingPath).size : 0
    const blksize = 4096
    return {
      dev: 0, ino: 0, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size, blksize, blocks: Math.ceil(size / blksize),
      atime: node.lastModified, mtime: node.lastModified, ctime: node.lastModified,
    }
  }

  // ---- API ----------------------------------------------------------------

  chmod(path, mode) {
    this.#resolve(path).mode = mode
  }
  close(fd) {
    this.openHandlePaths.delete(fd)
  }
  fstat(fd) {
    return this.lstat(this.#getPathFromFd(fd))
  }
  lstat(path) {
    return this.#statFor(this.#resolve(path), this.#realFor(path))
  }
  mkdir(path, options) {
    const { parent, name } = this.#resolveParent(path)
    if (parent.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
    if (Object.prototype.hasOwnProperty.call(parent.children, name)) throw new FsError('EEXIST', 'File exists')
    parent.children[name] = { type: 'directory', mode: options?.mode || INITIAL_MODE.DIR, lastModified: Date.now(), children: {} }
    fs.mkdirSync(this.#realFor(path), { recursive: true })
  }
  open(path) {
    const node = this.#resolve(path)
    if (node.type !== 'file') throw new FsError('EISDIR', 'Is a directory')
    const fd = this.#nextHandleId()
    this.openHandlePaths.set(fd, path)
    return fd
  }
  readdir(path) {
    const node = this.#resolve(path)
    if (node.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
    return Object.keys(node.children)
  }

  read(fd, buffer, offset, length, position) {
    const path = this.#getPathFromFd(fd)
    const node = this.#resolve(path)
    if (node.type !== 'file') throw new FsError('EISDIR', 'Is a directory')
    const relPath = this.#relFor(path)
    const keyId = this.keyIdForPath ? this.keyIdForPath(relPath) : undefined

    if (keyId !== undefined) {
      // THE FAULT: serve [position, position+length) out of the 1MB page-group(s)
      // it spans, faulting any missing group through the bridge (one range-GET
      // per group, the rest of the group served from cache).
      let written = 0
      const lastByte = position + length - 1
      const firstGroup = Math.floor(position / this.groupBytes)
      const lastGroup = Math.floor(lastByte / this.groupBytes)
      for (let g = firstGroup; g <= lastGroup; g++) {
        const hadIt = this.bridge._cacheGet(keyId, g) !== undefined
        const grp = this.bridge.ensureGroupSync(keyId, g)
        if (hadIt) this.bridge.cacheHits++
        const groupStart = g * this.groupBytes
        const within = Math.max(0, position + written - groupStart)
        if (within >= grp.length) break // requested past EOF
        const take = Math.min(length - written, grp.length - within)
        buffer.set(grp.subarray(within, within + take), offset + written)
        written += take
      }
      this.faultReads++
      this.faultBytes += written
      return written
    }

    const dfd = fs.openSync(this.#realFor(path), 'r')
    try {
      return fs.readSync(dfd, buffer, offset, length, position)
    } finally {
      fs.closeSync(dfd)
    }
  }

  rename(oldPath, newPath) {
    const { parent: oldParent, name: oldName } = this.#resolveParent(oldPath)
    if (!Object.prototype.hasOwnProperty.call(oldParent.children, oldName)) throw new FsError('ENOENT', 'No such file or directory: ' + oldPath)
    const node = oldParent.children[oldName]
    const { parent: newParent, name: newName } = this.#resolveParent(newPath)
    delete oldParent.children[oldName]
    newParent.children[newName] = node
    fs.renameSync(this.#realFor(oldPath), this.#realFor(newPath))
  }
  rmdir(path) {
    const { parent, name } = this.#resolveParent(path)
    const node = parent.children[name]
    if (!node) throw new FsError('ENOENT', 'No such file or directory: ' + path)
    if (node.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
    if (Object.keys(node.children).length > 0) throw new FsError('ENOTEMPTY', 'Directory not empty')
    delete parent.children[name]
    try { fs.rmdirSync(this.#realFor(path)) } catch {}
  }
  truncate(path, len = 0) {
    const node = this.#resolve(path)
    if (node.type !== 'file') throw new FsError('EISDIR', 'Is a directory')
    const realPath = this.#realFor(path)
    if (!fs.existsSync(realPath)) fs.writeFileSync(realPath, Buffer.alloc(0))
    fs.truncateSync(realPath, len)
  }
  unlink(path) {
    const { parent, name } = this.#resolveParent(path)
    const node = parent.children[name]
    if (!node) throw new FsError('ENOENT', 'No such file or directory: ' + path)
    if (node.type !== 'file') throw new FsError('EISDIR', 'Is a directory')
    delete parent.children[name]
    try { fs.unlinkSync(this.#realFor(path)) } catch {}
  }
  utimes(path, _atime, mtime) {
    this.#resolve(path).lastModified = mtime
  }
  writeFile(path, data, options) {
    const { parent, name } = this.#resolveParent(path)
    if (parent.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
    let node = parent.children[name]
    const realPath = this.#realFor(path)
    if (!node) {
      node = { type: 'file', mode: options?.mode ? options.mode : INITIAL_MODE.FILE, lastModified: Date.now(), backingPath: realPath }
      parent.children[name] = node
    } else {
      node.lastModified = Date.now()
    }
    if ((node.mode & S_IFMT) === 0) node.mode |= INITIAL_MODE.FILE
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length)
    fs.writeFileSync(realPath, buf)
  }
  write(fd, buffer, offset, length, position) {
    const path = this.#getPathFromFd(fd)
    const node = this.#resolve(path)
    if (node.type !== 'file') throw new FsError('EISDIR', 'Is a directory')
    const realPath = this.#realFor(path)
    const view = new Uint8Array(buffer, offset, length)
    const wfd = fs.openSync(realPath, fs.existsSync(realPath) ? 'r+' : 'w+')
    try {
      return fs.writeSync(wfd, view, 0, length, position)
    } finally {
      fs.closeSync(wfd)
    }
  }
}

export { ERRNO_CODES }
