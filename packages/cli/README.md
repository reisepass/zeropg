# @zeropg/cli

The `zeropg` CLI: a Prisma-migration workflow for zeropg / PGlite that needs
**no external Postgres** and does **not** use Prisma's native `migrate dev`
engine (which can't drive single-session PGlite — see the rationale below).

## Commands

```
zeropg migrate dev --name <name> [--schema <path>] [--migrations <dir>] [--data <dir>]
    Author the next migration from your edited schema and apply it to the dev
    database. No external Postgres needed.

zeropg migrate deploy [--migrations <dir>] [--data <dir>]
    Apply all pending committed migrations to the dev database.

zeropg migrate status [--migrations <dir>]
    List the migrations on disk.
```

Defaults: `--schema prisma/schema.prisma`, `--migrations prisma/migrations`,
`--data .zeropg/dev`.

Run commands from your project directory (the one holding `prisma.config.ts`).
In this repo the bin is run via tsx:

```sh
npx tsx packages/cli/src/zeropg.ts migrate status
```

### What each command does

- **`migrate dev`** — *generate + apply*, the two halves of the native
  `prisma migrate dev` run separately so they each work on PGlite alone:
  1. **Generate.** Spin a throwaway in-process PGlite shadow, replay the existing
     migration history into it, and `prisma migrate diff --from-migrations <dir>
     --to-schema <schema> --script --exit-code` to emit the new SQL. If the
     schema is already in sync, nothing is authored.
  2. **Write.** Save the SQL as `prisma/migrations/<timestamp>_<name>/migration.sql`.
  3. **Apply.** `prisma migrate deploy` the new (and any pending) migration to the
     dev database datadir.
- **`migrate deploy`** — `prisma migrate deploy` applies every pending committed
  migration to the dev database. No shadow database is used.
- **`migrate status`** — lists the migration folders on disk.

## Programmatic API

The same workflow is exported for use from a boot script, Dockerfile entrypoint,
or tests:

```ts
import { migrateDeploy, migrateDev, listMigrations } from '@zeropg/cli'

await migrateDeploy({ cwd: projectDir, data: dataDir })
```

`examples/poll/boot.ts` uses `migrateDeploy()` to apply its committed migrations
to the instance's own PGlite at boot (single-applier — the instance applies its
own schema under the lease).

## Why not `prisma migrate dev`?

Prisma's native `migrate dev` needs **multiple independent Postgres sessions**
(an advisory-lock connection, a work connection, and a shadow-database reset run
concurrently). PGlite is a **single backend session**, so the native engine
fails against it with `P1017` — even in Prisma's own PGlite-backed `prisma dev`,
and even with `connection_limit=1` plus a separate shadow datadir. Fronting
PGlite with `pglite-socket` or `pg-gateway` does not fix it; the limitation is
structural, not a wire-framing bug.

But `migrate dev` is really just *generate-the-next-migration* + *apply-it*, and
each half works on PGlite on its own (generate is offline diff against a
throwaway sequential shadow; apply is `migrate deploy`, which uses a single
session and no shadow). So `zeropg migrate dev` orchestrates those two halves
itself and gives you the same DX (edit schema → timestamped migration → applied)
entirely on PGlite, with no external Postgres.

Full empirical write-up, including everything tested and ruled out, is in
[ORM-ADAPTER-NOTES.md](../../ORM-ADAPTER-NOTES.md).

## Requirement: `prisma.config.ts` must read URLs from `process.env`

The CLI injects throwaway wire URLs (for the shadow and the dev database) via the
`DATABASE_URL` / `SHADOW_DATABASE_URL` environment variables. Your project's
Prisma 7 `prisma.config.ts` must therefore read its datasource URLs from
`process.env` directly — **not** from Prisma's `env()` helper, which throws when
the variable is unset (the shadow URL is intentionally omitted for commands like
`migrate deploy` that don't use a shadow):

```ts
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
})
```

See `test/fixture/prisma.config.ts` for the minimal working layout.
