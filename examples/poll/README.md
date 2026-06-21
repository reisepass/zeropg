# Poll — a tiny Rallly/Doodle clone, as a real **Prisma** app on zeropg

The point of this example: an existing **Prisma** codebase runs on zeropg. You
create a meeting poll with time-slot options, share the link, people mark each
slot ✓ / ~ / ✗, and the grid + "best option" update live. All data access is
Prisma; the database is PGlite living wherever `serveWire` points (a local file
here, a bucket in prod).

```bash
# one-time setup (generates the Prisma client into node_modules)
npx prisma generate --schema examples/poll/prisma/schema.prisma

# run it
npx tsx examples/poll/index.ts          # http://localhost:8083  (file:// datadir)
```

## How Prisma works on zeropg (the important part)

Prisma's native **migrate engine cannot drive** PGlite over the wire (it needs
multiple privileged sessions + advisory locks + a shadow DB; verified to fail
with `P1017` — see `experiments/prisma-spike` and `ORM-ADAPTER-NOTES.md`). So we
use the pattern that **does** work end to end:

1. **Author** migrations with the zeropg CLI — no external Postgres, it uses a
   throwaway in-process PGlite shadow (see `packages/cli`):
   ```bash
   cd examples/poll
   npx tsx ../../packages/cli/src/zeropg.ts migrate dev --name <name>
   ```
   This writes `prisma/migrations/<timestamp>_<name>/migration.sql`.
2. **zeropg's single writer applies** the committed migrations at boot, via
   `@zeropg/cli`'s `migrateDeploy()` (`boot.ts`). This is the single-applier
   rule: the instance owns its schema, nothing pushes DDL over the wire — and
   the example dogfoods the same CLI codepath users get.
3. **Prisma queries** over the wire via `@prisma/adapter-pg` →
   `@electric-sql/pglite-socket` → PGlite. Nested writes, relations, filters —
   all normal Prisma.

`boot.ts` ties it together: `migrateDeploy()` applies the committed migrations to
the datadir → `serveWire()` (a localhost `postgres://` over a lock-guarded
`file://` PGlite) → `new PrismaClient({ adapter })`.

Graduate by pointing `PrismaPg` at a real `postgres://` (RDS/Neon) — same app
code. Move the datadir to a bucket-backed zeropg — same app code.

## Tests

```bash
npx tsx examples/poll/test/api.test.ts   # HTTP + Prisma: create, vote, tally, reboot-durable
npx tsx examples/poll/test/e2e.test.ts   # headless chromium: create -> 2 people vote -> best -> persisted
```

Both verified passing (api 10 assertions, e2e 20). The e2e drives the real
browser, which is how the `<select form=…>` association bug got caught — curl
alone wouldn't have.
