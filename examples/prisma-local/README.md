# Prisma + local zeropg Postgres

Real Prisma ORM over a **local, in-process Postgres** - no install, no Docker, no daemon. Start the app and it writes to `./pgdata`. Going remote is a one-line env change.

```ts
// db.ts — the only zeropg-aware file
const handle = await resolveDatabaseUrl(process.env.DATABASE_URL ?? 'file:./pgdata')
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: handle.url }),
})
```

Everything else (`app.ts`, queries) is **ordinary Prisma**. `resolveDatabaseUrl()` returns a real `postgres://` URL - a local elected Postgres for `file:./pgdata`, or your remote unchanged for `postgres://…`.

## Run

```sh
pnpm dev      # = generate (prisma client) then start (run the app)
```

`start` → `tsx app.ts`: `prisma.note.createMany / findMany / count` over the local Postgres via `@prisma/adapter-pg`.

## Migrations: the one Prisma caveat

Prisma's **runtime** queries work great over the wire (via the `@prisma/adapter-pg` driver adapter). But Prisma's **native migrate / `db push` engine** is a separate binary that can't drive single-session PGlite - it fails with `P1001 Can't reach database server`. So:

- This example applies its schema with `$executeRawUnsafe` (a normal adapter query) to stay self-contained.
- In a real project, author and apply migrations with the zeropg CLI, which uses a throwaway PGlite shadow and needs no external Postgres:

  ```sh
  zeropg migrate dev --name init     # author from prisma/schema.prisma
  zeropg migrate deploy              # apply committed migrations
  ```

## How it works

The first process to open `./pgdata` becomes the **leader** (opens PGlite + an in-process Postgres wire on a free port, recorded in `./pgdata.zeropg.lock`); others attach as clients. One writer, many clients, crash-safe reclaim. See `../drizzle-local/README.md` for the election details.
