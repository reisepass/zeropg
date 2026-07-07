// One-click external editors for the console.
//
// pgweb: MIT, single static Go binary, zero deps. The console launches it
// PINNED to a served wire's postgres:// URL, so the browser link lands already
// connected - no login form (survey: docs/LIGHT-PG-EDITORS-SURVEY.md).
// Binary discovery: $PATH -> ~/.zeropg/bin/pgweb -> auto-download the release
// asset for this platform into ~/.zeropg/bin (one ~5MB zip, once).
//
// Everything binds 127.0.0.1, keeping the console's loopback-only rule; no
// Docker involved.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'

const execFileP = promisify(execFile)

const PGWEB_VERSION = 'v0.17.0'

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => res(port))
    })
  })
}

function releaseAsset(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
  if (!os || !arch) throw new Error(`pgweb: unsupported platform ${process.platform}/${process.arch} - install pgweb on PATH instead`)
  return `pgweb_${os}_${arch}`
}

async function onPath(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('which', [cmd])
    const p = stdout.trim()
    return p || null
  } catch {
    return null
  }
}

/** Locate the pgweb binary: PATH -> ~/.zeropg/bin -> download once. */
export async function ensurePgweb(): Promise<string> {
  const fromPath = await onPath('pgweb')
  if (fromPath) return fromPath
  const binDir = join(homedir(), '.zeropg', 'bin')
  const dest = join(binDir, 'pgweb')
  if (existsSync(dest)) return dest
  mkdirSync(binDir, { recursive: true })
  const asset = releaseAsset()
  const url = `https://github.com/sosedoff/pgweb/releases/download/${PGWEB_VERSION}/${asset}.zip`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`pgweb download failed (${res.status}) from ${url} - install pgweb on PATH (brew install pgweb) instead`)
  const zipPath = join(binDir, `${asset}.zip`)
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()))
  await execFileP('unzip', ['-o', zipPath, '-d', binDir])
  renameSync(join(binDir, asset), dest)
  chmodSync(dest, 0o755)
  return dest
}

export interface EditorProc {
  tool: 'pgweb'
  /** Same id as the Served entry it fronts. */
  targetId: string
  url: string
  port: number
  stop(): Promise<void>
}

const editors = new Map<string, EditorProc>()

export function listEditors(): Array<Omit<EditorProc, 'stop'>> {
  return [...editors.values()].map(({ stop: _stop, ...rest }) => rest)
}

/** Launch pgweb pinned to a served wire. Idempotent per target.
 *  `prefix` serves pgweb under /<prefix>/ (pgweb --prefix) so a reverse proxy
 *  can mount it on a subpath - the inspector mode does this. */
export async function launchPgweb(targetId: string, wireUrl: string, opts: { prefix?: string } = {}): Promise<EditorProc> {
  const key = `pgweb:${targetId}`
  const existing = editors.get(key)
  if (existing) return existing
  const bin = await ensurePgweb()
  const port = await freePort()
  const args = ['--url', wireUrl, '--bind', '127.0.0.1', '--listen', String(port), '--skip-open']
  if (opts.prefix) args.push('--prefix', opts.prefix)
  const child: ChildProcess = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d))
  const basePath = opts.prefix ? `/${opts.prefix}/` : '/'
  // wait until it answers (pgweb starts in tens of ms; connect errors exit fast)
  const deadline = Date.now() + 10_000
  let up = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pgweb exited: ${stderr.trim().split('\n').pop() ?? child.exitCode}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}${basePath}api/info`)
      if (r.ok) {
        up = true
        break
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!up) {
    child.kill('SIGTERM')
    throw new Error(`pgweb did not come up in 10s${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)
  }
  const entry: EditorProc = {
    tool: 'pgweb',
    targetId,
    port,
    url: `http://127.0.0.1:${port}${basePath}`,
    stop: async () => {
      editors.delete(key)
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          r()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(t)
          r()
        })
      })
    },
  }
  child.once('exit', () => editors.delete(key))
  editors.set(key, entry)
  return entry
}

export async function stopEditor(targetId: string): Promise<boolean> {
  const e = editors.get(`pgweb:${targetId}`)
  if (!e) return false
  await e.stop()
  return true
}

export async function stopAllEditors(): Promise<void> {
  await Promise.allSettled([...editors.values()].map((e) => e.stop()))
}
