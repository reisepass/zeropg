# The cold-start model: cold ≈ restore + app boot

Measured across 13+ live scale-to-zero services (raw data: [`../results/coldstart-apps.jsonl`](../results/coldstart-apps.jsonl),
[`../results/`](../results/) E3 distributions). The single most useful fact from running
many real apps on zeropg:

```
cold_start ≈ platform_floor (~2s on Cloud Run)
           + zeropg_restore (scales with DB size: ~1.3s @ 10MB → ~9.1s @ 500MB)
           + app_boot       (an APP property: ~5ms for a static Go binary, 20-120s for a Next.js monorepo)
```

The zeropg part is a near-constant **~3.5-5s for small databases** (mostly the
platform's container floor). Everything beyond that is the app's own boot weight.
**The database is not the cold-start bottleneck; your framework is.**

## Measured cold starts (forced fresh instance, boot to serving)

| service | stack | cold start | what dominates |
|---|---|---|---|
| zeropg storage demo, 10MB DB | none (the DB itself) | 3.8s p50 / 4.7s p99 | platform floor + restore |
| zeropg storage demo, 50MB DB | none | 3.5s / 4.3s | platform floor + restore |
| **zeropocket** (PocketBase-style) | static Go binary | **~3.5s** | restore only; app boot ~ms |
| **webhookx** | Go binary | ~4-5s (restore variance up to ~35s worst case) | restore only |
| **cocoon** (AT Proto PDS) | Go binary | **~5s** (rarely cold in practice: live AT-Proto traffic keeps it warm) | restore only |
| **PrivateBin** | PHP-FPM, tiny schema | ~5s (5.0, 5.2 measured) | restore + PHP-FPM |
| airtable-style example | Go binary, rows-as-JSONB | ~8s | restore |
| zeropg storage demo, 500MB DB | none | 11.2s / 12.3s | restore scales with size |
| nostream (nostr relay) + Redis sidecar | Node | ~14.5s | nostream's Node boot |
| Rallly | Next.js | 21-36s (high variance) | Next.js boot |
| Documenso | Next.js/Remix | ~30s (one 112s outlier observed) | Next.js boot |
| NocoDB | Node | ~34s (consistent) | Node boot |
| Cal.com | Next.js monorepo | **>120s → dropped** | app boot + on-boot app-store seed |

## What this means for choosing (or writing) an app

- A **static binary** (Go, Rust) makes cold start equal the restore: **~3.5-5s**, the
  same as the bare storage demo. That is the scale-to-zero sweet spot, and it is why
  the headline demos are the Go-tier apps (cocoon, PrivateBin), not the Next.js apps.
- Heavy Node/Next.js apps still run correctly; they just pay their own 20-35s boot on
  every wake. They are compatibility proof, not showcases.
- **Sidecars are free.** A Redis sidecar (valkey or Dragonfly) boots in ~70-600ms in
  parallel with the restore and adds ~0 to the critical path (measured: nostream with
  Dragonfly 14.5s vs valkey 15.0s, a wash). Multi-container vs single-image packaging
  should be equal for the same reason (the A/B is a deferred experiment; not yet measured).

## Measurement method (the part that bit us)

- **Read Cloud Run boot logs, not client-side curl alone.** Public URL scanners re-warm
  services, silently defeating "it has been idle, so this curl is a cold start."
- A request resets the ~15-minute idle reaper, so clean cold repetitions need **~20-25
  minutes of true idle per rep**. Our first 4-round harness at 14-minute spacing produced
  mostly warm reps after round 1; the table above counts only verified-cold readings.
- cocoon cannot be cold-measured live at all: real AT Protocol network traffic keeps it
  warm. Which is its own finding: a service with any organic background traffic rarely
  cold-starts in practice.

## Related

- [`LIMITATIONS.md`](LIMITATIONS.md): everything else that constrains an app on zeropg.
- [`POSTGRES-APP-COMPAT.md`](POSTGRES-APP-COMPAT.md): per-app compatibility evidence.
- [`../BREAK-EVEN.md`](../BREAK-EVEN.md): when scale-to-zero stops being cheaper.
