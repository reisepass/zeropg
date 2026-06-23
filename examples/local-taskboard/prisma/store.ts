// Prisma implementation of the app's Store, over a local zeropg Postgres.
// resolveDatabaseUrl(file:…) -> postgres:// URL -> Prisma via @prisma/adapter-pg.
//
// Schema is applied with $executeRawUnsafe (a normal adapter query) so the app is
// self-contained; Prisma's native migrate/db-push engine can't drive single-session
// PGlite. In a real project, author with `zeropg migrate dev` + `zeropg migrate deploy`.

import { resolveDatabaseUrl, type LocalHandle } from '@zeropg/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/client/index.js'
import { STATUSES, type Status, type Store } from '../src/types.ts'

export function createStore(): Store {
  const target = process.env.DATABASE_URL ?? 'file:./.pgdata-prisma'
  let handle: LocalHandle
  let prisma: PrismaClient

  return {
    async init() {
      handle = await resolveDatabaseUrl(target)
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: handle.url }) })
      await prisma.$executeRawUnsafe(`create table if not exists "Board" (
        "id" serial primary key, "name" text not null)`)
      await prisma.$executeRawUnsafe(`create table if not exists "Task" (
        "id" serial primary key,
        "boardId" integer not null references "Board"("id") on delete cascade,
        "title" text not null, "status" text not null default 'todo')`)
    },
    async listBoards() {
      return prisma.board.findMany({ orderBy: { id: 'asc' } })
    },
    async getBoard(id) {
      const board = await prisma.board.findUnique({ where: { id } })
      if (!board) return null
      const tasks = await prisma.task.findMany({ where: { boardId: id }, orderBy: { id: 'asc' } })
      return { board, tasks }
    },
    async createBoard(name) {
      return prisma.board.create({ data: { name } })
    },
    async addTask(boardId, title) {
      await prisma.task.create({ data: { boardId, title } })
    },
    async cycleTask(id) {
      const t = await prisma.task.findUnique({ where: { id } })
      if (!t) return
      const next = STATUSES[(STATUSES.indexOf(t.status as Status) + 1) % STATUSES.length]
      await prisma.task.update({ where: { id }, data: { status: next } })
    },
    async deleteTask(id) {
      await prisma.task.delete({ where: { id } })
    },
    async close() {
      await prisma.$disconnect()
      await handle.close()
    },
  }
}
