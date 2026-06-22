// Prisma 7 config. URL comes from process.env directly (not prisma's env(),
// which throws when unset) so `zeropg run` can inject the local elected wire URL.
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL ?? '' },
})
