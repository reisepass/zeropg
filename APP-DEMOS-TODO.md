# TODO: app demos + advanced roadmap (resume when Claude quota is back)

Paused 2026-06-14: the omnirouter Claude pool drained to its reserve floors (10% session / 20% weekly), so the parallel agents stalled on 429 "accounts blocked by preflight". Both dev VMs shut down to stop burning cost. Resume when quota resets, OR lower the omnirouter reserve thresholds, OR add accounts to the pool.

## App-demo deployment (the active work)
Goal: deploy PrivateBin, Rallly, Cal.com, Open WebUI on **Google Cloud Run, scale-to-zero**, each backed by **zeropg as a sidecar** — NO forking the apps.

**Architecture (decided):** Cloud Run **multi-container service** = official app image (unmodified) + **zeropg-sidecar** container, app connects over **localhost:5432**, app declares a startup dependency on the sidecar's `pg_isready` probe, whole service scales to zero. NOT a separate service (Cloud Run ingress is HTTP-only, no raw Postgres TCP between services — but container-to-container localhost TCP works, proven by the Cloud SQL Auth Proxy sidecar pattern). NOT baked into the app image (that'd be a fork). One reusable zeropg-sidecar image for all apps.

**Branches (work-in-progress, partially committed, may be unpushed):** `feat/app-demos` (foundation: pool verdict + sidecar image), `app/privatebin`, `app/rallly`, `app/calcom`, `app/openwebui`.

**THE #1 OPEN QUESTION — connection pooling (make-or-break):** PGlite is single-connection; apps (Prisma/PDO/SQLAlchemy) open connection POOLS. Does the zeropg wire server (`packages/server`, pglite-socket) accept MULTIPLE concurrent client connections, and survive a held-open transaction on one while another queries? `experiments/pool-test.ts` was created to test this; **verdict not yet confirmed.** If it only accepts one connection or deadlocks, `packages/server` needs multi-connection multiplexing onto the single PGlite engine BEFORE any pooled app (esp. Prisma) works. Resolve this first.

**Per-app risks:** Rallly + Cal.com are the same stack (Next.js + Prisma) → share the pool risk + Prisma's `pg_advisory_lock` on migrate (verify on PGlite; no-fork workaround = run migrate as init / `prisma db push` via command override). PrivateBin = low risk (PDO pgsql, simple schema). Open WebUI = highest risk (confirm Postgres main-DB, `ENABLE_AUTOMATIONS=false` actually stops the background poller so it can idle, external LLM API, pgvector only if RAG). Cold start is serial+additive (sidecar restore THEN app boot) ~15-25s for Prisma apps — generous startup probe + connect_timeout.

## Unimplemented roadmap (the menu, ranked)
- **v2 #1 numbered immutable manifests** (design in docs/A2-NUMBERED-MANIFESTS.md) — top pick: fixes GCS ~1-write/s-per-object cap (measured 52% rejection) + free PITR.
- v2 #2 writer-epoch + halt-on-first-fence (SlateDB) · #3 LTX pre/post checksum chain on segments · #4 GCS `compose` segment folding + restore-budget-driven compaction · #5 deferred-deletion window → PITR + zero-copy branches (D1 Time Travel) · #6 AWS S3 transport + CAS conformance suite (R2/Tigris/IBM-COS already verified live).
- v3 #7 output gates (hide commit latency) · #8 appendable WAL-tail tier (S3 Express / GCS Rapid, sub-10ms commits) · #9 lazy page-faulting restore (IN PROGRESS, branch feat/lazy-page-restore: 500MB/1GB/2GB MEASURED — point-lookup 2.2x→4.3x→5.8x as size grows) · #10 replica WAL-tailing (apply segments vs re-materialize).
- **SDK (DESIGN §5)** — `DATABASE_URL` scheme-switch client + `migrate-out` CLI — unbuilt.

## Standalone server (under-tested — flagged)
`packages/server` (pglite-socket wire server) has only `experiments/pool-test.ts`. Needs a real test matrix to the core-engine bar: crash safety (SIGKILL mid-commit/restore → byte-identical recovery), lease handoff (zombie fenced), multi-connection. This is what the apps AND Fly depend on, so harden it.

## Fly.io note
`fly.io/docs/postgres` is the local-volume model (real Postgres on a Fly Machine + zonal volume, Fly proxy auto-starts on connect) — that's the Sablier/local-disk pattern, Fly-specific, a DIFFERENT product from zeropg (data on disk, not bucket). Do NOT implement it. Generic nugget worth a v3 spike: where a local disk exists (Fly volume), keep a **warm cache of the restored datadir on disk across stops** so wake skips the bucket restore (near-instant) while the bucket stays the durable truth — bridges Sablier's fast wake with zeropg's durable data.

## Infra state
- VMs `blob-pglite-dev` (8GB) and `zeropg-lazy-big` (32GB) STOPPED. On-VM cron auto-shutdown (`/etc/cron.d/zeropg-autostop`, June 17 3am) set as a backstop. Repo + worktrees + creds (~/.zeropg-omni.env, ~/.zeropg-fly.env, ~/.zeropg-ibm.env) persist on the big VM's disk.
- Live Cloud Run demos still up (GCS/IBM/Tigris/R2 + Fly raw-psql) for the presentation.
- Deploy plan detail was in /tmp/DEPLOY-APPS-PLAN.md (wiped on stop — its essence is the Architecture section above).
