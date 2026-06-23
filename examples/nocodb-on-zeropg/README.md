# NocoDB on zeropg — swap its metadata Postgres for zeropg with no app patch

Proof that **NocoDB** (an Airtable alternative) can run with its entire
**metadata database replaced by zeropg** — PGlite exposed over the real Postgres
wire via `@zeropg/client`'s `serveWire` + pglite-socket — changing only the Docker
setup, never NocoDB's source. The stock `nocodb/nocodb` image self-migrates its
~124 metadata tables over the wire on first boot and runs entirely against PGlite.

![NocoDB sign-up, served on zeropg](./test/landing.png)

## What changed vs. NocoDB's own self-hosting compose

Exactly two things — both in `docker-compose.yml`, zero source patches:

1. The `postgres:16` service → the **`zeropg-db`** service (PGlite on a Docker
   volume, exposed over the real Postgres wire). No contrib extensions are needed —
   NocoDB's Knex metadata DDL is vanilla Postgres.
2. `NC_DB` points at `zeropg-db` instead of Postgres:
   `pg://zeropg-db:5432?u=postgres&p=postgres&d=postgres`.

Nothing else. NocoDB does **not** need migrations pre-applied: pointed at a fresh
Postgres it runs its own Knex migrations over the wire on first boot, so `zeropg-db`
just serves an empty database. NocoDB's runtime is Knex over node-postgres — exactly
the path that works over the wire.

## Run it

```sh
./prepare.sh                                  # copy @zeropg/client into the build context
docker compose -p nocodb-zeropg up -d --build # zeropg-db boots, then NocoDB self-migrates
# open http://localhost:3103
```

Verify end-to-end in a real browser (signs up the super-admin, creates a base +
table + row through the UI, then reads it all back out of zeropg over the wire):

```sh
node test/verify.mjs   # run from the zeropg repo root (resolves playwright + pg)
```

## Verified result (fresh DB, observed)

- `zeropg-db` boot: empty DB; NocoDB self-migrated **124 `nc*` metadata tables** over
  the wire onto PGlite. NocoDB logs `Nest application successfully started` /
  `App started successfully`. Health endpoint `/api/v1/health` returns `{"message":"OK"}`.
- Driving the **real NocoDB UI** in Playwright (no 5xx anywhere):
  - **Sign up** (super-admin) → `nc_users_v2`:
    `{ email: "admin@zeropg.example.com", roles: "org-level-creator,super" }`
  - **Create base** "Zeropg Demo Base" → `nc_bases_v2`.
  - **Create table** "Customers" → `nc_models_v2` (NocoDB creates a dedicated
    Postgres **schema per base**, named by the base id — PGlite supports multi-schema).
  - **Insert a row** "Ada Lovelace" via the (canvas-rendered) grid.
- Reading back over the wire with a plain `pg` client (`127.0.0.1:5463`):

  ```
  physical data table "p1fbvb9s462ud2y"."Customers": 1 row(s)
  rows: [ { id: 1, title: "Ada Lovelace", created_by: "us3comr...", ... } ]
  ```

  i.e. the row NocoDB wrote through its UI landed in zeropg, in the per-base schema
  NocoDB created over the wire.

## Ports & project

- Compose project: `nocodb-zeropg`
- NocoDB app: **3103** (container 8080)
- zeropg-db Postgres wire: **5463** (container 5432) — poke it with
  `psql postgres://postgres:postgres@127.0.0.1:5463/postgres`

## Caveats

- **Single-session PGlite**: NocoDB's metadata pool + per-base data tables all
  serialize through one writer. This example runs a **single NocoDB container** (no
  separate `worker` service) — matching NocoDB CE's in-process model. Concurrency is
  serialized; fine for self-host / small instances. Graduating to a managed Postgres
  is an `NC_DB` change.
- The `zeropg-db` image installs `@zeropg/client` from a packed tarball
  (`prepare.sh`) so the example works without publishing.
