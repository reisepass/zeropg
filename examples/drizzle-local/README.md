# Drizzle + local zeropg Postgres

Real Drizzle ORM over a **local, in-process Postgres** that needs no install, no Docker, and no daemon - you just start the app and it writes to `./pgdata`, SQLite-style. Going to a remote Postgres is a one-line env change.

```ts
// db.ts — the only zeropg-aware file
const handle = await resolveDatabaseUrl(process.env.DATABASE_URL ?? 'file:./pgdata')
export const db = drizzle(new Pool({ connectionString: handle.url }), { schema })
```

Everything else (`app.ts`, queries) is **ordinary Drizzle**. `resolveDatabaseUrl()`:

- `file:./pgdata` → elects (or attaches to) a local single-writer Postgres over the datadir and returns its `postgres://127.0.0.1:<port>` URL.
- `postgres://host/db` → returned unchanged. **Only `DATABASE_URL` changes to go remote.**

## Run

```sh
pnpm dev      # = db:push (apply schema) then start (run the app)
```

- `db:push` → `zeropg run drizzle-kit push` — `zeropg run` resolves `DATABASE_URL`, elects the local Postgres, and runs `drizzle-kit` against it over the wire.
- `start` → `tsx app.ts` — pure Drizzle: insert, select, filter, count.

## How it works

The first process to open `./pgdata` becomes the **leader**: it opens PGlite, serves a Postgres wire on a free port (via pglite-socket, in-process), and records `{pid, host, port}` in `./pgdata.zeropg.lock`. Other processes (e.g. `drizzle-kit`, a second app) read that port and connect as clients - one writer, many clients. A crashed leader is reclaimed by the next caller (liveness-probed), so the datadir never corrupts from concurrent opens or a `kill -9`.

Concurrent transactions from different processes are **serialized** (the second waits for the first), not interleaved - safe, just not parallel. Genuinely concurrent transactional load is the signal to graduate to the remote rung.
