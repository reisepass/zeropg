// Schema migrations, applied by the instance to ITSELF at boot (the single-applier
// pattern from ORM-ADAPTER-NOTES.md: migrations are writes, and zeropg has exactly
// one writer holding the lease — so the right place to apply DDL is the instance,
// under that lease, never an external engine pushing DDL over the wire). Forward-only,
// idempotent, tracked in a _migrations table so each runs exactly once.

import type { Client } from '@zeropg/client'

export interface Migration {
  id: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE tasks (
        id        serial PRIMARY KEY,
        title     text NOT NULL,
        status    text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
        priority  int  NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
        created_at timestamptz NOT NULL DEFAULT now(),
        done_at    timestamptz
      );
      CREATE INDEX tasks_status_idx ON tasks (status, priority, id);
    `,
  },
  {
    id: 2,
    name: 'add-notes',
    sql: `ALTER TABLE tasks ADD COLUMN notes text NOT NULL DEFAULT '';`,
  },
]

/** Apply every migration not yet recorded, each in its own transaction, in id
 * order. Safe to call on every boot. Returns the ids actually applied this run. */
export async function migrate(db: Client): Promise<number[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id int PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  const { rows } = await db.query<{ id: number }>('SELECT id FROM _migrations')
  const done = new Set(rows.map((r) => r.id))
  const applied: number[] = []
  for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue
    await db.transaction(async (tx) => {
      await tx.exec(m.sql)
      await tx.query('INSERT INTO _migrations (id, name) VALUES ($1, $2)', [m.id, m.name])
    })
    applied.push(m.id)
  }
  return applied
}
