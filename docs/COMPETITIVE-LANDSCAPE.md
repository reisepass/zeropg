# Competitive landscape, 2026-07-30

Who else sells "Postgres that costs little or nothing when idle", and where that leaves zeropg.
Prices and product states change fast; every claim here carries its source so it can be
re-checked rather than trusted.

## The Fly.io picture is three products, not one

This matters because "just use Postgres on Fly" means three different things with wildly
different economics.

### 1. Fly Postgres, now labelled **Legacy / Unmanaged**

A regular Fly app with `flyctl` sugar on top. Real Postgres on a Fly Volume, using the same
building blocks as any Fly app: volumes, private networking, health checks, metrics. Fly is
explicit that **this is not a managed database** and **is not supported by Fly.io Support** -
you own operations, management and disaster recovery. Fly's docs now steer users to `fly mpg`
instead. ([Fly Postgres (Unmanaged)](https://fly.io/docs/postgres/),
[This Is Not Managed Postgres](https://fly.io/docs/postgres/getting-started/what-you-should-know/))

**This is zeropg's real competitor for a single database on Fly**, and it is a strong one. It
scales to zero through `auto_stop_machines` with the volume persisting, and behind it sits a
real Postgres: no 0.5GB ceiling, real concurrency, working advisory locks, working
`LISTEN`/`NOTIFY`, working `COPY`, and Rust `sqlx` and Diesel both fine. For one database, use
this rather than zeropg.

### 2. Fly Managed Postgres (`fly mpg`)

Fly's own managed offering: HA, automatic failover, encrypted backups, monitoring, 24/7
support. Also, per the docs as of 2026-07-30 ([fly.io/docs/mpg](https://fly.io/docs/mpg/)):

| | |
|---|---|
| cheapest plan | **$38/month** (Basic, Shared-2x, 1GB RAM) |
| storage | $0.28 per provisioned GB per 30-day month |
| free tier | none |
| **scale to zero / auto-suspend** | **not offered** |
| network | private to your Fly organization, no public `postgres://` documented |

**A $38/month floor with no scale-to-zero is not competing for the idle workload at all.** For
a database idle 95% of the day, this is the expensive option by one to two orders of magnitude.
It is also private-network-only, so it does not give you the public `postgres://` that Fly's raw
TCP ingress makes possible.

### 3. Fly Postgres "managed by Supabase" - dead

Announced late 2023, **deprecated 11 April 2025**
([Supabase changelog](https://supabase.com/changelog/33413-deprecation-of-fly-io-postgres-managed-by-supabase-on-april-11-2025)).

Supabase's stated reason is the interesting part: the deprecation "enables us to focus on a new
architecture for **scale-to-zero databases**, zero-downtime upgrades, and more."

## Supabase is building the shape we identified as zeropg's niche

This is the finding that should change how we talk about positioning.

- **Scale-to-zero exists today** on Supabase's **Pico** instances, pitched explicitly at
  "platforms with many projects that have variable usage, where you only pay for what users
  actually use". Nano has it for select customers only.
  ([Supabase for Platforms](https://supabase.com/blog/introducing-supabase-for-platforms))
- **Branching** spawns a full Preview Environment per pull request. Preview branches are
  **ephemeral**, **automatically paused after inactivity**, and deleted when the PR closes.
  ([Branching docs](https://supabase.com/docs/guides/deployment/branching),
  [Branching publicly available](https://supabase.com/blog/branching-publicly-available))

Read those two together and Supabase already ships: many isolated databases, mostly idle, paid
per actual use, with ephemeral per-PR instances that auto-pause. **That is close to the exact
use-case list in this repo's README** - per-tenant databases, preview environments,
agent-spawned databases.

So the honest position is not "nobody does this". It is "a well-funded incumbent is doing this,
as a managed service, with real Postgres behind it".

**Not yet verified and worth checking before making any cost claim:** Pico's actual per-project
price, whether there is a per-project floor, and what the paused-state cost is. Without those
numbers we cannot say zeropg is cheaper at fleet scale, only that it *might* be.

## What is actually left that is differentiated

Stated conservatively, after the above.

1. **It is yours.** Your bucket, your cloud account, no vendor holding the data. Every
   competitor here is a hosted service; the closest self-hostable equivalent is running Postgres
   yourself, which is the thing this project exists to avoid.
2. **Storage is the source of truth and compute is disposable.** A database has no host. Blow
   the machine away and restore anywhere in seconds; move a database by copying a bucket prefix.
   Backups are the architecture, not a schedule.
3. **Cost is bucket-shaped at fleet scale.** A hundred idle prefixes cost the bucket bill.
   Volumes are provisioned and region-pinned, one per database. This is the strongest remaining
   axis and it is unquantified against Supabase Pico.
4. **Read replicas follow the bucket** rather than needing replication. Volumes cannot be shared
   between Machines.

## What this argues for

- **Stop describing Fly as "the standout because it gives a real `postgres://`".** Fly's raw TCP
  ingress is a Fly property, not a zeropg one, and Legacy Postgres on a volume gets it too with
  a better database behind it. The accurate framing is that Fly is the platform where zeropg
  *can* offer `postgres://`, and that this matters mainly at fleet scale.
- **The one number that decides the pitch is cost per idle database at 10 and 50 databases,
  against Supabase Pico and against a volume per database.** Everything else is detail. Tracked
  as E8 in [EXPERIMENTS-QUEUE.md](EXPERIMENTS-QUEUE.md), which currently only has the VM column.
- **Fly MPG's $38/month floor is the single most quotable competitive fact found here**, and it
  is the honest comparison for anyone who wants managed Postgres on Fly rather than an
  unsupported app they operate themselves.

## Sources

- [Fly Postgres (Unmanaged) docs](https://fly.io/docs/postgres/)
- [This Is Not Managed Postgres](https://fly.io/docs/postgres/getting-started/what-you-should-know/)
- [Fly Managed Postgres docs](https://fly.io/docs/mpg/)
- [Supabase: deprecation of Fly.io Postgres managed by Supabase](https://supabase.com/changelog/33413-deprecation-of-fly-io-postgres-managed-by-supabase-on-april-11-2025)
- [Supabase: Fly Postgres, managed by Supabase (the original announcement)](https://supabase.com/blog/postgres-on-fly-by-supabase)
- [Introducing Supabase for Platforms](https://supabase.com/blog/introducing-supabase-for-platforms)
- [Supabase Branching docs](https://supabase.com/docs/guides/deployment/branching)
- [Branching now publicly available](https://supabase.com/blog/branching-publicly-available)
- [Fly community: future of Legacy Postgres](https://community.fly.io/t/future-of-legacy-postgres/24609)
