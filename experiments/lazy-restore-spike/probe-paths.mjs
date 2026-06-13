// Probe: what paths does BaseFilesystem receive from EMFS? Subclass it, log the
// first handful of open/lstat calls, then exit. Throwaway diagnostic.
import { BaseFilesystem } from '@electric-sql/pglite/basefs'
import { PGlite } from '@electric-sql/pglite'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

class ProbeFS extends BaseFilesystem {
  seen = []
  log(op, p) { if (this.seen.length < 25) this.seen.push(op + ' ' + p) }
  chmod(p) { this.log('chmod', p) }
  close() {}
  fstat() { return { dev:0,ino:0,mode:33188,nlink:1,uid:0,gid:0,rdev:0,size:0,blksize:4096,blocks:0,atime:0,mtime:0,ctime:0 } }
  lstat(p) { this.log('lstat', p); const e = new Error('nope'); e.code='ENOENT'; throw e }
  mkdir(p) { this.log('mkdir', p) }
  open(p) { this.log('open', p); const e=new Error('nope'); e.code='ENOENT'; throw e }
  readdir(p) { this.log('readdir', p); return [] }
  read() { return 0 }
  rename() {}
  rmdir() {}
  truncate() {}
  unlink() {}
  utimes() {}
  writeFile(p) { this.log('writeFile', p) }
  write() { return 0 }
}

const dir = mkdtempSync(join(tmpdir(), 'probe-'))
const fsImpl = new ProbeFS(dir)
try {
  const pg = new PGlite({ fs: fsImpl })
  await pg.waitReady
  await pg.close()
} catch (e) {
  console.log('threw (expected):', e.message?.slice(0, 80))
}
console.log('PATHS SEEN:')
for (const s of fsImpl.seen) console.log('  ', s)
