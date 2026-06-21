// Minimal Prisma 7 config for the CLI fixture. URLs come from process.env (not
// prisma's env(), which throws when unset) so the shadow URL can be omitted for
// commands that don't use one (migrate deploy). This is the layout zeropg's CLI
// expects in a user's project.
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
})
