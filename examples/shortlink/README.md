# Shortlink — the "default Postgres everywhere" showcase

A real, small URL shortener (HTTP API + server-rendered UI) built on
**`@zeropg/client`**. Its whole point is what _doesn't_ change: the migrations, the
SQL, the routes, the HTML are written once against one node-postgres-shaped
interface. The only thing that moves it from a laptop to a bucket to a managed
Postgres is **`DATABASE_URL`**.

```bash
# ephemeral, in-process (great for tests/demos)
DATABASE_URL=memory:// npx tsx examples/shortlink/index.ts

# local dev: durable on disk, guarded by the cross-process lock (E1) so a
# hot-reloading dev server can't tear the datadir
DATABASE_URL=file://./data/shortlink.db npx tsx examples/shortlink/index.ts   # (default)

# production: a bucket-backed, scale-to-zero zeropg instance over HTTP
DATABASE_URL=https://my-zeropg.example.run.app npx tsx examples/shortlink/index.ts

# graduated: a real always-on Postgres, zero app changes
DATABASE_URL=postgres://user:pw@host/db npx tsx examples/shortlink/index.ts
```

Open <http://localhost:8083>.

## What it does

- **Shorten** a long URL on `/` → get a 6-char code (stored with its target,
  click count, and timestamps).
- **`GET /<code>`** → an HTTP **302** redirect to the target URL, incrementing the
  click counter in the same transaction (so a redirect is never served without the
  click being durably recorded, and vice versa).
- **`GET /links`** → the stats list: every code, its target, and its live click
  count.
- **`GET /link/<code>`** → one link's detail page (short URL, target, clicks).
- **`GET /healthz`** → `{ ok, engine }`.
- **JSON API** for automation/tests: `GET /api/links`, `POST /api/links`
  (`{ url, code? }`), `GET /api/links/<code>`.

## What it shows

- **One codebase, four engines.** `db.ts` is the only file that names a connection
  string; everything else sees a `Client`.
- **Boot-time, single-applier migrations** (`migrations.ts`): the instance applies
  DDL to _itself_ under the lease — the pattern from
  [`ORM-ADAPTER-NOTES.md`](../../ORM-ADAPTER-NOTES.md), not an ORM pushing DDL over
  the wire.
- **A transactional side effect.** The redirect resolves the code and bumps
  `clicks` in one `db.transaction(...)`, so the counter can't drift from the
  redirects actually served — and it behaves identically on every engine.
- **Real routes** (each view its own GET URL): `/` shorten form, `/links` stats,
  `/link/:code` detail, and `GET /:code` the redirect itself. The HTML uses plain
  `<form>` POSTs + redirects, so it works with JS disabled.

## Tests

```bash
# 1. Engine parity: the identical HTTP scenario on memory:// and file:// produces
#    byte-identical transcripts (deterministic codes via the API, blanked
#    timestamps); file:// links + click counts survive a close + reopen, and the
#    counter resumes climbing from the durable value.
npx tsx examples/shortlink/test/api-parity.test.ts

# 2. End-to-end UI in headless chromium: shorten a URL via the form -> capture the
#    generated code -> visit /<code> and assert the browser is redirected (and that
#    GET /<code> is a true 302) -> assert the stats pages show the incremented click
#    count -> reload-persisted. (needs: npx playwright install chromium)
npx tsx examples/shortlink/test/e2e.test.ts
```

Both are assertion scripts that exit non-zero on failure (the repo's `experiments/`
convention).
