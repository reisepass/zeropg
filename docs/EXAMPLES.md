# zeropg examples

A guided index of the runnable example apps under [`examples/`](../examples/).
Each is a small but real program, not a snippet — run them with `npx tsx`.

The examples climb a ladder of abstraction:

- **Raw `ZeroPG` / `ZeroPGReplica`** (`@zeropg/objectstore-fs`): the bucket-backed
  engine directly — explicit `store`, lease, durability mode.
- **The unified `Client`** (`@zeropg/client`): one node-postgres-shaped interface
  whose target is chosen by a `DATABASE_URL` (`memory://`, `file://`, an HTTP
  zeropg endpoint, or a real `postgres://`).
- **ORM on top** (Prisma, Drizzle): an existing ORM codebase running unchanged on
  zeropg via the single-applier migration pattern.

| Example | One-liner | Demonstrates |
| --- | --- | --- |
| [guestbook](#guestbook) | Smallest real bucket-backed app | Raw `ZeroPG`, single-writer lease, `sleep` durability |
| [replica-reader](#replica-reader) | Leaseless follower | `ZeroPGReplica` read replicas |
| [taskboard](#taskboard) | One codebase, four engines | Unified `connect()` ladder via `DATABASE_URL` |
| [poll](#poll) | Prisma Doodle/Rallly clone | Prisma-on-zeropg |
| [drizzle-board](#drizzle-board) | Drizzle ORM showcase _(new, in progress)_ | Drizzle-on-zeropg |
| [shortlink](#shortlink) | URL shortener _(new, in progress)_ | Unified client, compact CRUD |

---

## guestbook

The smallest real zeropg app: an HTTP guestbook whose Postgres lives in a GCS
bucket. Runs anywhere Node runs — laptop, VM, or Cloud Run at min-instances=0;
kill it whenever you like, the database is the bucket.

```bash
ZEROPG_BUCKET=my-bucket ZEROPG_PREFIX=apps/guestbook npx tsx examples/guestbook/index.ts
```

Demonstrates: bucket-backed durability with the raw `ZeroPG` engine, the
single-writer lease (boots wait out a previous instance's lease via
`acquireTimeoutMs`), and `durability: 'sleep'` (writes return at memory speed;
the WAL ships on shutdown/idle). Switch to `'strict'` for commit-before-ack.

## replica-reader

A read replica in ~20 lines: a leaseless follower that serves queries from the
bucket's latest commit. Point it at any zeropg prefix — it never writes, never
takes the lease, and converges within the poll interval. Pairs naturally with
the guestbook (point both at the same prefix).

```bash
ZEROPG_PREFIX=apps/guestbook npx tsx examples/replica-reader/index.ts
```

Demonstrates: `ZeroPGReplica` read replicas (bucket-backed fan-out reads with no
contention on the writer's lease).

## taskboard

The "default Postgres everywhere" showcase. A real web app (HTTP API +
server-rendered UI) built on **`@zeropg/client`**: the migrations, SQL, routes,
and HTML are written once against one node-postgres-shaped interface, and only
`DATABASE_URL` moves it from a laptop to a bucket to a managed Postgres.

```bash
DATABASE_URL=memory://                              npx tsx examples/taskboard/index.ts
DATABASE_URL=file://./data/taskboard.db             npx tsx examples/taskboard/index.ts  # default
DATABASE_URL=https://my-zeropg.example.run.app      npx tsx examples/taskboard/index.ts
DATABASE_URL=postgres://user:pw@host/db             npx tsx examples/taskboard/index.ts
```

Demonstrates: the unified `connect()` ladder — one codebase over four engines
(in-memory, on-disk under the cross-process lock, HTTP zeropg, real Postgres) —
plus boot-time single-applier migrations and per-view URLs.
See [`examples/taskboard/README.md`](../examples/taskboard/README.md).

## poll

A tiny Rallly/Doodle clone: an existing **Prisma** codebase running on zeropg.
Create a meeting poll with time-slot options, share the link, people mark each
slot, and the grid plus "best option" update live. All data access is Prisma;
the database is PGlite living wherever the wire server points.

```bash
npx prisma generate --schema examples/poll/prisma/schema.prisma   # one-time
npx tsx examples/poll/index.ts                                    # http://localhost:8083
```

Demonstrates: Prisma-on-zeropg via the single-applier pattern — Prisma authors
the schema and migration SQL offline (`migrate diff`), zeropg's single writer
applies it at boot, and Prisma then queries over the wire through
`@prisma/adapter-pg` → `@electric-sql/pglite-socket` → PGlite.
See [`examples/poll/README.md`](../examples/poll/README.md).

## drizzle-board

_New — under active development; may be incomplete._

A Drizzle ORM showcase: the Drizzle equivalent of the Prisma `poll` app,
demonstrating **Drizzle-on-zeropg** with the same single-applier migration
discipline.

```bash
npx tsx examples/drizzle-board/index.ts
```

## shortlink

_New — under active development; may be incomplete._

A URL shortener built on the unified **`@zeropg/client`**: a compact CRUD app
(create a short code, redirect, count hits) demonstrating the unified client on
a minimal real workload.

```bash
npx tsx examples/shortlink/index.ts
```
