# Storage backends: the atomic-primitive survey

zeropg's commit point needs exactly one thing from a storage backend: an
**atomic primitive** that lets exactly one writer win a race. Everything else
(get/put/list/delete) is universal. This doc surveys candidate backends by that
single criterion. Researched 2026-06-13; verify with a live probe before
trusting any "yes" (see the probe note at the bottom).

## The key reframe: CAS vs create-if-absent

Two strengths of atomic primitive, and which one we need depends on the
manifest design:

- **Full CAS** (`If-Match: <etag>` on update): needed by today's design, which
  mutates a single `manifest.json`.
- **Atomic create-if-absent** (`If-None-Match: *`, or O_EXCL, or a 409-on-exists
  create): enough IF we adopt **numbered immutable manifests**
  (`manifest/000…N.json`, highest number wins — Track A #2 in TODO.md, also
  wanted to dodge the GCS ~1-write/s-per-object cap).

Create-if-absent is far more widely available than full CAS. So numbered
manifests are not just a GCS throughput fix — they're what unlocks SFTP,
WebDAV, and Dropbox as backends. **Build numbered manifests before the exotic
backends.**

## S3-compatible providers

| Provider | Free tier | Create-if-absent | Full CAS | Verdict |
|---|---|---|---|---|
| **Cloudflare R2** | 10GB, $0 egress | yes | yes (since 2022) | **Winner** — free, zero egress |
| **IBM Cloud COS** | **25GB** + 200GB egress | likely (verify `*`) | **yes** (`If-Match`, confirmed in docs) | **Strong** — largest free tier with real CAS |
| **Tigris** | 5GB, $0 egress | yes | yes (PutObject) | **Strong** — verify CompleteMultipartUpload |
| **AWS S3** | credits (new accts) | yes (Aug 2024) | yes (Nov 2024) | Reference; egress charged |
| **Oracle OCI** | 20GB | **NO — silently overwrites** | **NO** | **DISQUALIFIED + DANGEROUS** |
| Backblaze B2 | 10GB | no (501) | no | Disqualified |
| Supabase Storage | 1GB | no (writes) | no | Disqualified |
| Wasabi / Storj / DO Spaces / Linode / Scaleway | varies | unconfirmed (Ceph-version-dependent) | unconfirmed | Probe before trusting |

**Oracle is the trap to remember:** its S3 layer's docs state unsupported
headers are *silently ignored*, so a conditional PUT returns 200 and overwrites
instead of 412. Passes single-writer tests, then loses data under concurrency.
Worse than a loud 501. Source: docs.oracle.com s3compatibleapi.htm.

**Ceph-based providers (Wasabi, DigitalOcean, Linode, Hetzner OS, Vultr,
Contabo)** are a coin-flip: conditional-write atomicity was only fixed in Ceph
Tentacle (v20.2.1, Apr 2026) and isn't in their compat tables, so support hinges
on the provider's undocumented Ceph version. Always probe.

## Non-S3 backends (unlocked by numbered manifests)

| Backend | Atomic primitive | Create-if-absent | Full CAS | API | Free tier | Verdict |
|---|---|---|---|---|---|---|
| **SFTP / Hetzner Storage Box** | `O_EXCL` exclusive create + atomic rename | **yes (kernel-enforced)** | emulate via lock+rename | OpenSSH, stable | ~€3.20/mo for 1TB | **Best non-S3** |
| **Dropbox** | `add`+`autorename:false` (409); `update(rev)`+`strict_conflict` | **yes** | **yes** (rev-based) | first-party, stable | 2GB | **Viable; great demo** |
| **Nextcloud (WebDAV)** | SabreDAV honors `If-Match`/`If-None-Match`→412 | yes | yes | WebDAV | host-dependent | Viable; probe each host |
| Generic WebDAV | LOCK / `If:` header / `If-None-Match` (spec only) | server-dependent | server-dependent | RFC 4918 | varies | nginx DAV ignores conditionals — probe |
| Google Drive | none (duplicate names allowed) | **no** | no | hostile/rate-limited | 15GB | Not viable |
| MEGA | none (duplicate names allowed) | **no** | no | semi-official, throttled | ~20GB | Not viable |
| pCloud | only `renameifexists` (silent) | no | no | yes | ~10GB | Not viable |
| Proton Drive | none (E2E; no server-side conditionals) | no | no | none (reverse-eng) | 2-5GB | Not viable |

**Why Drive/MEGA can't work:** both allow duplicate filenames in one folder, so
a "create" never collides — it silently makes a second object. There's no way to
express "fail if this exists," so no commit point. This disqualifies them
regardless of free space or API quality.

**SFTP is the cleanest primitive on the entire list:** `SSH2_FXF_EXCL` maps to
kernel `O_EXCL` in OpenSSH's sftp-server — the guarantee comes from the POSIX
filesystem, not an optional server feature. Pairs perfectly with numbered
manifests. Hetzner Storage Box (1TB for ~€3.20/mo over SFTP) becomes a
differentiated pitch: a real Postgres on commodity storage. Use SFTP, not the
Storage Box's WebDAV endpoint.

## Performance note for hobby workloads

Backend choice is about the atomic primitive, NOT speed. zeropg is cold-read /
rare-write at MB-to-low-hundreds-of-MB; cold start is dominated by snapshot
*download* (bandwidth), not per-op latency. An EU SFTP round-trip (tens of ms)
is in the same class as an S3 conditional PUT (~50-100ms). Every viable backend
above is fast enough; speed only decides at scales where you should be migrating
off zeropg anyway.

## Build order

1. **R2** (Track B) — free, zero egress, confirmed.
2. **IBM COS** — 25GB free + full CAS. **Confirmed and shipped (Track C, 2026-06-13):**
   the `If-None-Match: *` wildcard and `If-Match` CAS both pass against COS through
   the existing `R2BlobStore` (S3/SigV4) with zero new transport code, and the full
   demo runs on **IBM Code Engine + COS** at
   <https://zeropg-demo.2b2pxs7e2mxy.eu-de.codeengine.appdomain.cloud> — cold-restore
   byte-identical, CAS lease handoff intact ([results/ibm-coldstart.jsonl](../results/ibm-coldstart.jsonl),
   [scripts/deploy-ibm.sh](../scripts/deploy-ibm.sh)).
3. **Numbered manifests** (Track A #2) — unlocks create-if-absent-only backends;
   also fixes the GCS rate cap. Prerequisite for the next two.
4. **SFTP** — then Hetzner Storage Box (1TB/€3.20) is a real story.
5. **Dropbox** — the jaw-drop demo ("my database lives in my Dropbox"), easy API.

## Probe before trusting any backend

For any backend marked "yes" or "unconfirmed": PUT a key, then PUT again with the
conditional header and assert the rejection (412 / 409 / `O_EXCL` EEXIST). A
success response means the header was ignored — unsafe. Keep this as a per-backend
CI conformance test (R2 has shipped real conditional-write bugs; Ceph providers
vary by version; Oracle silently ignores).
