// drizzle-kit config. `drizzle-kit generate` reads the schema and emits SQL
// migrations into ./drizzle — OFFLINE, no database connection (this is exactly
// why Drizzle is the natural fit for zeropg: unlike Prisma there is no shadow
// database and no migration engine that needs a privileged wire connection).
// The generated SQL is committed and applied at boot by drizzle's migrate().
//
//   npx drizzle-kit generate --config examples/drizzle-board/drizzle.config.ts

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './examples/drizzle-board/schema.ts',
  out: './examples/drizzle-board/drizzle',
})
