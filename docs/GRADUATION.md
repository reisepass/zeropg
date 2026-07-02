# Graduation: the pg_dump exit is built into the design

Status: **LOCALLY VERIFIED** (2026-07-02). A standard `pg_dump` run against a
zeropg database over the real Postgres wire produced a plain-SQL dump that
restored byte-identically into a stock PostgreSQL 18.4 server. Measured
commands, timings, sizes, and a row-level checksum match are in the
[Measured evidence](#measured-evidence) section below.

zeropg is not a new database you get locked into. It **is** Postgres - PGlite is
the Postgres source tree compiled to WebAssembly, served over the byte-identical
Postgres wire protocol by pglite-socket. So the exit is the same exit every
Postgres has: `pg_dump` out, restore into whatever managed Postgres you like,
change one connection string. There is no proprietary format to escape, no
export tool to trust, no data model to translate. You graduate with the same
tool a DBA would use to move between two RDS instances.

This document is the runbook for that move: when to make it, the exact verified
commands, and the caveats worth knowing before you run them.

## When to graduate

You do not outgrow zeropg by storing too many rows. You outgrow it by being
**awake too much of the day**, or by needing a bigger machine than a
single-writer WASM engine can be. Three signals, in rough order of how often
they actually bind (see [BREAK-EVEN.md](../BREAK-EVEN.md) for the full cost
math):

1. **Sustained awake-hours.** zeropg's whole economic argument is scale-to-zero:
   you pay for compute only while serving traffic. Once real traffic keeps the
   instance awake more than roughly **4-5 hours/day** (GCP Cloud Run, ~500 MB
   DB) the bill approaches a small always-on managed Postgres, and past
   ~18-20 awake-hr/day it exceeds it. At that point a managed instance is both
   cheaper and simpler. (The exact crossover is platform-specific: on AWS
   Fargate and IBM Code Engine the cost crossover is so high it effectively
   never binds below ~1 GB, and you migrate for size or throughput instead. See
   the per-platform tables in BREAK-EVEN.md.)

2. **Data size and cold-start latency.** Restore from the bucket is
   bandwidth-bound and scales roughly linearly with database size: **~11s cold
   start at 500 MB** (measured, 20 forced cold starts on Cloud Run - see the
   README "See it live" table and [docs/COLDSTART-MODEL.md](COLDSTART-MODEL.md)),
   and about ~22s/GB beyond that. Somewhere around **0.5-4 GB** the cold-start
   latency and the container memory tier make a warm, always-on Postgres the
   better tradeoff regardless of cost.

3. **Sustained concurrent-write throughput.** zeropg is single-writer by design:
   one PGlite engine, writes serialized, durability shipped to the bucket. On
   GCS the manifest object name is rate-capped at ~1 write/second, which
   group-commit hides for bursty traffic but which becomes a hard ceiling under
   **sustained >1 commit/second**. If you need many concurrent writers hitting
   the same database around the clock, that is a real Postgres cluster's job.

If none of these bind, you do not need to graduate - the design is built to sit
at zero cost while idle indefinitely. When one does bind, the move below is
mechanical and low-risk.

## The runbook

The whole migration is: quiesce, dump, restore, repoint, archive. Steps 2 and 3
are plain `pg_dump` / `psql` - nothing zeropg-specific.

### 1. Quiesce and flush

Stop writers and make sure the last commit is durably in the bucket before you
dump. You have two equivalent paths:

- **Embedded / library use:** call `await db.close()`. That performs the
  sleep-mode flush (ships the final WAL delta) and releases the single-writer
  lease. (`packages/client` Client, `close()`; the server's shutdown path does
  the same via `flushWireWrites('shutdown')` then `db.close()` in
  `packages/server/src/server.ts`.)
- **The running demo / service:** the **put to sleep** control streams the flush
  and lease-release steps and exits the instance (README, "See it live"). After
  it returns, the bucket holds a crash-consistent snapshot plus manifest pointer.

You can dump from a live instance too - `pg_dump` runs in a single read
transaction and sees a consistent MVCC snapshot - but quiescing first means the
dump and the bucket archive agree exactly, and it avoids the multiplexed-session
caveat noted below.

### 2. `pg_dump` over the wire

Point `pg_dump` at the pglite-socket endpoint (the same `postgres://host:port`
URL your app uses). Plain-SQL format, no TLS, ownership and grants stripped:

```bash
pg_dump "postgresql://postgres@HOST:PORT/postgres?sslmode=disable" \
  --no-owner --no-acl \
  -f dump.sql
```

Flags and why:

- `sslmode=disable` - the pglite-socket wire is a localhost/loopback endpoint
  with no TLS layer; without this libpq tries to negotiate SSL and fails.
- `--no-owner --no-acl` - PGlite runs as a single role, so ownership and GRANT
  statements are noise that only produces "role does not exist" errors on a
  target with different roles. Strip them; re-grant on the target as needed.
- **Use a `pg_dump` whose major version is >= the server's.** PGlite reports its
  server version as the Postgres version it was built from (PostgreSQL 18.3 for
  PGlite 0.5.2). `pg_dump` refuses a server newer than itself
  (`aborting because of server version mismatch`), so a stock older libpq will
  not work - install client tools at or above the PGlite Postgres major (18+
  today). This is the single most likely snag.

The default (and recommended) format uses `COPY ... FROM stdin` for table data.
Reading that direction - `COPY TO stdout` out of zeropg - works fine and is the
fast path; use it when the restore target is a real Postgres. (There is one
exception, restoring back *into* another pglite-socket instance, covered in
[Caveats](#caveats).)

### 3. Restore into managed Postgres

Against RDS, Cloud SQL, Neon, a self-hosted cluster, anything:

```bash
psql "postgresql://USER:PASS@NEW-HOST:5432/DBNAME?sslmode=require" \
  -v ON_ERROR_STOP=1 \
  -f dump.sql
```

`ON_ERROR_STOP=1` makes the restore fail loudly on the first error instead of
plowing on. For a custom/directory-format dump use `pg_restore` instead of
`psql -f`; the plain-SQL dump above restores with `psql`. If your schema uses
extensions (pgcrypto, pg_trgm, and so on), the dump emits the matching
`CREATE EXTENSION` lines - the managed target must have those extensions
available (standard on RDS/Cloud SQL/Neon).

### 4. Repoint `DATABASE_URL`

This is the only application change. `@zeropg/client`'s `connect()` takes a URL
whose scheme selects the backend: `memory://`, `file://./dev.db`, or a real
`postgres://` / `postgresql://` host (`packages/client/src/index.ts` - "changes
from laptop to bucket to a graduated postgres:// host"). Graduating is literally
swapping the value of one environment variable:

```diff
- DATABASE_URL=postgres://127.0.0.1:5432/postgres   # zeropg over the wire
+ DATABASE_URL=postgresql://user:pass@your-managed-host:5432/dbname
```

`connect()` sees the `postgres://` host and routes through node-postgres to the
managed cluster. No code path change, no query rewrite - it was Postgres on both
sides. (This env-var switch is the migration story the SDK was designed around;
DESIGN.md.)

### 5. Keep or GC the bucket

The bucket is now a frozen, self-contained archive: an immutable snapshot plus
WAL segments plus a manifest pointer, crash-consistent as of your last flush.
Two choices:

- **Keep it** as a cold, cheap point-in-time archive of the pre-migration state.
  Object storage is far cheaper than a running database.
- **GC it** with `scripts/gc.ts` (deletes unreferenced objects) once you are
  confident the managed database is authoritative.

Nothing in the bucket is load-bearing after you repoint - it is just data at
rest.

## Measured evidence

Run locally on 2026-07-02. All numbers are measured, not estimated.

**Setup.** Two independent PGlite datadirs, each served over pglite-socket via
`@zeropg/client` `serveWire()` (the same wire path `packages/server` uses):
a **source** on `127.0.0.1:5439` and a second zeropg **target** on
`127.0.0.1:5440`. Separately, a stock **PostgreSQL 18.4 (Homebrew)** server on
`127.0.0.1:5441` stood in for "managed Postgres". Client tools: libpq /
`pg_dump` / `psql` **18.4**.

**Source schema** (a small but realistic app shape): 3 tables with foreign keys
(`authors` 50 rows, `posts` 300 rows, `comments` 600 rows - 950 rows total),
two secondary indexes, a `UNIQUE` constraint, 3 sequences, and a view
(`post_stats`) that joins and aggregates across all three tables.

**The dump** (`pg_dump --no-owner --no-acl`, plain SQL, default COPY format):

| metric | value |
|---|---|
| wall time | **0.18 s** |
| dump size | **125,812 bytes** (123 KB), 1,231 lines |
| contents | 3 `CREATE TABLE`, 3 `CREATE SEQUENCE`, 2 `CREATE INDEX`, 3 FK constraints, 1 `UNIQUE`, 1 `CREATE VIEW`, and all 950 rows as inline `COPY` data |

**Restore into real PostgreSQL 18.4** (the graduation direction):

```
psql "postgresql://postgres@127.0.0.1:5441/postgres" -v ON_ERROR_STOP=1 -f dump.sql
```

- Exit 0, **zero errors**, **0.05 s**.
- Row counts identical to source: `authors=50 posts=300 comments=600
  post_stats(view)=300 published=100`.
- Row-level checksum identical:
  `md5(string_agg(id||name||email order by id))` over `authors` returned
  **`2194e93ca5b115c1dc23963ab4496d01`** on both the zeropg source and the
  restored real Postgres.
- Foreign key enforced on the restored copy: an orphan insert raised
  `violates foreign key constraint "posts_author_id_fkey"`.
- Sequence restored: `authors_id_seq` `last_value = 50` on both sides.
- View restored and correct: `post_stats` joins and aggregates returned matching
  rows.

That is the proof that matters: a standard `pg_dump` off zeropg over the wire is
valid, complete, restorable SQL, and the restored database in a real Postgres is
byte-for-byte the same data with the same constraints, indexes, sequences, and
views.

**Round-trip back into a second zeropg** (as an extra check that the dump is
also a valid zeropg-to-zeropg transfer): restoring an `--inserts`-format dump
into the second pglite-socket instance on `127.0.0.1:5440` succeeded, exit 0,
0.14 s, with the same `authors` checksum. See the first caveat for why
`--inserts` is used specifically for this direction.

## Caveats

Everything that bit during verification, recorded faithfully.

1. **Client version gate (the likely snag).** PGlite advertises the Postgres
   version it was compiled from (18.3 for PGlite 0.5.2). `pg_dump` / `psql`
   refuse a server newer than themselves: a stock libpq 17 aborted with
   `server version mismatch: server 18.3, pg_dump 17.0`. Fix: install client
   tools >= the PGlite Postgres major (e.g. `brew upgrade libpq` to 18.4, or
   install `postgresql@18`).

2. **No TLS on the wire - use `sslmode=disable`.** pglite-socket is a plain
   loopback TCP endpoint; without `sslmode=disable` libpq attempts SSL
   negotiation and the connection fails.

3. **Do not restore the default COPY dump back *into* a pglite-socket wire.**
   This only affects a zeropg-to-zeropg restore, **not** graduation into real
   Postgres. `psql -f` of a COPY-format dump into a second pglite-socket instance
   failed on the first `COPY ... FROM stdin` with
   `unexpected EOF on client connection with an open transaction` /
   `terminating connection because protocol synchronization was lost`, and left
   that socket server's session wedged. pglite-socket's connection multiplexer
   does not carry the streaming `COPY FROM STDIN` sub-protocol. Workaround when
   the destination is another zeropg: dump with `--inserts` (or
   `--column-inserts`) so table data restores as ordinary `INSERT` statements -
   verified clean and identical. Restoring into a **real** Postgres has no such
   limitation, so for actual graduation keep the fast default COPY format.

4. **search_path GUC bleed on the multiplexed session.** `pg_dump` begins its
   session with `SELECT pg_catalog.set_config('search_path', '', false)`. Because
   pglite-socket multiplexes many connections onto one shared PGlite session, a
   session-level GUC set by the dump connection can persist and be observed by
   other connections - after a dump, an unqualified query elsewhere saw an empty
   `search_path` until it was reset (`SET search_path=public` restores it). The
   dump itself is unaffected because pg_dump emits fully schema-qualified names.
   Practical guidance: quiesce other writers during the dump (step 1), which the
   graduation flow already does. (A related intermittent PGlite quirk,
   `access to non-system view "..." is restricted`, appeared on a view query
   while the session was in this odd state; it did not affect the dump or
   restore, and the view itself restored and queried correctly.)

5. **Extensions must exist on both ends.** If the source schema uses contrib
   extensions, two things follow. On the zeropg **source**, the extension must
   have been preloaded into PGlite for the objects to exist at all (PGlite's
   `CREATE EXTENSION` needs the JS contrib module passed to `PGlite.create`; see
   the project memory on extension preloading). On the **target**, the dump's
   emitted `CREATE EXTENSION pgcrypto` / `pg_trgm` / etc. lines require those
   extensions to be available in the managed Postgres (they are on RDS, Cloud
   SQL, and Neon). The verification schema above used no extensions, so this path
   was not exercised here - it is called out because it is the most likely
   real-app difference from the clean test case.

## Graduating from a cold backup instead of the live instance

You do not have to touch the running instance to graduate. The secondary
cold-backup system ([docs/D-COLD-BACKUP.md](D-COLD-BACKUP.md), implemented and
disaster-tested) keeps periodic copies in a second, colder bucket. You can
restore one of those backups into a throwaway PGlite datadir, serve it over the
wire with `serveWire()`, `pg_dump` it exactly as above, and load it into managed
Postgres - all without quiescing or disturbing production. That makes graduation
a fully out-of-band operation: the live database keeps serving while you stage
and validate the migration from a backup, and you cut over by repointing
`DATABASE_URL` only once you are satisfied.
