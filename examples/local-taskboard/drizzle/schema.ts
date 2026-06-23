import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'

export const boards = pgTable('boards', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  boardId: integer('board_id').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('todo'),
})
