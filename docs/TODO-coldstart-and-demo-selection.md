# TODO: cold-start measurement + picking the headline demos

Strategy (agreed): we have many apps running on zeropg. We don't need every one to
be a flagship. **Measure cold start across all of them, then promote the ones that
are both *nice* and *boot fast* to be the main/featured demos; demote or drop the
slow ones.** Cold start is the selection criterion, because the whole pitch is
"scale to zero and wake fast."

NOTE: cold start = the app's **own** boot weight + zeropg's ~5 s restore constant +
~0 for the Redis sidecar. It's an **app property**, not a zeropg ranking. Don't pit
unrelated apps against each other (a Nostr relay vs a PDS is meaningless) - just
check each is snappy *enough for its own use case*. The only apples-to-apples
comparisons are same-app part-swaps (e.g. Dragonfly vs valkey) and zeropg's own
restore overhead.

## Known cold-start numbers so far (boot -> serving, forced fresh instance)

| demo | cold start | notes |
|---|---|---|
| zeropg storage demo (10 MB) | 3.8 / 4.7 s (p50/p99) | restore-bound; the floor for a tiny DB |
| zeropg storage demo (50 MB) | 3.5 / 4.3 s | |
| cocoon PDS | ~5.0 s | **fastest real app**; Go binary + ~5 MB DB |
| PrivateBin | ~7 s | PHP-FPM + tiny schema |
| zeropg storage demo (500 MB) | 11.2 / 12.3 s | restore scales with DB size |
| NocoDB | ~28 s | heavy Node boot; **slow - secondary at best** |
| Rallly | TBD - measure | heavy Next.js |
| Documenso | TBD - measure | heavy Next.js (Remix) |
| Cal.com | TBD - measure | heaviest Next.js monorepo; likely slowest |
| nostream + zeropg + Dragonfly | **~14.5 s** (valkey ~15.0 s - a wash) | mostly nostream's own heavy Node boot; the zeropg part is the same ~5 s restore as everywhere |
| webhookx + zeropg + Dragonfly | ~4-5 s (fast restore) to ~35-40 s (slow restore) | Go app boots fast; variance is the GCS/PGlite restore. KEEP - first needs-Redis app proven |

### nostream + Dragonfly - measured findings (Agent A, live Cloud Run)
- **Cold start ~14.5 s** (clean autoscaling wake, boot→HTTP 200). valkey baseline ~15.0 s → **Dragonfly vs valkey is a wash** (redis ready 0.64 s vs 0.44 s; the ~5 s GCS restore + heavy nostream Node boot dominate).
- Confirms the parallel-boot reasoning **on real Cloud Run**, not just local: the Redis sidecar adds ~0 to the critical path.
- **But for ephemeral cache, valkey:8-alpine is the more minimal pick** - 17.5 MB vs Dragonfly 53.6 MB image, runs at 128mb/256Mi with zero tuning. Dragonfly needs a **256 MiB/thread memory floor**, explicit `--bind=0.0.0.0` (else the Cloud Run TCP probe fails), and lives on `ghcr.io` not Docker Hub.
- → **Dragonfly's real value is the DURABLE Redis case (persistence/throughput), not ephemeral cache.** That's exactly what the webhookx demo tests next.

Provisional headline set (fast + nice): **cocoon PDS (~5s), PrivateBin (~7s), the
small storage demos (~4s).** Heavy Next.js apps (Cal.com/Documenso/Rallly) and
NocoDB (~28s) are "it also runs" proof, not the front-page wow.

Action: get real forced-cold numbers for Rallly/Documenso/Cal.com (we have the live
URLs), fill the table, then curate the README's featured list by speed.

## Measured cold starts (repeated harness, 2026-06-24) — raw in `results/coldstart-apps.jsonl`

Client-perceived cold start (curl time to first response on a scaled-to-zero instance),
4 rounds, calcom dropped. **Method caveat:** 14-min round spacing turned out to be right at
Cloud Run's scale-to-zero boundary, so after round 1 warmed the instances, later rounds often
hit them still-warm (<2 s). So valid cold reps per app = 1–2, not 4. (To get clean 3–4 reps,
re-run with ~20–25 min spacing or a no-traffic-tag force-cold.)

| demo | valid cold reps | reading(s) | verdict |
|---|---|---|---|
| **PrivateBin** | 2 | ~5.0, ~5.2 s | **fast, consistent — headline** |
| **cocoon (PDS)** | 0 measurable (warm even after 20min idle) | 0.2–0.44 s always | **can't cold-measure live** — public PDS gets background AT-Proto traffic that keeps it warm; prior deploy-log ~5 s stands; real-world it rarely cold-starts |
| **Rallly** | 2 | 21.2 s, 35.6 s | slow + **high variance** (21→36 s) |
| **NocoDB** | 2 | 34.0, 34.1 s | slow but consistent (~34 s) |
| **Documenso** | 2 | **112 s (outlier), 29.9 s (clean)** | ~30 s real; **112 s was a one-off, NOT calcom-tier — KEEP as slow secondary** |

Takeaways: PrivateBin (~5 s) is the clean fast headline. cocoon ~5 s (deploy-log) stands but can't be
re-measured live (stays warm from real network traffic — itself a nice "it rarely even cold-starts"
story). Rallly ~21–36 s, NocoDB ~34 s, Documenso ~30 s are the "it runs" slow-secondary tier. Only
**calcom (>120 s) was bad enough to drop**; documenso's scary 112 s was an outlier (clean rep ~30 s).
NOTE: hitting a service resets its ~15-min idle timer, so clean cold reps need ~20 min of true idle
per app — that's why the 4-round/14-min harness produced mostly warm reps after round 1.

## Deferred experiment: single image vs multi-container sidecars (cold-start A/B)

Question raised: is the multi-container sidecar model (app + zeropg-db + Dragonfly,
all co-located in ONE Cloud Run instance, talking over localhost) as fast to
cold-start as baking everything into ONE image (app + zeropg + Dragonfly under
s6-overlay / supervisord)?

Reasoning so far (NOT yet measured):
- Both scale to zero as one unit; both talk over localhost loopback (the socket
  doesn't disappear in a single image - Postgres/Redis are still separate processes).
- The dominant cost is **instance floor (~1-2s) + GCS restore -> DB ready -> app
  boots**, which is identical either way (the app waits for the PGlite restore
  regardless of process boundary).
- So they *should* be ~equal. The one real difference is **resources, not speed**:
  multi-container reserves the SUM of each container's CPU/mem limit (a bigger,
  pricier warm instance), while a single image shares one pool.

The experiment (do later, low priority): take ONE app (e.g. nostream), build it
**both** ways, force-cold-start each ~10x, compare boot-to-serving and the
provisioned instance size/cost. Only this turns "should be ~equal" into a fact.

Bare-Dragonfly baseline (measured locally, ghcr.io/dragonflydb/dragonfly): image
~48 MiB, boot-to-PONG ~70-80 ms (3 runs), serves SET/GET. So Dragonfly itself adds
~0 to the critical path when it boots in parallel; the open question above is only
about the container-vs-process packaging, not Dragonfly.

## Related
- `docs/POSTGRES-APP-COMPAT.md` - per-app compatibility + the prepared-statement wall.
- The scale-to-zero Redis / `zerovalkey` idea (Dragonfly --dir s3://, or Valkey +
  our objectstore-fs) is tracked separately; Dragonfly-as-sidecar demos are the
  near-term proof.
