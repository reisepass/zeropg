// Drizzle schema (drizzle-orm/pg-core) for the reading-list board. A bookmark
// has a title/url/note and a "status" (unread/reading/done); bookmarks and tags
// are many-to-many through bookmark_tags. Nothing zeropg-specific here — this is
// an ordinary Drizzle schema, which is the whole point: an existing Drizzle
// codebase runs unchanged. `drizzle-kit generate` turns this into the SQL under
// ./drizzle, and drizzle's migrate() applies that SQL over the zeropg wire.

import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const STATUSES = ['unread', 'reading', 'done'] as const
export type Status = (typeof STATUSES)[number]

export const bookmarks = pgTable(
  'bookmarks',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    note: text('note').notNull().default(''),
    status: text('status').notNull().default('unread'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bookmarks_status_idx').on(t.status)],
)

export const tags = pgTable(
  'tags',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('tags_name_uq').on(t.name)],
)

export const bookmarkTags = pgTable(
  'bookmark_tags',
  {
    bookmarkId: integer('bookmark_id')
      .notNull()
      .references(() => bookmarks.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.bookmarkId, t.tagId] })],
)

export const bookmarksRelations = relations(bookmarks, ({ many }) => ({
  bookmarkTags: many(bookmarkTags),
}))
export const tagsRelations = relations(tags, ({ many }) => ({
  bookmarkTags: many(bookmarkTags),
}))
export const bookmarkTagsRelations = relations(bookmarkTags, ({ one }) => ({
  bookmark: one(bookmarks, { fields: [bookmarkTags.bookmarkId], references: [bookmarks.id] }),
  tag: one(tags, { fields: [bookmarkTags.tagId], references: [tags.id] }),
}))
