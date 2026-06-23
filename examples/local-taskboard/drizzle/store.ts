// Drizzle implementation of the app's Store, over a local zeropg Postgres.
// resolveDatabaseUrl(file:…) -> postgres:// URL -> ordinary node-postgres + Drizzle.

import { resolveDatabaseUrl, type LocalHandle } from '@zeropg/client'
import { drizzle } from 'drizzle-orm/node-postgres'
import { asc, eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { boards, tasks } from './schema.ts'
import { STATUSES, type Board, type Status, type Store, type Task } from '../src/types.ts'

export function createStore(): Store {
  const target = process.env.DATABASE_URL ?? 'file:./.pgdata-drizzle'
  let handle: LocalHandle
  let pool: Pool
  let db: ReturnType<typeof drizzle<{ boards: typeof boards; tasks: typeof tasks }>>

  return {
    async init() {
      handle = await resolveDatabaseUrl(target)
      pool = new Pool({ connectionString: handle.url })
      db = drizzle(pool, { schema: { boards, tasks } })
      await db.execute(sql`create table if not exists boards (id serial primary key, name text not null)`)
      await db.execute(sql`create table if not exists tasks (
        id serial primary key, board_id integer not null, title text not null,
        status text not null default 'todo')`)
    },
    async listBoards(): Promise<Board[]> {
      return db.select().from(boards).orderBy(asc(boards.id))
    },
    async getBoard(id) {
      const [board] = await db.select().from(boards).where(eq(boards.id, id))
      if (!board) return null
      const ts = await db.select().from(tasks).where(eq(tasks.boardId, id)).orderBy(asc(tasks.id))
      return { board, tasks: ts as Task[] }
    },
    async createBoard(name) {
      const [b] = await db.insert(boards).values({ name }).returning()
      return b
    },
    async addTask(boardId, title) {
      await db.insert(tasks).values({ boardId, title, status: 'todo' })
    },
    async cycleTask(id) {
      const [t] = await db.select().from(tasks).where(eq(tasks.id, id))
      if (!t) return
      const next = STATUSES[(STATUSES.indexOf(t.status as Status) + 1) % STATUSES.length]
      await db.update(tasks).set({ status: next }).where(eq(tasks.id, id))
    },
    async deleteTask(id) {
      await db.delete(tasks).where(eq(tasks.id, id))
    },
    async close() {
      await pool.end()
      await handle.close()
    },
  }
}
