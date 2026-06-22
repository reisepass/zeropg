import { defineConfig } from 'drizzle-kit'

// drizzle-kit (push / generate / studio) reads DATABASE_URL from the env. Run it
// under `zeropg run` so the URL points at the local elected Postgres:
//   zeropg run drizzle-kit push
export default defineConfig({
  dialect: 'postgresql',
  schema: './schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
