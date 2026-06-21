// Prisma 7 config for the CLI (generate / migrate diff / migrate deploy).
//
// URLs come from process.env directly (not prisma's env(), which throws when
// unset) so @zeropg/cli can inject a throwaway wire URL at deploy time and omit
// the shadow URL for commands that don't use one. boot.ts applies the committed
// migrations via @zeropg/cli's migrateDeploy() — the native migrate engine is
// never used (it can't drive single-session PGlite).
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
})
