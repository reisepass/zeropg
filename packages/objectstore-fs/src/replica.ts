// ZeroPGReplica — a read-only follower whose source of truth is the bucket.
//
// No lease, no writes, no coordination with the writer: it polls
// manifest.json (a Class B read, ~$0.0004 per thousand) and, when the commit
// point moves, re-materializes the new state in a fresh scratch directory and
// atomically swaps the live PGlite instance. Queries keep running against the
// old state during a refresh; staleness is bounded by the poll interval plus
// one restore.
//
// Why re-materialize instead of applying WAL to the running instance: PGlite
// replays WAL only through crash recovery at boot (no streaming-replication
// walreceiver in single-user WASM). Restore cost is the snapshot + segment
// download — seconds for the MB-to-tens-of-MB databases this targets. A
// page-server-style lazy follower is a v3 investigation (see RESEARCH-NOTES).

import { PGlite } from '@electric-sql/pglite'
import { type BlobStore } from '@zeropg/blobstore'
import { type Manifest, MANIFEST_KEY, decodeManifest } from './manifest.js'
import { restoreSnapshotInto, applyWalSegments } from './restore.js'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ZeroPGReplicaOptions {
  store: BlobStore
  /** Poll manifest.json every N ms. 0 disables auto-polling (call refresh()
   * yourself). Default 5000. */
  pollIntervalMs?: number
  /** Local scratch directory. Default: os.tmpdir()/zeropg. */
  scratchDir?: string
}

export class ZeroPGReplica {
  readonly store: BlobStore
  private pg!: PGlite
  private manifest!: Manifest
  private manifestEtag!: string
  private scratchBase: string
  private dataDir!: string
  private pollMs: number
  private pollTimer: NodeJS.Timeout | null = null
  private refreshInFlight: Promise<boolean> | null = null
  private closed = false

  /** Restore timing of the most recent (re)materialization, ms. */
  lastRestoreMs = 0
  /** When the currently served commit was made (writer clock). */
  get committedAt(): string {
    return this.manifest.committedAt
  }
  get commitSeq(): number {
    return this.manifest.commitSeq
  }
  get currentManifest(): Manifest {
    return this.manifest
  }
  /** The underlying PGlite instance (read-only by session default). */
  get raw(): PGlite {
    return this.pg
  }

  private constructor(opts: ZeroPGReplicaOptions) {
    this.store = opts.store
    this.scratchBase = opts.scratchDir ?? join(tmpdir(), 'zeropg')
    this.pollMs = opts.pollIntervalMs ?? 5000
  }

  static async open(opts: ZeroPGReplicaOptions): Promise<ZeroPGReplica> {
    const r = new ZeroPGReplica(opts)
    const cur = await r.store.get(MANIFEST_KEY)
    if (!cur) throw new Error('no database at this prefix (missing manifest.json)')
    const m = decodeManifest(cur.bytes)
    if (m.movedTo) {
      throw new Error(`this database was migrated out to ${m.movedTo}`)
    }
    await r.materialize(m, cur.etag)
    if (r.pollMs > 0) {
      r.pollTimer = setInterval(() => void r.refresh().catch(() => {}), r.pollMs)
      r.pollTimer.unref?.()
    }
    return r
  }

  /** Build the manifest's state in a fresh dir, swap it in, drop the old. */
  private async materialize(m: Manifest, etag: string): Promise<void> {
    const t0 = performance.now()
    const dir = join(
      this.scratchBase,
      `replica-${process.pid}-${Math.abs(Number(etag) % 1_000_000_007)}-${m.commitSeq}`,
    )
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await restoreSnapshotInto(this.store, dir, m.snapshot)
      await applyWalSegments(this.store, dir, m)
      const pg = await PGlite.create({ dataDir: dir })
      await pg.waitReady
      // Belt-and-suspenders read-only: sessions reject writes. (The real
      // guarantee is that a replica never holds the lease and never CASes
      // the manifest — it cannot affect the bucket even if this is bypassed.)
      await pg.exec('SET default_transaction_read_only = on')
      const oldPg = this.pg
      const oldDir = this.dataDir
      this.pg = pg
      this.dataDir = dir
      this.manifest = m
      this.manifestEtag = etag
      if (oldPg) {
        await oldPg.close().catch(() => {})
        await rm(oldDir, { recursive: true, force: true }).catch(() => {})
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
    this.lastRestoreMs = performance.now() - t0
  }

  /**
   * Check the bucket for a newer commit; re-materialize if found. Returns
   * true when the served state advanced. Concurrent callers coalesce.
   */
  async refresh(): Promise<boolean> {
    if (this.closed) throw new Error('replica is closed')
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      try {
        const head = await this.store.head(MANIFEST_KEY)
        if (!head || head.etag === this.manifestEtag) return false
        const cur = await this.store.get(MANIFEST_KEY)
        if (!cur || cur.etag === this.manifestEtag) return false
        const m = decodeManifest(cur.bytes)
        if (m.movedTo) throw new Error(`database migrated out to ${m.movedTo}`)
        await this.materialize(m, cur.etag)
        return true
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    const r = await this.pg.query<T>(sql, params)
    return { rows: r.rows }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.refreshInFlight) await this.refreshInFlight.catch(() => {})
    await this.pg.close()
    await rm(this.dataDir, { recursive: true, force: true }).catch(() => {})
  }
}
