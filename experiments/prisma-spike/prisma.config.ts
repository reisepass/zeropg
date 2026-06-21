// Prisma 7 config. The connection URLs live here now (not in schema.prisma).
// For Migrate, the datasource url/shadowDatabaseUrl point at our two local
// pglite-socket wire servers (set by run.ts). For the generated client, a pg
// driver adapter is passed to the PrismaClient constructor (see run.ts).

import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
    shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
  },
})
