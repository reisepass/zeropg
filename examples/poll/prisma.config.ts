// Prisma 7 config for the CLI (generate / migrate diff). The app itself never
// uses the native migrate engine — it applies the committed migration SQL at
// boot (see boot.ts) — so this only needs a URL present for config to load.
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
})
