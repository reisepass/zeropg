# @zeropg/client

One `connect(DATABASE_URL)` factory and one node-postgres-shaped interface over four engines. Only the connection string changes from laptop to bucket to an always-on server - your app code never does.

```ts
import { connect } from '@zeropg/client'

const db = await connect(process.env.DATABASE_URL) // or connect() -> memory://
const { rows } = await db.query('select $1::text as hello', ['world'])
await db.end()
```

## Engines (by connection string)

| URL | Engine |
| --- | --- |
| `memory://` | embedded PGlite, in-process, ephemeral |
| `file://./dev.db` | embedded PGlite on a NodeFS datadir, guarded by a cross-process lock |
| `http(s)://host` | bucket-backed scale-to-zero zeropg over HTTP |
| `postgres://…` | a real, always-on Postgres via node-postgres |

The result shape (`{ rows, rowCount, fields }`), `transaction(fn)`, and `end()` match `pg`, so graduating to a real Postgres is a URL change, not a rewrite.

## Install

```sh
npm install @zeropg/client @electric-sql/pglite
```

`@electric-sql/pglite` is a peer dependency (needed for `memory://` and `file://`). `pg` (for `postgres://`) and `@electric-sql/pglite-socket` (for `serveWire`) are optional peers, loaded only if you use those features.

## Why `file://` instead of raw PGlite: corruption-resistant local dev

PGlite is single-process and its NodeFS backend has no cross-process guard, so two processes opening the same datadir (a hot-reloading dev server's old + new instance, two `tsx watch` runs, nodemon overlap) tear the files. `connect('file://…')` prevents this:

- A **cross-process lock** on a namespaced sibling `<datadir>.zeropg.lock` (atomic `O_EXCL` create + owner PID, claim-mutex reclaim of dead holders, host-aware so it never steals a lock across machines). A second opener waits, then fails with `LockTimeoutError` rather than corrupting the datadir.
- A same-process **HMR instance pin** so a framework reload reuses the one live instance instead of opening a second on the same datadir.

```ts
const db = await connect('file://./pgdata')
// ...a second connect('file://./pgdata') in another process is locked out, not corrupting.
```

The lock lives in its **own** `<datadir>.zeropg.lock` file - deliberately *not* `<datadir>.lock`, which is the path PGlite's own datadir lock (e.g. the `pglite-kill-dash-9` fork) uses. So the wrapper lock is correct and conflict-free whether the underlying PGlite locks itself or not, and survives PGlite changing its lock format. On a PGlite build that already locks the datadir, set `nativeDatadirLock: true` (or env `ZEROPG_NATIVE_DATADIR_LOCK=1`) to skip the now-redundant wrapper lock.

## Local Postgres wire (for ORMs / psql / migration tools)

Tools that insist on a real `postgres://` connection (Prisma's migration engine, `drizzle-kit push`, `psql`, TablePlus) can talk to a localhost wire endpoint backed by one PGlite, held under the same lock:

```ts
import { serveWire } from '@zeropg/client'
const wire = await serveWire({ dataDir: './pgdata' }) // needs @electric-sql/pglite-socket
console.log(wire.url) // postgres://127.0.0.1:5432x/postgres
await wire.stop()
```

## API

- `connect(url?, opts?) => Promise<Client>` - resolve a connection string (defaults to `DATABASE_URL`, then `memory://`).
- `Client`: `query(sql, params?)`, `exec(sql)`, `transaction(fn)`, `ensureReady()`, `end()`, and `engine`.
- `serveWire(opts?) => Promise<WireServer>` - localhost Postgres-wire server backed by PGlite.
- `acquireDatadirLock(dataDir, opts?)` / `lockPathFor(dataDir)` - the cross-process lock primitive, used standalone.

## License

MIT
