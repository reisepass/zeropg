// SKELETON — NOT YET DEPLOYED. zeropg on Cloudflare: a Durable Object per
// database owns the PGlite instance and persists to R2 (DESIGN.md 4.7, TODO
// B4). This file typechecks standalone but has NOT run on Cloudflare — this VM
// has no CF credentials and no wrangler. It is the porting target, not a result.
//
// Why the DO tier (the recommendation, see docs/R2.md):
//   - The platform guarantees a single, globally-unique, single-threaded
//     instance per DO id. That is exactly "one writer", for free — so the
//     zeropg lease becomes belt-and-suspenders (still kept: it fences against
//     a stale instance during a migration/restart window, and it is the SAME
//     code path proven on GCS/Cloud Run).
//   - R2 underneath is the generation store; the DO is the single-writer
//     compute. Free R2 egress is what later makes the CDN-seeded read replica
//     and browser-PGlite story free (TODO B6).
//
// To actually deploy (when creds exist): add @cloudflare/workers-types, a
// wrangler.toml binding the DO class + an R2 bucket (or S3 creds as secrets),
// then `wrangler deploy`. The S3-API R2BlobStore used here runs unchanged
// inside a Worker; a future binding-backed BlobStore (env.BUCKET) is a drop-in.

import { R2BlobStore, type R2Options } from '@zeropg/blobstore'
// In a real deploy: import { ZeroPG } from '@zeropg/objectstore-fs'
// PGlite-in-Workers needs the WASM build + a writable scratch dir; on Workers
// that is the DO's transactional storage / an in-memory FS, not /tmp. Flagged
// in docs/R2.md as the one porting unknown (Cloud Run uses tmpfs at /tmp).

// ---- minimal ambient Cloudflare types (stand in for @cloudflare/workers-types)
interface DurableObjectState {
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
  waitUntil(p: Promise<unknown>): void
  storage: { setAlarm(ts: number): Promise<void> }
}
interface Env {
  // S3 credentials for R2, provided as Worker secrets.
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  ZEROPG_DO: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }
}

function storeFor(env: Env, dbName: string): R2BlobStore {
  const opts: R2Options = {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    prefix: `apps/${dbName}`,
  }
  return new R2BlobStore(opts)
}

/**
 * One Durable Object instance == one database == one writer. The platform
 * pins it to a single thread globally; we open ZeroPG once (lazily) and reuse
 * it across requests, flushing on the DO alarm and on eviction via waitUntil.
 */
export class ZeroPGDurableObject {
  private state: DurableObjectState
  private env: Env
  // private db: ZeroPG | null = null   // opened lazily in a real deploy
  private store: R2BlobStore | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const dbName = url.searchParams.get('db') ?? 'default'
    // blockConcurrencyWhile serialises the cold-open so concurrent requests to
    // a freshly-woken DO all wait on one restore (mirrors Cloud Run boot).
    if (!this.store) {
      await this.state.blockConcurrencyWhile(async () => {
        this.store = storeFor(this.env, dbName)
        // const seed = await loadEmptySnapshot()   // prebuilt empty-DB snapshot,
        //                                           // as on GCS: skips initdb's
        //                                           // CPU-time cost on Workers.
        // this.db = await ZeroPG.open({ store: this.store, durability: 'sleep', seedSnapshot: seed })
        // Schedule a relaxed-durability flush via the DO alarm (waitUntil-safe).
        await this.state.storage.setAlarm(Date.now() + 25_000)
      })
    }
    // const { rows } = await this.db!.query('SELECT 1 AS ok')
    return new Response(
      JSON.stringify({ skeleton: true, note: 'wire ZeroPG.open here', db: dbName }),
      { headers: { 'content-type': 'application/json' } },
    )
  }

  /** DO alarm == our relaxed-durability flush timer (replaces Cloud Run's
   * idle-flush backstop). Flush on the alarm; re-arm while still dirty. */
  async alarm(): Promise<void> {
    // const info = await this.db?.flush()
    // if (info) await this.state.storage.setAlarm(Date.now() + 25_000)
  }
}

/** The stateless Worker just routes each request to the DO that owns its
 * database id. Workers anywhere RPC the single owning DO. */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const dbName = url.searchParams.get('db') ?? 'default'
    const id = env.ZEROPG_DO.idFromName(dbName)
    return env.ZEROPG_DO.get(id).fetch(req)
  },
}
