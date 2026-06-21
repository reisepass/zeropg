// Prisma 7 config. The connection URLs live here now (not in schema.prisma).
// For Migrate, the datasource url/shadowDatabaseUrl point at our two local
// pglite-socket wire servers (set by run.ts). For the generated client, a pg
// driver adapter is passed to the PrismaClient constructor (see run.ts).

import { defineConfig } from 'prisma/config'

// Read straight from process.env (not prisma's env(), which throws when unset) so
// the shadow URL can be OMITTED for commands that don't use one (migrate deploy
// validates shadow != main even though it never touches the shadow).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
})
