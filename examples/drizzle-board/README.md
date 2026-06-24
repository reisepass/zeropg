# drizzle-board — a real Drizzle ORM app on zeropg

A tiny reading-list / bookmarks board (bookmarks, tags, a many-to-many join, a
status workflow) built with **Drizzle ORM**, running on **zeropg** (Postgres in a
bucket / on a file, via PGlite behind a real `postgres://` wire). Server-rendered
HTML, plain `<form>` POST + redirect — no client JS, so it is fully driveable
headless.

The point of this example: an **existing, unmodified Drizzle codebase runs on
zeropg end to end** — schema, generated SQL migrations, the stock migrator, and
the query path — with **no zeropg-specific code in the ORM layer**.

## Why Drizzle is the natural fit (contrast with Prisma)

See [ORM-ADAPTER-NOTES.md](../../ORM-ADAPTER-NOTES.md) for the full story. The
short version:

| | Drizzle | Prisma |
|---|---|---|
| Generate migrations | `drizzle-kit generate` — **offline, no DB connection** | `prisma migrate dev` — needs a **shadow database** + a direct privileged wire connection + advisory lock + multiple concurrent sessions |
| Apply migrations | `migrate(db, …)` runs the committed SQL **sequentially through any `pg` driver**, tracked in `drizzle.__drizzle_migrations`. No shadow DB, no advisory lock, no `CREATE DATABASE` | `prisma migrate deploy` works over the wire, but `migrate dev` **cannot** run against a single PGlite (it needs multiple independent Postgres sessions; PGlite is one backend session → P1017) |
| Query path | a plain `pg` Pool on the wire url → `drizzle-orm/node-postgres` | requires a driver adapter (`@prisma/adapter-pg`) |

Because Drizzle's migrator is just "run these SQL files in order, in one
session," it lands cleanly on zeropg's **single-writer** model — the lease *is*
the advisory lock Prisma reaches for, and there is only ever one connection
(in-process PGlite). Nothing in Drizzle's normal workflow trips the
shadow-DB / multi-session requirements that break Prisma's `migrate dev`.

## Confirmed empirically (2026-06-21)

Both run cleanly over the zeropg wire, unchanged:

- **`drizzle-kit generate`** — offline, emitted `drizzle/0000_*.sql` +
  `meta/` from `schema.ts` with no database connection.
- **Drizzle's `migrate()`** (`drizzle-orm/node-postgres/migrator`) — applied that
  SQL over the `serveWire()` `postgres://` endpoint via a plain `pg` Pool,
  created `bookmarks` / `tags` / `bookmark_tags`, recorded the migration in
  `drizzle.__drizzle_migrations`, and is **idempotent across reboot**.
- A plain `pg` Pool connects to the wire **with no `?sslmode=disable` and no user
  override** (those hacks were only needed for Prisma's Rust engine; the `pg`
  client speaks the wire directly). The pool is capped at `max: 1` because PGlite
  serializes onto one backend session — the single-writer model made literal.

## How it works

```
schema.ts ──drizzle-kit generate──▶ drizzle/*.sql (committed)
                                        │
serveWire({dataDir})  ──postgres://──▶  pg Pool ──▶ drizzle-orm/node-postgres
                                        │
                              migrate(db,{migrationsFolder})  ◀── applies the SQL at boot
```

- `schema.ts` — Drizzle schema (`drizzle-orm/pg-core`): `bookmarks`, `tags`,
  `bookmark_tags` (composite-PK join, FK `on delete cascade`), plus `relations()`.
- `drizzle.config.ts` — points `drizzle-kit` at the schema, outputs to `./drizzle`.
- `drizzle/` — the **committed, generated** SQL migration + journal/snapshot.
- `boot.ts` — `serveWire()` → `pg` Pool → `drizzle()` → `migrate()`.
- `app.ts` — `node:http` server, server-rendered HTML, each view its own GET
  route, `data-testid` attributes for headless driving.
- `index.ts` — boot + listen.

### Graduation

Swap the `dataDir` for a bucket-backed zeropg and this is a scale-to-zero
Postgres app; graduate to managed Postgres by pointing the `pg` Pool at a real
`postgres://` host — **no app or migration change**, since it has been real
Postgres + real Drizzle all along.

## Run it

```sh
# regenerate migrations from schema.ts (offline; only after editing the schema)
npx drizzle-kit generate --config examples/drizzle-board/drizzle.config.ts

# start the app (migrations apply automatically at boot)
PORT=8085 npx tsx examples/drizzle-board/index.ts
# → http://localhost:8085
```

## Routes

| Method | Path | View / action |
|---|---|---|
| GET | `/` (`?status=unread\|reading\|done`) | list + add form, optional status filter |
| POST | `/bookmarks` | create a bookmark → redirect to its page |
| GET | `/bookmark/:id` | detail: status controls, tags, delete |
| POST | `/bookmark/:id/status` | set status |
| POST | `/bookmark/:id/tags` | add a tag (upsert + link, idempotent) |
| POST | `/bookmark/:id/untag` | remove a tag link |
| POST | `/bookmark/:id/delete` | delete (cascades the tag links) |
| GET | `/api/bookmarks` | JSON list |
| GET | `/api/bookmark/:id` | JSON detail |

## Tests

```sh
# HTTP-layer CRUD + migrator assertions + durability across reboot
npx tsx examples/drizzle-board/test/api.test.ts      # PASS — 26 assertions

# Playwright headless chromium driving the real UI
npx tsx examples/drizzle-board/test/e2e.test.ts      # PASS — 22 assertions
```

Each test boots the app on a fresh `os.tmpdir()` datadir and tears it down. The
api test also asserts the stock Drizzle migrator ran over the wire
(`drizzle.__drizzle_migrations` populated, schema tables created) and that
`migrate()` is idempotent across a reboot; the e2e test drives create → status
change → add/remove tags → filter → reload-persists → delete → 404 in a real
browser.
