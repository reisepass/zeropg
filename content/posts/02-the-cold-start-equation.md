# The cold-start equation: your database is not the bottleneck, your framework is

We ran 13 services on scale-to-zero infrastructure with the database living in a GCS
bucket ([zeropg](https://github.com/reisepass/zeropg): real Postgres, restored from
object storage on wake). Then we forced cold starts on all of them and measured. One
equation explains every number we saw:

```
cold_start ≈ platform_floor (~2s) + database_restore (~1.5-9s by size) + app_boot
```

The first two terms are boringly predictable. The third term is where cold starts go to
die, and it is entirely an app property.

## The numbers

| service | stack | measured cold start |
|---|---|---|
| bare DB demo, 10MB | none | 3.8s |
| zeropocket (PocketBase-style backend) | static Go binary | **~3.5s** |
| cocoon (Bluesky-compatible PDS) | Go binary | ~5s |
| PrivateBin | PHP-FPM | ~5s |
| bare DB demo, 500MB | none | 11.2s |
| nostream (nostr relay) | Node | ~14.5s |
| Rallly | Next.js | 21-36s |
| Documenso | Next.js/Remix | ~30s |
| NocoDB | Node | ~34s |
| Cal.com | Next.js monorepo | **>120s (we dropped it)** |

Read the first four rows again. A full PocketBase-style backend (collections, auth,
admin UI) cold-starts as fast as the bare database demo. Restoring Postgres itself from
a bucket, which sounds like the scary part, costs ~1.5s at 10MB. A static Go binary
boots in single-digit milliseconds, so its cold start IS the restore.

Then look at the bottom half. Same database, same restore, same platform. NocoDB pays
~29 seconds of its own Node boot on every wake. Cal.com paid over two minutes and got
cut from our live demos.

## Three things this changes

**1. "Scale-to-zero can't work, cold starts" is aimed at the wrong layer.** The
database's contribution is a few seconds and scales with data size, not code size. If
your wake takes 30 seconds, 25+ of them are your framework initializing itself.

**2. Picking a runtime is now picking a cold-start budget.** For always-on servers,
framework boot time is a deploy-time cost nobody notices. The moment you scale to zero,
it becomes a per-user-visible latency. Go/Rust static binaries: near-free. Node with a
bundler: ~10-15s. A Next.js monorepo: eviction territory.

**3. Sidecars are free.** Counterintuitive but measured: adding a Redis sidecar
(Dragonfly or valkey) to the instance added ~0 to the critical path, because containers
boot in parallel and Redis is ready in under a second while the DB restore is still
streaming. We A/B'd Dragonfly vs valkey on the same app: 14.5s vs 15.0s, a wash, both
dominated by the app's own boot.

## Measurement traps (learn from our wasted rounds)

Two things silently corrupt cold-start measurements of public URLs:

- **Internet scanners keep your service warm.** Any public HTTPS endpoint gets enough
  random crawler traffic to defeat "it has been idle for an hour, so this is a cold
  start." Read the platform's boot logs to classify cold vs warm; don't trust the clock.
- **Probing resets the idle timer.** Cloud Run reaps after ~15 idle minutes, and every
  probe restarts that clock. Our 4-round harness at 14-minute spacing produced warm
  readings from round 2 on. You need 20-25 minutes of true hands-off idle per clean rep.

Funniest case: our AT Protocol PDS cannot be cold-measured at all anymore, because the
real Bluesky network generates enough background traffic to keep it permanently warm.
Which is its own finding: a service with any organic traffic rarely cold-starts in
practice.

## The takeaway

If you want scale-to-zero with a database, the stack that works is: a fast-booting
binary + a database whose state restores in O(data size). The conventional wisdom says
serverless databases are the hard part. After 13 services: the database was the easy
part. The 30-second cold starts came from the JavaScript.

All raw data: `results/coldstart-apps.jsonl` in the repo, model written up in
[docs/COLDSTART-MODEL.md](https://github.com/reisepass/zeropg/blob/main/docs/COLDSTART-MODEL.md).
