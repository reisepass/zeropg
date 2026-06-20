# Task Board — the "default Postgres everywhere" showcase

A real, small web app (HTTP API + server-rendered UI) built on **`@zeropg/client`**.
Its whole point is what _doesn't_ change: the migrations, the SQL, the routes, the
HTML are written once against one node-postgres-shaped interface. The only thing
that moves it from a laptop to a bucket to a managed Postgres is **`DATABASE_URL`**.

```bash
# ephemeral, in-process (great for tests/demos)
DATABASE_URL=memory:// npx tsx examples/taskboard/index.ts

# local dev: durable on disk, guarded by the cross-process lock (E1) so a
# hot-reloading dev server can't tear the datadir
DATABASE_URL=file://./data/taskboard.db npx tsx examples/taskboard/index.ts   # (default)

# production: a bucket-backed, scale-to-zero zeropg instance over HTTP
DATABASE_URL=https://my-zeropg.example.run.app npx tsx examples/taskboard/index.ts

# graduated: a real always-on Postgres, zero app changes
DATABASE_URL=postgres://user:pw@host/db npx tsx examples/taskboard/index.ts
```

Open <http://localhost:8082>.

## What it shows

- **One codebase, four engines.** `db.ts` is the only file that names a connection
  string; everything else sees a `Client`.
- **Boot-time, single-applier migrations** (`migrations.ts`): the instance applies
  DDL to _itself_ under the lease — the pattern from
  [`ORM-ADAPTER-NOTES.md`](../../ORM-ADAPTER-NOTES.md), not an ORM pushing DDL over
  the wire.
- **Real routes** (each view its own URL): `/` board, `/task/:id` detail, plus a
  JSON API under `/api/tasks`. The HTML uses plain `<form>` POSTs + redirects, so it
  works with JS disabled.

## Tests

```bash
# 1. Engine parity: the identical HTTP scenario on memory:// and file:// produces
#    byte-identical transcripts; file:// data survives a close + reopen.
npx tsx examples/taskboard/test/api-parity.test.ts

# 2. End-to-end UI in headless chromium: add -> toggle -> detail route -> save
#    notes -> reload-persisted -> delete. (needs: npx playwright install chromium)
npx tsx examples/taskboard/test/e2e.test.ts

# 3. Concurrent-process safety: boots the app as separate OS processes on ONE
#    file:// datadir. A 2nd process is locked out (not corrupting) while the 1st
#    serves; after a SIGKILL, a successor reclaims the dead lock and recovers
#    every durable write. This is the hot-reload-overlap hazard the E1 lock exists
#    for, exercised through the real app.
npx tsx examples/taskboard/test/concurrent-process.test.ts
```

Both are assertion scripts that exit non-zero on failure (the repo's `experiments/`
convention).
