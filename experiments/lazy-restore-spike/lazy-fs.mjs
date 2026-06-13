// LazyFS: a custom pglite Filesystem that subclasses the *public* BaseFilesystem
// (exported as @electric-sql/pglite/basefs) and overrides read() to intercept
// individual block reads on a chosen relation segment file.
//
// This is the thinnest shim that proves Step 3's claim: we can observe
// Postgres's block-read calls (offset/length per call) and SATISFY THEM
// OURSELVES from an alternate backing store, with byte-identical query results.
//
// Backing model (all LOCAL, no cloud):
//   - Every FS op is delegated to a real local datadir on disk via node:fs's
//     SYNCHRONOUS API (this mirrors what NODEFS does natively, but in JS so we
//     own the read path).
//   - For files whose path matches `interceptMatch`, reads do NOT come from the
//     datadir file. Instead they are served from a separate "remote store"
//     directory (a stand-in for an object store). The datadir copy can even be a
//     sparse/zeroed placeholder - we prove the bytes Postgres sees come from US.
//
// Synchronicity note: read() here is synchronous and reads from a local file.
// In the real design this is exactly where the Atomics+SAB bridge (Step 2)
// plugs in to make a *remote* fetch look synchronous. We keep it local here to
// isolate "does the intercept fire and return correct bytes" from "can a sync
// call do async I/O" (already proven separately in bridge-bench.mjs).

import { BaseFilesystem, ERRNO_CODES } from '@electric-sql/pglite/basefs'
import * as fs from 'node:fs'
import * as path from 'node:path'

class FsError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'FsError'
  }
}

export class LazyFS extends BaseFilesystem {
  /**
   * @param {string} dataDir   real local datadir backing the FS
   * @param {object} opts
   * @param {(path:string)=>boolean} opts.interceptMatch  predicate on real path
   * @param {string} opts.remoteDir  dir holding the "remote" copies of intercepted files
   * @param {boolean} [opts.debug]
   */
  constructor(dataDir, { interceptMatch, remoteDir, debug = false } = {}) {
    super(dataDir, { debug })
    this.realRoot = path.resolve(dataDir)
    this.interceptMatch = interceptMatch
    this.remoteDir = remoteDir
    // fd bookkeeping (BaseFilesystem hands us fds in read/write/close)
    this.fds = new Map() // fd -> { path, realFd, intercepted, remoteFd }
    this.nextFd = 1000
    // observability
    this.readLog = [] // { path, offset, length, position, source }
    this.interceptedReadCount = 0
    this.interceptedBytes = 0
    if (!fs.existsSync(this.realRoot)) fs.mkdirSync(this.realRoot, { recursive: true })
    if (this.remoteDir && !fs.existsSync(this.remoteDir)) {
      fs.mkdirSync(this.remoteDir, { recursive: true })
    }
  }

  // Map a PGDATA-relative path (what emscripten passes) to a real disk path.
  // BaseFilesystem's EMFS gives us absolute paths rooted at the mount opts.root,
  // which we set to realRoot via the path we return from realPath... but the
  // simplest robust approach: paths arrive already prefixed with realRoot
  // because EMFS.realPath joins mount.opts.root. We set opts.root = '' so paths
  // arrive as PGDATA-absolute ('/...'); we strip and re-root under realRoot.
  #real(p) {
    // p looks like '/<...>' (PGDATA tree). Strip leading slash, join to root.
    const rel = p.replace(/^\/+/, '')
    return path.join(this.realRoot, rel)
  }

  #remote(realPath) {
    const rel = path.relative(this.realRoot, realPath)
    return path.join(this.remoteDir, rel)
  }

  #wrap(fn) {
    try {
      return fn()
    } catch (e) {
      if (e instanceof FsError) throw e
      const code = e.code || 'EINVAL'
      throw new FsError(code, e.message)
    }
  }

  chmod(p, mode) {
    this.#wrap(() => fs.chmodSync(this.#real(p), mode))
  }

  close(fd) {
    const e = this.fds.get(fd)
    if (!e) return
    if (e.realFd != null) {
      try { fs.closeSync(e.realFd) } catch {}
    }
    if (e.remoteFd != null) {
      try { fs.closeSync(e.remoteFd) } catch {}
    }
    this.fds.delete(fd)
  }

  #statToFsStats(st) {
    return {
      dev: st.dev, ino: st.ino, mode: st.mode, nlink: st.nlink,
      uid: st.uid, gid: st.gid, rdev: st.rdev, size: st.size,
      blksize: st.blksize, blocks: st.blocks,
      atime: st.atimeMs, mtime: st.mtimeMs, ctime: st.ctimeMs,
    }
  }

  fstat(fd) {
    const e = this.fds.get(fd)
    if (!e) throw new FsError('EBADF', 'bad fd')
    return this.#wrap(() => this.#statToFsStats(fs.fstatSync(e.realFd)))
  }

  lstat(p) {
    return this.#wrap(() => this.#statToFsStats(fs.lstatSync(this.#real(p))))
  }

  mkdir(p, options) {
    this.#wrap(() => fs.mkdirSync(this.#real(p), options))
  }

  open(p, _flags, _mode) {
    const realPath = this.#real(p)
    const fd = this.nextFd++
    return this.#wrap(() => {
      // Open the datadir file read/write so writes (WAL, checkpoints) work.
      const realFd = fs.openSync(realPath, fs.existsSync(realPath) ? 'r+' : 'w+')
      const intercepted = !!(this.interceptMatch && this.interceptMatch(realPath))
      let remoteFd = null
      if (intercepted) {
        const remotePath = this.#remote(realPath)
        remoteFd = fs.openSync(remotePath, 'r')
        if (this.debug) console.log('[LazyFS] open INTERCEPTED', p, '-> remote', remotePath)
      }
      this.fds.set(fd, { path: realPath, realFd, intercepted, remoteFd })
      return fd
    })
  }

  readdir(p) {
    return this.#wrap(() => fs.readdirSync(this.#real(p)))
  }

  read(fd, buffer, offset, length, position) {
    const e = this.fds.get(fd)
    if (!e) throw new FsError('EBADF', 'bad fd')
    return this.#wrap(() => {
      if (e.intercepted) {
        // THE INTERCEPT: serve these bytes from the remote store, not the
        // datadir file. This is where a real impl would range-GET + decode via
        // the SAB bridge. We log the exact (position,length) Postgres asked for.
        const n = fs.readSync(e.remoteFd, buffer, offset, length, position)
        this.interceptedReadCount++
        this.interceptedBytes += n
        this.readLog.push({
          path: path.relative(this.realRoot, e.path),
          position, length, got: n, source: 'remote',
        })
        return n
      }
      return fs.readSync(e.realFd, buffer, offset, length, position)
    })
  }

  rename(oldPath, newPath) {
    this.#wrap(() => fs.renameSync(this.#real(oldPath), this.#real(newPath)))
  }

  rmdir(p) {
    this.#wrap(() => fs.rmdirSync(this.#real(p)))
  }

  truncate(p, len = 0) {
    this.#wrap(() => fs.truncateSync(this.#real(p), len))
  }

  unlink(p) {
    this.#wrap(() => fs.unlinkSync(this.#real(p)))
  }

  utimes(p, atime, mtime) {
    this.#wrap(() => fs.utimesSync(this.#real(p), atime / 1000, mtime / 1000))
  }

  writeFile(p, data, options) {
    this.#wrap(() => fs.writeFileSync(this.#real(p), data, options))
  }

  write(fd, buffer, offset, length, position) {
    const e = this.fds.get(fd)
    if (!e) throw new FsError('EBADF', 'bad fd')
    // NOTE: pglite's stream_ops.write hands us the raw ArrayBuffer (the whole
    // WASM heap), not a typed view (see src/fs/base.ts:465). Construct a view
    // over [offset, offset+length) and write it at the file position, mirroring
    // OpfsAhpFS.write (src/fs/opfs-ahp.ts:642).
    const view = new Uint8Array(buffer, offset, length)
    return this.#wrap(() => fs.writeSync(e.realFd, view, 0, length, position))
  }
}

export { ERRNO_CODES }
