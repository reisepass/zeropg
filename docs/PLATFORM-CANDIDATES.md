# Platform candidates: Render and Fly.io (UNVERIFIED design notes)

Status: **RESEARCH ONLY - nothing on this page has been deployed or measured.**
This is the pre-work for extending the verified platform story (GCP Cloud Run,
AWS Fargate, IBM Code Engine - all measured in [BREAK-EVEN.md](../BREAK-EVEN.md))
to the platforms hobby developers actually name first. Numbers below are from
vendor docs/pricing pages as of 2026-07, not from our own runs. Anything here
graduates into BREAK-EVEN.md only after a real deployment + measurement pass.

## Why these two

The local-first pitch is: start on your laptop, deploy the same database to a
free/near-free scale-to-zero host, graduate to managed Postgres if the app takes
off. Cloud Run is the measured reference, but "where do hobby apps live" is
also: Render (the Heroku successor for many) and Fly.io. Both run plain Docker
images, and zeropg's deploy shape is a single stateless container + an
S3-compatible bucket, which is exactly the shape both platforms are good at.
The ephemeral-filesystem restriction that breaks most databases on these
platforms is irrelevant here: the bucket is the disk.

## Render free tier

What the vendor documents (unverified by us):

- Free web service: 512 MB RAM, 0.1 vCPU, Docker supported, single container
  (no sidecars on the free tier).
- Spins down after 15 min without inbound traffic; wake takes **about one
  minute** and shows a Render-branded loading page meanwhile.
- 750 free instance-hours per workspace per month - enough to keep ONE service
  effectively always-on (744 h/month), or several intermittent ones.
- Ephemeral filesystem (no persistent disk on free) - fine for zeropg.
- Outbound public internet allowed (needed: the bucket lives elsewhere),
  SMTP ports blocked.

### Fit assessment

- **The db-only shape fits.** One container from the existing zeropg-db image,
  bucket = R2/Tigris (free egress; Render has no object store) or GCS/S3.
  The full stripped-Supabase stack (db + PostgREST + GoTrue + ingress) is
  multi-container on Cloud Run; on Render free it would have to be squeezed
  into one image with a process supervisor, and 512 MB / 0.1 vCPU is likely
  too tight. Realistic free-tier scope: **zeropg-db alone**, app talks wire.
- **0.1 vCPU changes the cold-start math.** E3 measured restore as CPU+network
  bound at 1 vCPU; at a tenth of a core the restore term should be expected to
  inflate several-fold. But it barely matters, because:
- **Render's own ~60s wake dominates.** Cloud Run's container start is ~2s;
  Render free adds a ~1-minute platform wake before our restore even begins.
  The user experience is "Heroku free dyno" class, not the ~4s wakes we
  measured on Cloud Run. The pitch on Render is "your side project costs $0
  and keeps its data in a real Postgres", not "snappy scale-to-zero".
- **The 15-min idle window pairs well with sleep durability** (idle-flush
  backstop at 25s is well inside it), and the 750-hour cap is a non-issue for
  intermittent traffic.
- **Economics quirk:** Render has no pay-per-awake-second tier. Free tier is
  free; the first paid tier is a flat monthly instance that never sleeps. So
  zeropg-on-Render is a free-tier story only - graduation from Render free is
  directly to managed Postgres (or to a platform with real scale-to-zero
  billing), not to "Render paid".

### Open questions for the verification pass

1. Does a 10-50 MB DB restore + open inside 512 MB RAM at 0.1 vCPU, and in how
   long, end to end from the first HTTP request (including Render's wake)?
2. Does Render's wake proxy hold the first request until the container answers
   health checks, or does the client see the loading page + retry burden?
3. Lease behavior across Render's deploy-replace (their equivalent of the
   Cloud Run revision-switch E4 P3 scenario).
4. Does the 750-hour meter make a stuck-awake bug expensive in service
   suspension rather than dollars (suspension = hard downtime at month end)?

## Fly.io

What the vendor documents (unverified by us):

- No permanent free tier since 2024 (new accounts: small trial credits).
- True scale-to-zero: `auto_stop_machines` + `auto_start_machines` +
  `min_machines_running = 0`; stopped machines bill **zero** for CPU/RAM.
- Wake on request is fast (sub-second to a few seconds; the proxy holds the
  request while the machine boots).
- Smallest always-on machine (shared-cpu-1x, 256 MB) ≈ $1.94/month; zeropg
  needs a bigger tier for tmpfs+RSS, but only while awake.

### Fit assessment

- **Fly is the closest non-GCP match to the measured Cloud Run economics**:
  per-second billing, genuine zero-when-idle, request-driven wake with no extra
  orchestration (unlike Fargate's waker glue). Not free, but for intermittent
  traffic the monthly bill should be cents-to-a-dollar, plus bucket storage.
- Fly volumes are NOT needed (they bill even when stopped; the bucket replaces
  them) - skip volumes entirely.
- No object store on Fly; R2 is the natural pairing (same "edge" positioning,
  free egress).
- The 5-minute default idle-stop is shorter than Cloud Run's typical
  scale-to-zero window; more cold starts for the same traffic, which raises
  the value of the measured restore times.

### Open questions for the verification pass

1. Real wake-to-first-query latency for a 10 MB and 50 MB DB (their proxy
   holds the request, so this could genuinely rival Cloud Run).
2. SIGKILL semantics of `auto_stop` (signal, grace period) vs our idle-flush
   backstop and lease TTL.
3. Whether Fly's machine migration/host maintenance creates a second-writer
   window (E4 P4 class) that the fencing already covers.

## Bottom line (to be validated)

| platform | idle cost | wake experience | who it serves |
|---|---|---|---|
| Cloud Run (measured) | $0 + bucket cents | ~4s at 10 MB | the reference: fast wakes, per-100ms billing |
| Render free (unverified) | $0 flat | ~60s platform wake + slow restore | the "my side project must cost literally zero" crowd |
| Fly.io (unverified) | ~$0 compute + bucket | expected seconds-class | cheap true scale-to-zero outside Google's cloud |

The graduation story is identical on all three: `pg_dump` out, restore into
managed Postgres, change one connection string ([GRADUATION.md](GRADUATION.md)).

Sources consulted (2026-07-03): render.com/docs/free, render.com pricing and
free-tier blog posts, fly.io/docs/launch/autostop-autostart, fly.io pricing
docs, plus third-party pricing roundups for cross-checking the free-tier
removal timeline. Vendor pages are the authority; third-party numbers were
only used where vendor pages agreed.
