# Cal.com on zeropg — swap Postgres for zeropg with no app patch

Proof that a **real, unmodified Prisma app** ([Cal.com](https://github.com/calcom/cal.com), the
Calendly alternative) can run with its **full Postgres replaced by zeropg** — changing only the
Docker setup, never Cal.com's source. The official prebuilt image (`calcom/cal.com:latest`,
v6.2.0) is used as-is.

![Cal.com signup, served on zeropg](./test/after-signup.png)

## Why Cal.com works over the wire

Cal.com's runtime already talks to Postgres through a plain `pg` connection: `packages/prisma/index.ts`
uses `@prisma/adapter-pg` (`PrismaPg` + a `pg` `Pool`) and its schema generator is set to
`engineType = "client"` — so there is **no native Prisma query-engine binary** at runtime, exactly
the path that works against single-session PGlite. Cal.com's schema needs **no Postgres contrib
extensions** (no citext/pgcrypto/pgvector); all 588 of its real migrations apply cleanly to PGlite
(PL/pgSQL functions, triggers, views, GIN-on-array, and `CREATE INDEX CONCURRENTLY` all work).

## What changed vs. Cal.com's own self-hosting compose

Only the Docker setup — zero source patches:

1. The `postgres` service → the **`zeropg-db`** service (PGlite on a Docker volume, exposed over the
   real Postgres wire via `@zeropg/client`'s `serveWire` + pglite-socket). It applies Cal.com's
   **real, untouched migrations in-process** on boot (idempotent marker table).
   - The migrations are copied **out of the same official app image** (`COPY --from=calcom/cal.com`),
     so the schema is always in lockstep with the app's bundled Prisma client — no version drift.
     (Cloning migrations from `main` instead produced a P2022 `column "disableImpersonation" does not
     exist` mismatch against the v6.2.0 image; taking them from the image fixes that structurally.)
2. The app's startup drops the `prisma migrate deploy` line from its stock `scripts/start.sh`
   (Prisma's native schema engine can't drive single-session PGlite). Everything else from
   `start.sh` is kept verbatim — the URL placeholder replacement, the DB wait, the app-store seed,
   then `yarn start`. Cal.com's official image is otherwise unchanged.

The Redis service from Cal.com's compose is also dropped: it isn't required for core flows (rate
limiting falls back to disabled without `UNKEY_ROOT_KEY`; no in-process BullMQ worker on the web tier).

## Run it

```sh
./prepare.sh                                   # pack @zeropg/client into the build context
docker compose -p cal-zeropg up -d --build     # zeropg-db applies 588 migrations, then Cal.com boots
# open http://localhost:3101
```

Verify end-to-end (drives Cal.com's real signup UI in headless Chromium, then reads the row back
from zeropg over a plain `pg` wire):

```sh
# from a dir with `playwright` + `pg` installed:
APP=http://localhost:3101 PG=postgres://postgres:postgres@127.0.0.1:5461/calendso \
  node test/verify.mjs
```

## Verified result

- `zeropg-db` boot: **588/588 of Cal.com's real migrations applied, 124 public tables** (no extensions).
- Cal.com boots (`Next.js ✓ Ready`), and its app-store seed wrote **104 `App` rows to zeropg via Prisma
  over the wire** during startup. Serves real pages (`/`, `/signup`, `/auth/login`), **no 5xx**.
- Signing up through the real UI (username + email + password, no email verification, no OAuth)
  returned `201 POST /api/auth/signup` and wrote a real user to zeropg:

  ```
  users row:        { id: 1, username: "zeropg-demo-<ts>", email: "zeropg-demo-<ts>@example.com",
                      identityProvider: "CAL", created: "2026-06-23T11:00:43.685Z" }
  UserPassword row: { userId: 1, hash: "$2a$12$WZvupUkSDlRjDls6xGcjPOHjqbXVO2zjD4RoVvAmwoh3IhCVeyaeK" }
  ```

## Caveats

- Email is not configured (no SMTP / `EMAIL_FROM`), so flows that send a verification code stop at
  "check your email". `email-verification` is a Cal.com feature flag that is **off by default**, so
  the user row is written without any emailed code — which is what this proves. Add `EMAIL_*` env to
  complete the verify-then-login flow.
- Single-session PGlite: concurrent requests serialize through one writer (fine for self-host / small
  instances; the "graduate to a managed Postgres" path is a `DATABASE_URL` change).
- The `zeropg-db` image installs `@zeropg/client` from a packed tarball (`prepare.sh`) so the example
  builds without publishing. Once `@zeropg/client` with `serveWire({ extensions })` is on npm, the
  Dockerfile can `npm install @zeropg/client` directly.
- The official Cal.com image is amd64-only; on Apple Silicon it runs under emulation
  (`platform: linux/amd64` is set in the compose file) — boot is slower but functional.
