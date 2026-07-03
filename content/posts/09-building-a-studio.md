# Building a Supabase Studio without the fat Docker

*We wanted a Studio-style admin console for a scale-to-zero Postgres. The
introspection engine needed zero patches. The whole build was three single-session
landmines and a lot of tests to prove we defused them.*

[zeropg](https://github.com/reisepass/zeropg) is Postgres-in-WASM (PGlite) behind a
real wire protocol, with the database living in a bucket and the compute scaling to
zero. It already runs [unmodified apps](06-unmodified-apps.md). The thing it did not
have was the thing you actually click: a Supabase-Studio-style console - table editor,
SQL editor, logs, connection strings.

Supabase Studio itself is a heavy Next.js SSR app: ~90 prod deps, mesh-coupled to
Kong and a stack of services, no edge runtime. That is the opposite of scale-to-zero.
So the plan was: keep the one piece that is actually a database engine, rebuild the
rest as a light thing. The one piece is **`supabase/postgres-meta`** - the Node
service behind Studio that does all the introspection and runs the SQL.

## postgres-meta needed zero patches (the good surprise)

The whole plan rested on one gate: does postgres-meta work against zeropg's **single
shared session**? zeropg multiplexes every wire connection onto one serialized PGlite
backend, and that is exactly the property that breaks drivers which keep named
server-side prepared statements (the [42P05 wall](06-unmodified-apps.md)).

postgres-meta sidesteps it by construction. It uses node-postgres `pool.query(sql)`
with no statement name (so no named statement to collide) and a default pool of
`max: 1`. Every P0 endpoint - `/schemas`, `/tables`, `/columns`, and `POST /query` -
worked over the shared session with **no config, no patch, no pool tuning**. Point
its `PG_META_DB_URL` at the wire with `sslmode=disable` and it just runs.

One real gap: `GET /indexes` silently drops any secondary index whose leading column
isn't the table's first column - a catalog-join assumption PGlite's catalog exposes.
The fix is not to trust it: read `pg_indexes` through `POST /query` instead. That is
the only place the Studio has to route around postgres-meta.

## The three landmines the SQL editor is built around

A shared session means the SQL editor cannot be naive. Three behaviors, each verified,
each of which would be a correctness bug to ignore:

**1. `statement_timeout` is inert.** We set `statement_timeout='500ms'` and ran
`pg_sleep(2)`. It ran the full 2 seconds and returned 200. Single-threaded PGlite does
not deliver the timeout interrupt on these paths. So a server-enforced query timeout
is a lie you must not build into the UI. The only real guard is client-side: the BFF
stops waiting after N seconds - but the query keeps running in PGlite until it finishes
on its own. So the editor reports a timeout as *"the client stopped waiting; the query
may still be running and could still commit"* - never "cancelled." Labeling it
"cancelled" would invite a retry that duplicates a write whose original still commits.

**2. An open transaction freezes the entire backend.** This is the sharp one. Hold a
`BEGIN; SELECT 1;` open on the shared session and every other consumer - the REST API,
auth, everyone - blocks until you COMMIT. We verified it: a second client's `SELECT 42`
hung until the first transaction committed, then unblocked instantly. That serialization
is a *feature* for RLS (it makes `BEGIN; SET LOCAL role; ...; COMMIT` atomic), but in a
SQL editor it is a footgun: paste a bare `BEGIN;`, forget to commit, freeze production.
So the editor **rejects transaction-control statements** - and "run autocommit" is not
enough, because autocommit doesn't stop someone pasting `BEGIN;`. The rejection parses
the submission with a tokenizer that strips comments, string literals, and dollar-quoted
bodies first, so `SELECT 'BEGIN'` and a `BEGIN` inside a PL/pgSQL body are not false
positives, while a `BEGIN;` hidden three statements into a multi-statement paste still is.

**3. Session state leaks across requests.** `SET search_path`, `SET ROLE`, all of it
persists on the one session and bleeds into whoever runs next. So after *every* editor
submission the BFF resets the session. The reset itself had two gotchas worth the price
of admission:

- `RESET ALL` does **not** clear `SET ROLE`. You need `DISCARD ALL`, which also clears
  what `RESET ALL` misses entirely: session advisory locks, temp tables, prepared
  statements, LISTEN channels, SESSION AUTHORIZATION. We confirmed `DISCARD ALL`
  releases a held `pg_advisory_lock` and drops a temp table on PGlite.
- But `DISCARD ALL` **cannot run inside a transaction block** - and node-postgres turns
  a multi-statement string like `DISCARD ALL; SET search_path TO public` into one
  implicit transaction, so it fails with `25001`. It has to be sent as its own
  single-statement query. That one bit us: the combined form failed silently (the reset
  is best-effort) and a test caught the leak that leaked right back.

## One landmine we found by building it: COPY FROM STDIN wedges the wire

The compat spike had mapped landmines 1-3. Building the editor surfaced a fourth. If a
user submits `COPY some_table FROM STDIN`, the wire enters copy-in mode and waits for
copy data the console will never send. On PGlite that doesn't just hang - it triggers a
**FATAL `08P01` "protocol synchronization was lost"** that tears the connection down.
On a shared session that is a real wedge, distinct from an ordinary long query. So the
editor blocks `COPY ... FROM STDIN` specifically. We checked the neighbor cases too:
`COPY ... TO STDOUT` is harmless (returns immediately), and a `DO $$ BEGIN COMMIT; END
$$;` - the "can procedural code smuggle a COMMIT past the guard?" attack - is a no-op on
PGlite that leaves no dangling transaction. So we block the one thing that actually
breaks, and don't cripple the editor blocking things that don't.

## The test philosophy: seed over the wire, assert the UI shows exactly that

An admin console that displays the wrong rows is worse than none. So the rule for every
test is: **seed known data over the Postgres wire first, then assert the UI shows
exactly that data** - not "an element is visible," but the actual cell values. The table
browser suite alone seeds 120 rows and checks: column order matches introspection, each
cell equals the seeded value, the row count equals `count(*)`, pagination pages are
disjoint and exhaustive with a correct partial last page, sort order matches `ORDER BY`
including null placement, each filter matches its `WHERE` equivalent, a rendered `NULL`
is structurally distinct from an empty string, jsonb/arrays/timestamps render as the
stored value, and a 500-character cell is shown in full with no ellipsis. The SQL-editor
suite proves the landmine defenses directly: `BEGIN` and `COPY FROM STDIN` are rejected
with their real error codes, a `SET search_path` leak is gone on the next submission
(checked via `SHOW search_path`), and a held advisory lock is released by the reset
(checked via `pg_advisory_unlock` returning false). 94 assertions, one command, boots
the whole stack once.

## What it is not

No Next.js, no Kong, no Logflare/Vector. The BFF is plain `node:http`; the frontend is
vanilla JS with a real URL and a lazy-loaded chunk per view. Logs are a table in the
same Postgres (`studio.logs`) that the BFF writes to, not an external analytics
pipeline. The auth is one admin: bcrypt password, HMAC-signed cookie, session-bound
CSRF, login rate limiting, a strict route allowlist. It is a seed, not a Supabase
replacement - but it is a Studio-shaped console you can point at a database that costs
nothing while nobody is looking at it.

Code, the one-command local run, and the binding single-session rules:
[examples/cloudrun/supabase/studio](https://github.com/reisepass/zeropg/tree/main/examples/cloudrun/supabase/studio).
The postgres-meta compatibility matrix + the adversarial spike it came from:
[docs/STUDIO-PGMETA-COMPAT.md](https://github.com/reisepass/zeropg/blob/main/docs/STUDIO-PGMETA-COMPAT.md).
