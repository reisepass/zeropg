# Thread 9: building a studio (pairs with posts/09-building-a-studio.md)

1/
We built a Supabase-Studio-style admin console for a Postgres that scales to zero (WASM Postgres, DB in a bucket, one shared wire session).

The introspection engine needed ZERO patches. The whole build was three single-session landmines and the tests to prove we defused them.

2/
Supabase Studio itself is a heavy Next.js app: ~90 prod deps, coupled to Kong + a service mesh, no edge runtime. Opposite of scale-to-zero.

So we kept the one piece that's actually a database engine - supabase/postgres-meta - and rebuilt the rest as plain Node + vanilla JS.

3/
The gate: does postgres-meta survive zeropg's SINGLE shared session (the thing that breaks named-prepared-statement drivers)?

It does, by construction: node-postgres pool.query with no statement name, pool max:1. Every P0 endpoint worked with no patch, no config. Point PG_META_DB_URL at the wire, done.

4/
One gap: postgres-meta's GET /indexes silently drops secondary indexes whose leading column isn't the table's first column (a catalog-join assumption PGlite exposes).

Fix: don't trust it. Read pg_indexes through POST /query instead.

5/
Landmine 1: statement_timeout is INERT on PGlite.

We set statement_timeout=500ms, ran pg_sleep(2). It ran the full 2 seconds and returned 200. Single-threaded WASM doesn't deliver the interrupt.

So the editor timeout is client-side only, and the UI says "client stopped waiting; the query may still be running" - NEVER "cancelled." Labeling it cancelled invites a retry that double-writes.

6/
Landmine 2: an open transaction freezes the ENTIRE backend.

Held a BEGIN; SELECT 1; open. A second client's SELECT 42 hung until COMMIT, then unblocked instantly. Everyone - REST, auth - blocks.

Great for RLS atomicity. A footgun in a SQL editor. So the editor REJECTS transaction control.

7/
"Just run autocommit" isn't enough - it doesn't stop someone pasting BEGIN;.

The reject parses the submission with a tokenizer that strips comments, strings, and dollar-quoted bodies first. So SELECT 'BEGIN' and a BEGIN inside a PL/pgSQL body aren't false positives, but a BEGIN; buried in a multi-statement paste still is.

8/
Landmine 3: SET / SET ROLE / search_path leak across requests on the shared session.

So the BFF resets after every submission. Two gotchas:

- RESET ALL does NOT clear SET ROLE. DISCARD ALL does - plus advisory locks, temp tables, prepared statements, LISTEN, SESSION AUTHORIZATION.
- But DISCARD ALL can't run inside a transaction block, and node-postgres makes a multi-statement string one implicit txn -> 25001. It must be sent alone.

9/
Landmine 4, found by BUILDING it (the spike missed this one):

COPY some_table FROM STDIN puts the wire into copy-in mode waiting for data the console never sends. On PGlite that's a FATAL 08P01 "protocol synchronization was lost" - it tears the connection down. A real wedge of the shared session.

So we block COPY FROM STDIN specifically.

10/
We checked the neighbors so we don't over-block:

- COPY ... TO STDOUT: harmless, returns immediately. Allowed.
- DO $$ BEGIN COMMIT; END $$; (can procedural code smuggle a COMMIT past the guard?): a no-op on PGlite, no dangling txn. Allowed.

Block the one thing that breaks; don't cripple the editor.

11/
Test rule for all of it: seed known data OVER THE WIRE, then assert the UI shows EXACTLY that data. Not "element visible" - the actual cell values.

Table browser: 120 seeded rows, checks column order vs introspection, each cell vs seed, count vs count(*), pagination disjoint+exhaustive, sort vs ORDER BY incl nulls, filter vs WHERE, NULL distinct from empty string, jsonb/array/timestamp, 500-char cell not truncated.

12/
The landmine defenses are tested directly: BEGIN and COPY FROM STDIN rejected with their real error codes; a SET search_path leak gone on the next submission (via SHOW search_path); a held advisory lock released by the reset (via pg_advisory_unlock -> false).

94 assertions, one command, boots the whole stack once.

13/
What it's NOT: no Next.js, no Kong, no Logflare. Plain node:http BFF, vanilla-JS SPA with a real URL per view, logs are a table in the same Postgres. One admin: bcrypt, HMAC cookie, CSRF, rate limit, strict route allowlist.

A Studio-shaped console you can point at a database that costs nothing while nobody's looking at it.

Code + the one-command local run: https://github.com/reisepass/zeropg/tree/main/examples/cloudrun/supabase/studio
The compat spike: https://github.com/reisepass/zeropg/blob/main/docs/STUDIO-PGMETA-COMPAT.md
