import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const notes = pgTable('notes', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  done: boolean('done').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
