# zeropg

**Postgres that costs zero when nobody's using it.**

A real Postgres database (via [PGlite](https://pglite.dev), Postgres compiled to WASM) running on serverless compute - Cloudflare Workers, Google Cloud Run, AWS Lambda - with the data living in object storage (R2, GCS, S3). No database server, no volume, no managed Postgres bill. Single writer, enforced by a lease built on conditional writes. When your app outgrows it, switching to an always-on Postgres is one env var, because it was real Postgres all along.

Think of it as: Litestream, but for Postgres, and built into the database's own filesystem layer.

Status: design phase.

- [DESIGN.md](DESIGN.md) - full architecture: prior art, the lease/fencing protocol, manifest-swap commits, generations, platform notes, roadmap.
- [EXPERIMENTS.md](EXPERIMENTS.md) - the ordered experiment plan to validate it on Google Cloud (Cloud Run + GCS).
