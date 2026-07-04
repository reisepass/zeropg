# Survey: ultra-light open-source Postgres editors (run-don't-build candidates)

2026-07-04. Companion to [CONSOLE-DATA-EDITOR-SPEC.md](CONSOLE-DATA-EDITOR-SPEC.md)
(decision: our own grid/SQL editor are frozen; we hand off to existing tools).
This survey answers: which tools are small, fast-starting, and cheap enough to run
**dozens at once** (one per zeropg instance, or one multiplexing many), with
licenses that do not contaminate the MIT repo when run as separate services.

Two deployment models matter and they rank differently:

- **Model A - spawn per instance** (fleet-console launcher): binary starts next to
  each zeropg wire. Wants tiny RSS + sub-second start.
- **Model B - one editor, many databases**: a single long-lived editor process that
  connects to any fleet member on demand. "Dozens at once" collapses to ONE
  process; the per-DB cost is a connection, not a process.

## The table

| tool | stack | license | size / RSS | start | data editing | SQL editor | model | zeropg wire risk |
|---|---|---|---|---|---|---|---|---|
| **pgweb** (sosedoff, v0.17.0 Nov 2024, active) | Go single binary, zero deps | **MIT** | binary ~15MB, container <128MB, RSS ~20-40MB | instant | **NO row editing** - browse/filter/export only | yes (raw SQL + explain + export) | A (also B via login form) | LOW: lib/pq, unnamed statements |
| **WhoDB** (clidey, active) | Go+React single binary | **Apache-2.0** | <50MB image, "90% less RAM than DBeaver", RSS low tens MB | <1s | **YES inline row edit** + schema view | yes | A or B (multi-conn UI) | **UNTESTED: GORM/pgx - may need cache_describe; killswitch before adopting** |
| **pgconsole** (pgplex, new 2026) | Go single binary + TOML config | **Apache-2.0** | single binary, no own DB | fast | limited (SQL-first tool) | **yes, with real PG-parser autocomplete**, ACLs, audit log | **B** (connections in one TOML = whole fleet in one process) | UNTESTED (Go driver, likely pgx - same killswitch needed) |
| **Adminer 5** (vrana, v5.4.2 Feb 2026 - actively maintained again; AdminerEvo fork now stale) | **one PHP file** (~0.5MB) + php runtime | Apache-2.0 / GPLv2 | php:apache container ~30-60MB RSS | instant | **YES full row edit + DDL forms** | yes | **B** (any server via login form - one container serves the whole fleet) | **LOW - pdo_pgsql already VERIFIED drop-in on zeropg** (privatebin work) |
| **DbGate** (MIT, active) | Node + web mode docker | **MIT** | 512MB+ recommended | seconds | YES full grid edit, import/export, diagrams | yes | B (multi-connection) | LOW: node-postgres |
| Outerbase Studio | Next.js | AGPL-3.0 | heavy | slow | YES (staged commits - nice UX) | yes | B | untested; PG marked beta |
| CloudBeaver | Java/JVM | Apache-2.0 | JVM-heavy (500MB+) | slow | YES | yes | B | REJECT on weight |
| NocoDB | Node, full app | AGPL-3.0 | heavy (its own 124-table metadata schema) | slow | YES (Airtable UX) | limited | B | **already VERIFIED on zeropg** |

Niche/desktop (not our shape, noted for completeness): Ferox (Rust native desktop,
~25MB RSS), postgres-e-gui (rust+egui), gobang (Rust TUI), Beekeeper (Electron).

## Ranked recommendation

1. **Adminer 5 for editing, today.** Single file, editing + DDL included, one
   container multiplexes every fleet DB (model B), and its driver (pdo_pgsql) is
   the one client we have ALREADY verified against pglite-socket. Active again
   upstream (5.4.2, Feb 2026). The UI is dated but it is the pragmatic zero-build
   answer for "let someone edit rows right now".
2. **pgweb for read/query fan-out.** MIT, instant, tiny; the natural per-instance
   spawn for the fleet console's "Open in..." button. Its hard limit: no grid
   editing (SQL editor only for writes) - pair it with Adminer rather than
   replacing it.
3. **WhoDB as the modern bet - after a killswitch test.** Apache-2.0, single
   binary, actual inline editing, sub-second start. The one unknown is its
   GORM/pgx layer vs our named-prepared-statement wall; the cocoon precedent
   (DSN `default_query_exec_mode=cache_describe`) suggests it is a config fix if
   it bites at all, but nobody adopts it until the killswitch passes.
4. **pgconsole to watch** for the team/audit angle (ACLs + audit + autocomplete in
   one Apache-2.0 binary, fleet-as-TOML). Young project; same pgx caveat.

## What this means for the Console

The Console's "Open in..." panel (CONSOLE-DATA-EDITOR-SPEC.md section 4) gets
three concrete recipes instead of an abstract list:

- `docker run -p 8081:8080 adminer` -> login form pointed at the instance wire
  (edit rows, DDL) - one shared container is enough for the whole fleet.
- `pgweb --url postgres://.../...` -> per-instance explorer (read/query/export).
- NocoDB compose recipe for the Airtable-grade case (verified, heavier).

Killswitch TODO before promoting WhoDB or pgconsole into the recipes: the
standard 42P05/concurrency/poisoning test against a local wire (reuse
killswitch-pgmeta.mjs's harness pattern).
