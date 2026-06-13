// LazyFS: a complete, boot-capable custom pglite Filesystem that subclasses the
// public BaseFilesystem (@electric-sql/pglite/basefs) and intercepts individual
// block reads on chosen relation segment files, serving them from a separate
// LOCAL "remote" store (a stand-in for an object store).
//
// Design (ported from OpfsAhpFS, src/fs/opfs-ahp.ts):
//   - An in-memory NODE TREE with EXPLICIT mode bits (FILE = 32768 = S_IFREG,
//     DIR = 16384 = S_IFDIR) so FS.isFile(node.mode) is true for new files.
//     This is what fixes the postmaster.pid `Bad file descriptor`: the previous
//     node:fs-backed version threw FsError with STRING errno codes, which
//     pglite's tryFSOperation forwards straight into FS.ErrnoError(code) as a
//     number - a malformed errno that broke the create path. We now (a) keep our
//     own node tree with real mode bits and (b) throw NUMERIC errno codes.
//   - Each file node maps to a real backing file on disk (backingPath), so the
//     datadir persists and can be pre-seeded / zeroed by the test fixture.
//   - read() for a path matching `interceptMatch` is served from the remote
//     store instead of the datadir backing file (this is where, in production,
//     the Atomics+SAB bridge would turn a remote range GET into a sync read).
//
// Synchronicity: read() is synchronous and (here) reads a local file. The bridge
// proven in bridge-bench.mjs is what makes a *remote* fetch synchronous in prod.

import { BaseFilesystem, ERRNO_CODES } from '@electric-sql/pglite/basefs'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'

// S_IFDIR | 0o755 and S_IFREG | 0o644 - include permission bits so Postgres's
// access() checks pass (a bare 16384/32768 with no rwx bits => Permission denied).
const INITIAL_MODE = { DIR: 16384 | 0o755, FILE: 32768 | 0o644 } // S_IFDIR / S_IFREG
const S_IFMT = 0xf000

class FsError extends Error {
  // pglite's tryFSOperation forwards e.code directly into FS.ErrnoError, which
  // expects a NUMBER. Map string codes to numbers via ERRNO_CODES.
  constructor(code, message) {
    super(message)
    this.name = 'FsError'
    if (typeof code === 'number') this.code = code
    else if (typeof code === 'string') this.code = ERRNO_CODES[code]
  }
}

export class LazyFS extends BaseFilesystem {
  /**
   * @param {string} dataDir   real local datadir to mirror/back the FS
   * @param {object} opts
   * @param {(realPath:string)=>boolean} opts.interceptMatch  predicate on backing path
   * @param {string} opts.remoteDir  dir holding "remote" copies of intercepted files
   * @param {(ev:object)=>void} [opts.onFault]  callback per intercepted read (for the sweep model)
   * @param {boolean} [opts.debug]
   */
  constructor(dataDir, { interceptMatch, remoteDir, onFault, debug = false } = {}) {
    super(dataDir, { debug })
    this.realRoot = nodePath.resolve(dataDir)
    this.interceptMatch = interceptMatch
    this.remoteDir = remoteDir
    this.onFault = onFault

    // fd bookkeeping
    this.openHandlePaths = new Map() // fd -> pgdata path ('/...')
    this.handleIdCounter = 1000

    // observability
    this.readLog = []
    this.interceptedReadCount = 0
    this.interceptedBytes = 0

    if (!fs.existsSync(this.realRoot)) fs.mkdirSync(this.realRoot, { recursive: true })
    if (this.remoteDir && !fs.existsSync(this.remoteDir)) {
      fs.mkdirSync(this.remoteDir, { recursive: true })
    }

    // Build the node tree by scanning the existing datadir on disk.
    this.root = { type: 'directory', mode: INITIAL_MODE.DIR, lastModified: Date.now(), children: {} }
    this.#scanInto(this.realRoot, this.root)
  }

  // ---- tree construction / helpers --------------------------------------

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
        const child = {
          type: 'directory',
          mode: INITIAL_MODE.DIR,
          lastModified: Date.now(),
          children: {},
        }
        dirNode.children[ent.name] = child
        this.#scanInto(realChild, child)
      } else if (ent.isFile()) {
        dirNode.children[ent.name] = {
          type: 'file',
          mode: INITIAL_MODE.FILE,
          lastModified: Date.now(),
          backingPath: realChild,
        }
      }
      // (symlinks etc. ignored - the pglite datadir has none)
    }
  }

  #parts(path) {
    return path.split('/').filter(Boolean)
  }

  // Map a PGDATA path ('/base/5/16384') to a real backing path under realRoot.
  #realFor(path) {
    return nodePath.join(this.realRoot, ...this.#parts(path))
  }

  #resolve(path) {
    let node = this.root
    for (const part of this.#parts(path)) {
      if (node.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
      if (!Object.prototype.hasOwnProperty.call(node.children, part)) {
        throw new FsError('ENOENT', 'No such file or directory: ' + path)
      }
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
      if (!Object.prototype.hasOwnProperty.call(node.children, part)) {
        throw new FsError('ENOENT', 'No such file or directory: ' + path)
      }
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
    const size =
      node.type === 'file' && fs.existsSync(backingPath) ? fs.statSync(backingPath).size : 0
    const blksize = 4096
    return {
      dev: 0, ino: 0, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size, blksize, blocks: Math.ceil(size / blksize),
      atime: node.lastModified, mtime: node.lastModified, ctime: node.lastModified,
    }
  }

  #remoteFor(realPath) {
    const rel = nodePath.relative(this.realRoot, realPath)
    return nodePath.join(this.remoteDir, rel)
  }

  // ---- Filesystem API ----------------------------------------------------

  chmod(path, mode) {
    const node = this.#resolve(path)
    node.mode = mode
  }

  close(fd) {
    this.openHandlePaths.delete(fd)
  }

  fstat(fd) {
    const path = this.#getPathFromFd(fd)
    return this.lstat(path)
  }

  lstat(path) {
    const node = this.#resolve(path)
    return this.#statFor(node, this.#realFor(path))
  }

  mkdir(path, options) {
    const { parent, name } = this.#resolveParent(path)
    if (parent.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
    if (Object.prototype.hasOwnProperty.call(parent.children, name)) {
      throw new FsError('EEXIST', 'File exists')
    }
    parent.children[name] = {
      type: 'directory',
      mode: options?.mode || INITIAL_MODE.DIR,
      lastModified: Date.now(),
      children: {},
    }
    fs.mkdirSync(this.#realFor(path), { recursive: true })
  }

  open(path, _flags, _mode) {
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
    const realPath = this.#realFor(path)

    const intercepted = !!(this.interceptMatch && this.interceptMatch(realPath))
    if (intercepted) {
      // THE INTERCEPT: serve these bytes from the remote store, not the datadir
      // file. In production this is a range GET + decode through the SAB bridge.
      const remotePath = this.#remoteFor(realPath)
      const rfd = fs.openSync(remotePath, 'r')
      let n
      try {
        n = fs.readSync(rfd, buffer, offset, length, position)
      } finally {
        fs.closeSync(rfd)
      }
      this.interceptedReadCount++
      this.interceptedBytes += n
      if (this.readLog.length < 100000) {
        this.readLog.push({
          path: nodePath.relative(this.realRoot, realPath),
          position, length, got: n, source: 'remote',
        })
      }
      if (this.onFault) {
        this.onFault({ path: nodePath.relative(this.realRoot, realPath), position, length, got: n })
      }
      if (this.debug) {
        console.log('[LazyFS] INTERCEPT read', path, 'pos', position, 'len', length, '-> got', n)
      }
      return n
    }

    const dfd = fs.openSync(realPath, 'r')
    try {
      return fs.readSync(dfd, buffer, offset, length, position)
    } finally {
      fs.closeSync(dfd)
    }
  }

  rename(oldPath, newPath) {
    const { parent: oldParent, name: oldName } = this.#resolveParent(oldPath)
    if (!Object.prototype.hasOwnProperty.call(oldParent.children, oldName)) {
      throw new FsError('ENOENT', 'No such file or directory: ' + oldPath)
    }
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
    const node = this.#resolve(path)
    node.lastModified = mtime
  }

  writeFile(path, data, options) {
    // This is the mknod/create hook. Ensure a file NODE exists with FILE mode
    // bits (so FS.isFile is true) and a real backing file.
    const { parent, name } = this.#resolveParent(path)
    if (parent.type !== 'directory') throw new FsError('ENOTDIR', 'Not a directory')
    let node = parent.children[name]
    const realPath = this.#realFor(path)
    if (!node) {
      node = {
        type: 'file',
        mode: options?.mode ? options.mode : INITIAL_MODE.FILE,
        lastModified: Date.now(),
        backingPath: realPath,
      }
      parent.children[name] = node
    } else {
      node.lastModified = Date.now()
    }
    // Force a regular-file type bit regardless of what mknod passed, so
    // FS.isFile(node.mode) holds even if mknod handed a bare permission mode.
    if ((node.mode & S_IFMT) === 0) node.mode |= INITIAL_MODE.FILE
    const buf =
      typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length)
    fs.writeFileSync(realPath, buf)
  }

  write(fd, buffer, offset, length, position) {
    const path = this.#getPathFromFd(fd)
    const node = this.#resolve(path)
    if (node.type !== 'file') throw new FsError('EISDIR', 'Is a directory')
    const realPath = this.#realFor(path)
    // pglite's stream_ops.write hands us the raw ArrayBuffer (src/fs/base.ts:465).
    // Build a view over [offset, offset+length) and write it at the file position
    // (mirrors OpfsAhpFS.write, src/fs/opfs-ahp.ts:642).
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
