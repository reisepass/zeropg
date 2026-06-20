// The ONE line that changes from laptop to bucket to graduated Postgres: the
// connection string. Everything above this (migrations, the HTTP app, the UI)
// is engine-agnostic — it only ever sees the node-postgres-shaped Client.
//
//   DATABASE_URL=memory://                  ephemeral, in-process (tests, demos)
//   DATABASE_URL=file://./data/taskboard.db  local dev, durable on disk, lock-guarded
//   DATABASE_URL=https://my-zeropg.run.app   bucket-backed scale-to-zero in prod
//   DATABASE_URL=postgres://…                graduated to RDS / Cloud SQL / Neon

import { connect, type Client } from '@zeropg/client'
import { migrate } from './migrations.js'

export interface OpenedDb {
  db: Client
  appliedMigrations: number[]
}

/** Connect using DATABASE_URL (default file://./data/taskboard.db) and bring the
 * schema up to date before returning. The app never calls connect() directly. */
export async function openDb(url?: string): Promise<OpenedDb> {
  const target = url ?? process.env.DATABASE_URL ?? 'file://./data/taskboard.db'
  // ZEROPG_ACQUIRE_TIMEOUT_MS lets a hot-reloading dev server wait out the
  // previous process's file:// lock (the overlap window); a low value makes a
  // genuinely-contended second process fail fast instead of hanging.
  const acquireTimeoutMs = process.env.ZEROPG_ACQUIRE_TIMEOUT_MS
    ? Number(process.env.ZEROPG_ACQUIRE_TIMEOUT_MS)
    : undefined
  const db = await connect(target, { acquireTimeoutMs })
  // Remote scale-to-zero instances apply their own migrations at their boot, so
  // an external HTTP client must not also push DDL (single-applier invariant).
  const appliedMigrations = db.engine === 'remote' ? [] : await migrate(db)
  return { db, appliedMigrations }
}
