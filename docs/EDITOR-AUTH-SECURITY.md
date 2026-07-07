# Editor access security: how the one-click pgweb / Adminer links are protected

Two surfaces give "immediately logged in" database access. They have different
trust models and it matters not to confuse them:

| surface | where | auth mechanism | what a compromise exposes |
|---|---|---|---|
| `zeropg console` + pgweb | your laptop, loopback only | **none - the machine boundary IS the auth** | read-WRITE access to local datadirs, read to remote snapshots |
| `zeropg console --inspector` + Adminer/pgweb | public Cloud Run URL (service `zeropg-inspector`) | **one shared bearer token** (Secret Manager) | read access to snapshots of every fleet DB (incl. auth.users emails); writes are throwaway |

Since the 2026-07-07 unification both surfaces are ONE codebase
(`packages/cli/src/console/`) with the auth as pluggable middleware
(`auth.ts`: `none` for loopback, `bearer` for the cloud). The trust asymmetry
is enforced structurally: the inspector mode module never imports the
write/wake/export/serve-local machinery, so those routes do not exist on the
wide-bound surface.

zeropg itself has **no built-in auth anywhere** - the wire accepts any
username/password. Every security property therefore comes from *network
placement* (what can reach a wire) and *gates in front of it* (the token).
Keep that sentence in mind for everything below.

## Surface 1: local console + pgweb (no token, loopback trust)

```
your machine ──────────────────────────────────────────────────────────────┐
│                                                                          │
│  browser ──► zeropg console :4900 (binds 127.0.0.1, refuses to widen)    │
│                │  "open in pgweb" button                                 │
│                ▼                                                         │
│         spawns pgweb :OS-port (binds 127.0.0.1)                          │
│                │  --url postgres://postgres@127.0.0.1:WIRE/postgres      │
│                ▼                                                         │
│         wire :OS-port (serveWire / ZeroPGReplica, binds 127.0.0.1)       │
│                │                                                         │
│                ▼                                                         │
│         local datadir (REAL db, read-write)  or  bucket snapshot (copy)  │
└──────────────────────────────────────────────────────────────────────────┘
     nothing in this chain authenticates anything. The security claim is
     exactly: "only processes on this machine can reach any of these ports."
```

Properties and their limits:

- **Anyone/anything on the machine has full access.** Any local process (or any
  other user on a shared box) can connect to the wire and the pgweb HTTP port.
  There is no secret to steal because there is no secret. Acceptable for a
  single-user dev laptop; wrong for a shared host.
- **Remote snapshot access rides your gcloud ADC.** The console can only open
  replicas of buckets your Google credentials can read - GCS IAM is the real
  gate for remote data, and it is per-human, auditable, revocable. This is the
  strongest link in the whole story.
- **Known deviation to fix:** the *studio up-local test harness* (not the
  console) binds its wire on `0.0.0.0` when running postgres-meta in Docker -
  while that stack is up, the wire is reachable from your LAN with no auth.
  The console itself never does this (pgweb path is pure loopback), and the
  Docker-editor recipes in the survey docs inherit the same caveat. Tracked
  fix: bind mode should be an explicit, loudly-labeled opt-in.

## Surface 2: cloud inspector + Adminer (single bearer token)

```
                 INTERNET (anyone can reach the URL - allUsers invoker)
                      │
   link: https://zeropg-inspector-.../?t=<TOKEN-from-Secret-Manager>
                      │
┌── Cloud Run service zeropg-inspector (one instance, scale-to-zero) ────────────┐
│                     ▼                                                          │
│   zeropg console --inspector :8080                                             │
│   ┌──────────────────────────────────────────────────────────────┐             │
│   │ GATE: every request must present the token                   │             │
│   │   1st hop:  ?t=<token>  → verified → 302 that                │             │
│   │             - sets cookie zpt=<token> (HttpOnly, Secure,     │             │
│   │               SameSite=Lax, Path=/)                          │             │
│   │             - strips the token from the URL                  │             │
│   │   later:    cookie zpt must equal the token, else 403        │             │
│   └──────────────────────────────────────────────────────────────┘             │
│         │ /open/<name>                       │ /db/* (reverse proxy)           │
│         ▼                                    ▼                                 │
│   ZeroPGReplica(bucket, prefix)        adminer sidecar :8081 (loopback only,   │
│   → loopback wire :6001+  ◄────────────  never exposed; connects to the wire)  │
│   (detached SNAPSHOT: no lease,        second, independent check: Adminer's    │
│    no fencing, writes discarded         login() requires the SAME token from   │
│    when the replica closes)             the zpt cookie before any connection   │
│                                                                                │
│   service account: blob-pglite-dev (bucket read via GCS IAM, run.viewer for    │
│   live fleet discovery, secretAccessor on inspector-token only - the old       │
│   inspector-targets secret is gone; targets are discovered live)               │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Token lifecycle

```
openssl rand -hex 24 (192 bits)                      rotation:
   │ deploy.sh, created once                            gcloud secrets versions add inspector-token
   ▼                                                    + re-roll the service
Secret Manager: inspector-token ──► env INSPECTOR_TOKEN (ingress gate)
                                └─► env ZEROPG_LINK_TOKEN (Adminer login())
   │
   ▼
the link ?t=<token>  ──first request──►  zpt cookie (browser)  ──►  every later request
        (credential! anyone holding the link has everything the token grants)
```

### What actually holds, and what does not

Holds:

- **Guessing is infeasible.** 192-bit random token; a 403 costs the attacker a
  request. No rate limiting exists, but brute force against 2^192 is not a
  threat model.
- **Two independent checks.** The ingress gates every path AND Adminer's
  `login()` re-verifies the same token from the cookie - a proxy-bypass bug in
  the ingress would still land on Adminer refusing without the cookie.
- **The token leaves the URL immediately** (302 → cookie), so it does not sit
  in the address bar, does not leak via Referer from later pages, and the
  cookie is HttpOnly (no JS exfiltration) + Secure (no cleartext) +
  SameSite=Lax (cross-site POSTs never carry it; Adminer's own per-session
  CSRF token also guards its forms).
- **Write blast radius is zero by construction.** Everything served is a
  detached `ZeroPGReplica`; there is no path from the inspector to a live
  writer, a lease, or a fence. Worst case with a stolen token is READ.
- **The DB-credentials problem is dissolved, not solved.** The Postgres
  "password" never exists as a secret: the wire doesn't verify one, and what
  Adminer submits is supplied server-side. There is nothing DB-shaped to leak.

Does not hold (the "mega insecure" part, stated plainly):

1. **One shared bearer token, no identity.** Everyone with the link is the
   same principal. No per-person revocation (rotation kicks everyone), no
   audit trail of WHO opened what - Cloud Run request logs show IPs at best.
2. **The link IS the credential, and links travel.** Chat logs, browser
   history sync, screen shares - the places URLs leak. First-hop-only exposure
   (it becomes a cookie immediately) narrows this, but the link you saved to
   open it stays a skeleton key until rotation.
3. **No expiry.** The token lives until manually rotated. There is no session
   timeout either - the cookie is a session cookie, but the token behind it
   never ages out.
4. **Real personal data behind one factor.** Snapshots include live demo
   signups (auth.users emails). One leaked string exposes them all. The
   nightly demo reset caps the window at 24h of signups; the exposure is
   nonzero regardless.
5. **allUsers invoker.** The service is publicly reachable, so the token is
   the ONLY layer. The IAM-hardened alternative (below) was deliberately
   traded away for clickable links.

### If the token leaks

```
gcloud secrets versions add inspector-token --data-file=<(openssl rand -hex 24 | tr -d '\n')
bash examples/cloudrun/inspector/deploy.sh    # re-rolls; old links die instantly
```

Nothing else to clean up: no DB passwords existed, snapshots are disposable,
and the bucket was never writable through this path.

### Hardening ladder (when demo-tier stops being acceptable)

1. **Remove allUsers, require Google identity** (`--no-allow-unauthenticated`,
   access via IAP or `gcloud run services proxy`): per-human identity, audit
   logs, instant per-person revocation. Cost: links stop being one-click for
   non-Google users.
2. **Per-link expiring tokens**: sign `{target, exp}` with HMAC instead of one
   static token - links become target-scoped and time-boxed (the fleet CLI
   would mint them). The auth middleware (`console/auth.ts`) is shaped for
   this as a third mode; the natural next step.
3. **Redaction at the replica**: strip `auth.users` PII columns into a view on
   open, if inspectors are ever shared beyond the operator.

## Meta

The asymmetry is intentional: the **local** surface holds the powerful thing
(read-write to real datadirs) behind the strongest boundary available (your
machine + your GCS IAM), while the **cloud** surface holds only disposable
copies behind the weakest acceptable one (a bearer link). If you ever catch a
design proposal inverting that - write access behind a shared link - that is
the line not to cross.
