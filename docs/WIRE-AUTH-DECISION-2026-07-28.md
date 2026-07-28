# zeropg wire, auth, and default-safety: one decision document

**Status:** synthesis of four research tracks (prior art, PGlite/pglite-socket internals, Neon, Supabase, wire-protocol libraries) and three adversarial critiques (protocol engineer, security reviewer, naive-agent simulation). Written 2026-07-28 for discussion, not for execution. Three sub-designs contradicted each other on the two central questions; those contradictions are resolved below with reasoning, and the ones I could not resolve are in §9.

---

## 1. THE DECISION

We collapse to **one credential per instance** (the Postgres role password), stored as a **SCRAM verifier only** - never cleartext, never a derived token computable from the verifier - and we make every powerful face refuse anonymous access when a credential is present, in every version, starting 0.1.1. We **vendor pg-gateway's `next` source** for the wire handshake rather than depending on it or writing SCRAM from scratch, but we **demote the wire replacement from the headline milestone to a 0.2.0 track at 6-10 weeks**, because the flagship platform (Cloud Run) cannot accept raw TCP at all and the naive agent lives entirely on HTTP. The single highest-leverage thing in this entire plan turns out not to be TLS or SCRAM: it is a **`pg`-compatible driver shim over POST /sql** plus **bound parameters on /sql**, which is what makes `new Pool({connectionString})` and Drizzle and Prisma work against a deployed instance at all. TLS on the wire is built last, is never mandatory, and its private key never goes in the bucket.

---

## 2. VERIFIED GROUND TRUTH

Everything here was established by running code or reading source, not by inference.

### The gating question is SETTLED, in our favour

**We can own authentication entirely. There is no double-authentication problem, because there is no authentication below us.** A freshly created PGlite answers `Query "select 1"` with `T D C(SELECT 1) Z(I)` having *never received a startup packet* (probe `scratchpad/probe/a-gating.mjs`, section A1). PGlite emits `AuthenticationOk` only from `#processStartupPacket`, reached only when `message[0] === 0` (pglite `src/pglite.ts:896` dispatching to `:1308`, which calls the real C `ProcessStartupPacket(port, ssl_done=true, gss_done=true)`). Two startup packets with different `user` and different `database` produce **byte-identical 429-byte responses**. PGlite is a single-user backend that is already logged in. This was independently confirmed by the protocol critic, who conceded it explicitly. **Do not budget an experiment for this.**

### The wire is a remote-kill surface today

- Forwarding `SSLRequest` to `execProtocolRaw` throws `ExitStatus: exit(1)` and **permanently corrupts the WASM instance**: the next startup packet throws `RuntimeError: null function or function signature mismatch` and the response stream desynchronizes.
- A `PasswordMessage` ('p') or any unconsumed message type causes an **infinite synchronous spin** in `_PostgresMainLoopOnce` that blocks the entire Node event loop. A 20s `setTimeout` never fired; the process had to be killed. Remote, unauthenticated, one packet.
- The only reason we survive today is that pglite-socket's framer *mis-sizes* those packets and buffers forever instead of forwarding. It reads exactly one protocol field (`readInt32BE(4) === 196608`) and forwards everything else as opaque bytes.

### Three plan deliverables are refuted by probes

1. **`COPY ... FROM STDIN` cannot be intercepted on the return path.** `execProtocolRaw(Query("COPY c FROM STDIN"))` does not emit `CopyInResponse` - it **throws `ExitStatus: exit(1)`**, and every later call including a bare `select 1` returns nothing and hangs forever (`probe/b2.log`). `CopyFail` afterwards also hangs. `COPY ... TO STDOUT` is genuinely harmless (`H d d c C(COPY 2) Z(I)`). This fires on stock `pg_restore`, whose default dump format is COPY.
2. **Advisory locks provide no mutual exclusion.** `pg_try_advisory_lock(4242)` returned `t` from three separate logical connections with `pg_locks` showing **one** entry (`probe/c2.log`). `sqlx migrate`, golang-migrate, Prisma (lock 72707369) and Flyway all serialize migrations with this primitive. Prepared-statement namespacing therefore does **not** unblock sqlx/Diesel end to end; it only removes the 42P05 wall.
3. **Sync-boundary batching deadlocks cursors.** PGlite answers `Execute(maxRows=50) + Flush` with 50 DataRows + `PortalSuspended` and no Sync (`probe/d1.log`). pgjdbc `setFetchSize`, node-postgres `pg-cursor` and psycopg named cursors all depend on that. Buffer until Sync and they hang forever.

### Two whole failure categories were missing from every design

- **`LISTEN`/`NOTIFY` is delivered to the wrong connection.** A `NOTIFY` from connection B returned `C(NOTIFY) A Z(I)` **in B's own stream**; the listener A got nothing (`probe/c1.log`). `packages/server/src/postgrest.ts` sets no `PGRST_DB_CHANNEL_ENABLED`, so PostgREST defaults it true, holds a second connection, and its documented schema-reload `NOTIFY pgrst` is silently dead.
- **`ParameterStatus` goes stale across connections.** `SET TimeZone='UTC'` emits `C(SET)` plus **six** ParameterStatus messages, to the setter only. M2's "harvest the handshake at boot and replay it" design would lock every later connection to boot-time values permanently - silent timestamp-decoding corruption.
- Bonus: `SET client_encoding='LATIN1'` returns `C(SET) Z(I)` with **no** ParameterStatus (itself a protocol violation) and then the next `select 3` returns **0 bytes** forever (`probe/a2.log`). This is a legal `Q` message, so a message-type whitelist gives zero protection.

### The current shipped default is genuinely open

`packages/server/src/server.ts:252` calls `this.http.listen(port)` with no host, binding `0.0.0.0`; `scripts/deploy.sh:55` passes `--allow-unauthenticated`. Routes `/sql /flush /wake /metrics /rest` have no auth branch (`server.ts:282-326`). `ZeroPGServerOptions` (`server.ts:35-68`) has zero auth fields. `maxConnections` is hardcoded 10 (`server.ts:166`) and PostgREST is default-ON (`server.ts:114`) consuming 1-2 of those slots. `packages/client/src/remote.ts:20-24` throws on any parameterized query.

### The fail-closed bind check is bypassable as originally written

`server.ts:112` uses `opts.wireHost ?? process.env.ZEROPG_WIRE_HOST ?? '127.0.0.1'`. `??` only falls back on null/undefined, so `ZEROPG_WIRE_HOST=""` survives as an empty string, and Node's `listen(port, '')` binds `::` (all interfaces). `listen(port, '0')` binds `0.0.0.0`. A rule keyed on the literal string `"0.0.0.0"` catches neither, nor `::`, nor a LAN IP.

### pg-gateway is real but is not what the plan said it was

MIT, `supabase-community/pg-gateway`, 260 stars. SCRAM-SHA-256 exists only on the unmerged `next` branch (PR #21, open since 2024-09-13, 139 commits), published once as `0.3.0-beta.4` on 2024-12-23 and untouched for 19 months. firebase-tools 15.24.0 depends on it, driving ~7.2M downloads/month. Verified live against psql 18.4 with TLS + SCRAM: `sslmode=require`, `verify-full` with a pinned CA both work. Also verified: a client that rejects the server cert raises `ERR_INVALID_STATE: WritableStream is locked` at `connection.ts:228` and **kills the entire Node process**, escaping a try/catch because it is thrown from an unawaited continuation. The npm tarball ships **no src** (`files: ["dist/**/*"]`), and the shipped `dist/chunk-PGRRI4HM.js` is **212 KB inlining a base64 Rust wasm-bindgen `@std/crypto` module** (rustc 1.77.2, wasm-bindgen 0.2.92). The "2468 LOC, zero runtime dependencies" figure is true of package.json and false of the artifact. Absent from the bundle: `NegotiateProtocolVersion`, `saslprep`, `SCRAM-SHA-256-PLUS`, ALPN, any BackendKeyData emitter.

### The transaction-affinity queue is load-bearing and the naive replacement is broken

Two clients each doing `BEGIN; SET LOCAL myapp.uid='X'; pg_sleep; SELECT current_setting; COMMIT`. Under pglite-socket: `AAA saw AAA | BBB saw BBB`. Under `pg-gateway + db.runExclusive(execProtocolRaw)`: `AAA saw AAA | BBB saw <empty>` - A's COMMIT terminated B's transaction and discarded B's SET LOCAL. The affinity is **stall-based**: at `node_modules/@electric-sql/pglite-socket/src/index.ts:78-92`, when a transaction is open and the holder has nothing queued, it sets `query = null` and breaks the loop, serving nobody. That stall *is* the isolation property. A "cleaner" rewrite that serves the next queued item reintroduces claim bleed silently.

### Neon and Supabase, on the two questions we care about

- **Neon requires TLS** and ships `?sslmode=require` inside every string it hands out. Its HTTP `/sql` is fully parameterized (`{query, params}` → `query_raw_txt`, text-format binding, no client type OIDs) and carries the **same role password** in a `Neon-Connection-String` header. One credential, two faces, at scale.
- **Supabase does not require TLS**, explicitly "to maximize client compatibility" (`host all all 0.0.0.0/0 scram-sha-256`, not `hostssl`), and ships connection strings with no `sslmode` at all. Their API keys are a *different* layer that becomes a `SET LOCAL ROLE`, never a Postgres password.
- Decisive empirical result: against a TLS-**required** pg-gateway, `new pg.Client({connectionString})` with no ssl option **fails with 08P01**, because node-postgres defaults `ssl:false` and sends the StartupMessage with no SSLRequest. Neon only survives this because it controls every connection string. We do not.

---

## 3. UNSETTLED - the experiments that must run before committing

The gating question is **not** on this list; it is settled (§2). These are.

| # | Question | Experiment | Blocks |
|---|---|---|---|
| U1 | Does the vendored SCRAM interoperate with anything other than libpq and node-postgres? It omits SASLprep (RFC 4013) and does not validate the gs2 header against the `c=` value it echoes into the authMessage. pgjdbc is strict about the server-final signature. | Stand up the vendored server with a fixed verifier; connect from psql 18.4, node-postgres, pgx v5, pgjdbc, sqlx, Diesel, Prisma's native Rust engine. Include one non-ASCII password to prove SASLprep is needed. Checked into CI as a matrix that fails the build. | The whole SCRAM milestone. Budget **1 week before a single assertion runs** just to stand the harnesses up. |
| U2 | Flush vs Sync: where does the exclusive window close? | Drive pgjdbc with `setFetchSize(50)` and node-postgres `Cursor` against a prototype that closes at Sync only, then at Flush-or-Sync. Assert rows arrive and that a second connection cannot interleave on the unnamed portal during an un-synced pipeline. | The queue port. Get this wrong and either cursors hang or RLS bleeds. |
| U3 | Is the ExitStatus WASM corruption recoverable, or must the instance be torn down? I observed exit(1), then a *working* `SELECT`, then a hard RuntimeError on the next startup packet. The damage is latent and state-dependent. | Deliberately forward an SSLRequest and a `COPY FROM STDIN` to a throwaway PGlite; after each, run 100 mixed statements and assert either full recovery or deterministic failure. | Whether the supervisor is "restart the process" or "quarantine the connection". |
| U4 | Which frontend message types are safe to forward? Confirmed hanging: `p`, `q`. Confirmed safe: `H`. The rest is unenumerated, and anything not on the list is a remote process kill. | Message-by-message: send each of `Q P B D E C H S F X d c f` plus a sample of invalid bytes to a fresh PGlite with a hard external timeout, one instance per message. | Shipping any framer. |
| U5 | Does a `pg`-compatible shim over POST /sql actually satisfy Drizzle and Prisma's driver-adapter contracts? Neon does this, so it is plausible, but our /sql returns different metadata. | Build the shim against the M1 /sql body; run `drizzle-orm` `select`/`insert`/`transaction` and `@prisma/client` with the adapter against a live deployed instance. | The single most valuable milestone (§8, M1c). |
| U6 | Is the SQL guard (COPY, `client_encoding`) complete enough to matter? It cannot catch `COPY` as the 3rd statement of a multi-statement `Q`, inside `DO $$ ... $$`, or via `EXECUTE` of dynamic SQL. | Adversarial corpus of ~30 wrappings; measure catch rate. Decide whether the supervisor (U3) is the real fix and the guard is only a nicety. | How much we invest in sniffing. |
| U7 | Does peer-based loopback trust hold on Cloud Run? The predicate assumes ingress never arrives from 127.0.0.1 and always sets X-Forwarded-For. Knative's queue-proxy forwards over localhost. | Deploy a probe service that logs `remoteAddress` and all forwarding headers for an external request. | Whether Rule 2 is even *safe as defense in depth*. I recommend rejecting it regardless (§5). |

---

## 4. BUILD VS ADOPT

**Call: vendor pg-gateway's `next` branch source into `packages/wire`, strip `@std/crypto` and re-point at `node:crypto` in the same commit, record the exact upstream git SHA in VENDOR.md, and write our own session layer on top.**

Reasoning:

- **Adopting as a dependency is disqualified.** `psql sslmode=verify-full` with a mismatched CA - one packet, unauthenticated - kills the entire Node process via `ERR_INVALID_STATE` at `connection.ts:228`, and it escapes a try/catch. On zeropg that is one packet to kill the database container. It is unfixable from outside the library, and the library is a beta from a branch unmerged for 19 months with no realistic prospect of a stable release. We must own the source either way.
- **Writing SCRAM from scratch is disqualified on economics.** 300-450 lines with subtle failure modes (SASLprep, gs2 validation, server-final signature) that pgjdbc is strict about. pg-gateway's version is exercised by firebase-tools at ~7M downloads/month, which is more real-world client coverage than we could buy. We author roughly half the total regardless - the framer, the session layer, the queue are ours no matter what - so this is a decision about the handshake half only.
- **Forking pglite-socket is disqualified.** It has literally zero protocol knowledge. Adding TLS and SCRAM to it means writing exactly the code pg-gateway already has, into a codebase that would then also need a message parser. Its 0.2.7 still carries `(a===196608||a===196608)` in its startup version check. The only thing worth taking from it is the transaction-affinity queue, which we port as source, **literally, stall behaviour and all**, with a comment stating that `query = null; break` is load-bearing.

**Corrections to the vendoring plan the critics forced:**
- Budget a **supply-chain audit**. The npm tarball ships no src, so "vendor the source" means cloning an unmerged GitHub branch with no provenance and no signed release, and the shipped artifact inlines a prebuilt Rust WASM crypto module compiled by an April-2024 toolchain. Ripping out `@std/crypto` for `node:crypto` is ~60 LOC and removes ~200 KB and the entire WASM blob. Do it in the vendoring commit, not later.
- Add **ALPN / direct TLS** to the patch list. PG17+ `sslnegotiation=direct` sends a TLS ClientHello (first byte `0x16`) as the very first bytes with ALPN id `postgresql` and never sends SSLRequest. pg-gateway has no ALPN and its framer would treat `0x16` as a message type. That is a **hang**, not an error - the exact class we exist to eliminate. ~10 LOC given the TLS path exists.

**The losing option's merits, stated fairly:** taking pglite-socket 0.2.7 as-is is cheap, immediate, and buys the single biggest DX win in the pack - it answers SSLRequest with `N`, so libpq's default `sslmode=prefer` stops hanging. That is the actual north-star failure. It also swallows CancelRequest. **We should take it in 0.1.1 regardless of the vendoring decision**, and it is the reason the vendored wire can wait for 0.2.0.

---

## 5. THE CREDENTIAL MODEL

**Verdict: one credential per instance. The HTTP bearer token dies as a separate concept. The derived-HMAC form dies outright.**

### The blocking contradiction, and how it resolves

The credential design said "store the SCRAM verifier, never the password" and then, in the same document, said HTTP would additionally accept `base64url(HMAC(ServerKey, "zeropg-http-v1"))`. **ServerKey is a component of the stored verifier.** Anyone with bucket read computes that token and gets arbitrary superuser SQL over HTTPS. The mitigation and the feature cancel out exactly. The default-safety design contradicted it outright and stored a cleartext 192-bit root secret at `<prefix>/_auth/root-secret` - which is mathematically *required* if you want a derived HTTP token, and which is straightforwardly a fleet-wide cleartext password store.

The security reviewer is right and this is not close. **Kill the derived token.** HTTP Basic verified against the stored SCRAM verifier needs no derivation and works today: given cleartext from the Basic header, recompute SaltedPassword → ClientKey → H(ClientKey) and constant-time compare against StoredKey. That is genuinely one secret, and the bucket then holds nothing from which either live credential can be forged.

Cost accepted: HTTP Basic sends the password on every request, inside TLS, where SCRAM never does. This is precisely Neon's posture (`Neon-Connection-String` header carries the role password). Mitigate by rejecting credentials that arrive with `X-Forwarded-Proto: http`, and by a redaction pass in the log helper.

### The bucket is not a safe credential store in *our* topology

"Bucket read already gives you the DB" is false here. `scripts/deploy.sh:64` puts every service in one bucket under per-service prefixes with one shared SA, and GCS uniform bucket-level access has no per-prefix IAM. The inspector holds fleet-wide bucket read **by construction** (`packages/cli/src/console/replica-wire.mjs` opens arbitrary `{bucket,prefix}`), binds `0.0.0.0` behind one static non-expiring token, and has already shipped a host-controlling SSRF (commit `c3120ff`). Under a cleartext-in-bucket design that incident escalates from "leaks read-only snapshots" to "live write credential for every database in the fleet" - literally the line `docs/EDITOR-AUTH-SECURITY.md:182-189` says not to cross.

Resolution:
- **Plaintext is generated in the CLI at deploy time**, where an operator is present, printed once, and pushed to Secret Manager via `--set-secrets`. It is never generated at boot and never printed by the server.
- **The bucket holds the verifier only.** A verifier in a shared bucket permits server impersonation (ServerKey signs server-final) and offline cracking; against a 192-bit generated password the latter is dead and the former needs an active MITM. Acceptable. Cleartext is not.
- **`auth.claim.json` is killed.** "Single-read" is not implementable on GCS (no atomic read-and-delete), soft delete retains it 7 days by default, and for the whole window it sits in the bucket every sibling SA can read.
- `deploy.sh` moves from `--set-env-vars` to `--set-secrets` for the credential. Cloud Run env vars are visible to anyone with `run.services.get`, are rendered in the Console, and the UpdateService request body lands in Admin Activity audit logs retained ~400 days at project scope.

### Provisioning precedence (final)

1. `ZeroPGServerOptions.password` / `.verifier` (code wins)
2. `ZEROPG_PASSWORD_FILE` (Secret Manager / k8s projected file)
3. `ZEROPG_PASSWORD` (env; boots with a WARN naming the audit-log exposure)
4. `<prefix>/auth.json` in the object store - **verifier only**, `{version, current, previous, previousExpiresAt, epoch}`
5. `ZEROPG_AUTH=trust` - explicit only, refused on any non-loopback bind

Rules that are not negotiable: **empty or whitespace-only is a hard boot failure, never "absent"** (an explicitly-set-but-empty credential is a misconfiguration, and `??` preserves `''` throughout this codebase). Log the **resolved source** on every boot in one line so a typo is visible. Allowlist `ZEROPG_*` names and refuse to start on an unrecognized one, so a misspelled var cannot silently fall through to a different credential. **Enforcement is immediate whenever a credential is present, in every version** - only the *absence* of a credential is subject to the warn-then-refuse schedule.

### Peer-based trust is rejected

`trustedPeer = isLoopback(remoteAddress) && !x-forwarded-for` grants full admin authority to any request originating on loopback - which is exactly what an SSRF gives an attacker, and this repo has already shipped an SSRF in this precise shape. Under a credential model, SSRF alone is insufficient. Under peer trust, SSRF alone is total compromise.

**The sidecar DX problem it was solving has a better answer: we spawn PostgREST ourselves** (`packages/server/src/postgrest.ts`), so we inject a boot-generated in-memory credential into its environment. Loopback callers present a secret they were handed rather than being trusted for existing. Keep the peer check only as *additional* denial (refuse non-loopback even with a credential when configured), never as an alternative to one.

### Where a token still survives

The console/inspector, unchanged in substance. Its principal is a human in a browser spanning N databases; there is no per-database credential to present without either sharing one password fleet-wide or prompting per DB. `INSPECTOR_TOKEN` stays, **renamed** to a fleet-console credential so nobody confuses it with instance auth, and takes the already-specced per-link HMAC over `{target, exp}`. Its comparison becomes length-independent (hash both sides, then `timingSafeEqual`). Rule to write into `EDITOR-AUTH-SECURITY.md`: *instance credentials are per-database and never fleet-scoped; console credentials are fleet-scoped and never grant write.*

---

## 6. DEFAULT-SAFETY MATRIX

The bind check is an **allowlist over resolved addresses**, not a blocklist of `"0.0.0.0"`. Resolve the configured host to a concrete address set; the trusted-bind path requires *every* resolved address in `{127.0.0.0/8, ::1}`. `''`, `'0'`, `'::'`, `'::0'`, a LAN IP, a hostname, and an unresolvable name all take the credential-required branch. `isLoopback()` normalizes IPv4-mapped forms first (`::ffff:127.0.0.1` vs `::ffff:10.0.0.5`).

### Face A - HTTP control face (default `$PORT`/8080, binds `0.0.0.0` because Cloud Run requires it)

| Route class | No credential configured, 0.1.1 | No credential configured, 0.2.0 | Credential configured, absent/wrong on request | Credential configured, valid |
|---|---|---|---|---|
| `/up` `/healthz` `/wake` `/ready` | serve, `bootError` redacted to a code for unauthenticated callers | same | serve, redacted | serve, full `bootError` |
| `POST /sql` `POST /flush` | serve + boot WARN + `"insecure":true` in `/ready` | **401** | **401** | serve |
| `GET /metrics` | serve (`fencingToken` withheld) | **401** unless `ZEROPG_METRICS_PUBLIC=1` | **401** | serve, full |
| `/rest/*` | serve + WARN naming every table in an exposed schema with `rowsecurity=false` | **403** unless `ZEROPG_REST_PUBLIC=on` | **403** | serve |
| `/` (landing) | serve a page naming no bucket, prefix, or internal port | same | same | same |
| unknown | 404 | 404 | 404 | 404 |

`ZEROPG_HTTP=readonly` returns 404 on the admin class for every peer including loopback. `ZEROPG_HTTP_SOCKET` (unix, 0700 dir) is the recommended sidecar face.

### Face B - Postgres wire (default 5432)

| Bind | No password | Password set |
|---|---|---|
| loopback (default) | serve, trust auth, WARN in 0.1.1 | serve, SCRAM required |
| any non-loopback (incl. `''`, `'0'`, `'::'`, LAN IP) | 0.1.1: WARN loudly. **0.2.0: refuse to boot, exit 78** | serve, SCRAM required; WARN if TLS off |
| unix socket | serve, trust (filesystem permissions are the ACL - matches Postgres' own `local all all trust`) | SCRAM if `ZEROPG_WIRE_SOCKET_AUTH=scram` |
| `ZEROPG_WIRE=off` | no listener | no listener |

Connection-time order: SSLRequest → `S`/`N`, **never forwarded**. GSSENCRequest → `N`. First byte `0x16` → direct TLS with ALPN `postgresql`. Protocol 3.1/3.2 → NegotiateProtocolVersion(3.0). CancelRequest → close silently, never throw. Bad password → 28P01. Over cap → real ErrorResponse 53300. Unwhitelisted type → 08P01, never forwarded.

### Face C - PostgREST (3000)

Always loopback or unix socket, never configurable to a public interface; a non-loopback `PGRST_SERVER_HOST` is overridden and logged. **`PGRST_DB_CHANNEL_ENABLED=false` is set explicitly** (verified: `LISTEN`/`NOTIFY` is broken, so the channel connection is pure waste and consumes a slot). **`ZEROPG_POSTGREST` flips to default OFF** - the agent should not lose 1-2 of 10 connection slots and a cold-start cost to a REST API it never asked for.

### The one escape hatch

`ZEROPG_INSECURE=i-know-this-is-public`. A **value, not a boolean**, so it cannot be set by typo and it greps in code review. `ZEROPG_INSECURE=1` is rejected with a message giving the full required value. Restores full 0.1.0 behaviour, logs a full-width WARN block every boot, surfaces as `"insecure": true` in `/ready` and `/metrics`, renders red in `zeropg fleet status`, and is **removed in 0.3.0**.

---

## 7. ERROR STRING CATALOGUE

These are the real docs. Every string lives in `packages/*/src/errors.ts`; strings land in 0.1.1 even where the refusal is staged for 0.2.0.

### Client

**C1 - plaintext HTTP to a non-loopback host** (enforced with or without a credential; a credential makes it worse, not better)
```
zeropg connect: refusing to send SQL over plaintext http:// to a non-loopback host
(api.example.com). Anything on the path can read your data and your credential. Fix one of:
  use https://api.example.com                 Cloud Run, Fly and Workers all terminate TLS for you
  use http://127.0.0.1:8080                   loopback and unix sockets are always allowed
  ZEROPG_ALLOW_INSECURE_HTTP=api.example.com  allow just this host (also accepts CIDRs, or 1 for all)
  connect(url, { allowInsecureHttp: true })   the same thing, in code
```

**C2 - postgres:// handshake stall** (node-postgres defaults `connectionTimeoutMillis` to 0, i.e. wait forever; we default it to 15000)
```
zeropg connect: postgres://HOST:5432 did not complete a handshake within 15000 ms. If this is a
zeropg instance older than 0.1.1, its wire never answers the TLS probe that libpq sends by default
and the connection will hang forever. Add ?sslmode=disable to the URL, or upgrade the server to
>=0.1.1. Change the timeout with connect(url, { connectionTimeoutMillis }).
```

**C3 - unsupported scheme**
```
zeropg connect: unsupported scheme 'mysql://'. zeropg accepts:
  memory://                      throwaway, in-process
  ./dev.db or file://./dev.db    a local datadir
  gs://bucket/prefix             (also r2:// s3:// cos://) opens the bucket as the single writer
  https://<instance-url>         a deployed scale-to-zero instance
  postgres://host/db             a wire
```

**C4 - interactive transaction over HTTP**
```
zeropg: db.transaction(fn) needs a session, and https:// /sql is stateless - every POST is
independent. Either send one atomic batch:
  db.batch([{sql, params}, ...], { transaction: true })
or connect over postgres:// to the instance's wire.
```

**C6 - bucket credentials missing**
```
zeropg connect: gs://my-bucket/db - no Google credentials found. Do one of:
  gcloud auth application-default login
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
  run on a GCP runtime with a service account holding roles/storage.objectAdmin on my-bucket
```

**C7 - lease contention** (the most important error in the bucket milestone; fail fast, do not wait out `acquireTimeoutMs`)
```
zeropg connect: gs://my-bucket/db is already open by another writer (holder "standalone-17",
lease expires in 41s). zeropg is single-writer by design: exactly one process holds a bucket at a
time, and that is what makes the bucket a safe durable home. If this is a multi-replica app, deploy
ONE zeropg instance and point every replica at its https:// URL instead of opening the bucket
directly. If the other holder is dead, wait 41s for the lease to lapse. To take it now:
  zeropg fleet takeover gs://my-bucket/db     (discards the other holder's unflushed writes)
```

**C9 - single-writer WARN on successful `gs://` open** (new; C7 fires too late for an agent that only sees it at scale-out)
```
zeropg: this process now holds the single writer lease for gs://my-bucket/db. Any other process
opening this bucket will be refused. For a multi-replica app, deploy one zeropg instance and point
replicas at its URL.
```

### HTTP face
All JSON: `{"error": <slug>, "code": <STABLE_CODE>, "message": <string>}`.

**H1 - 401 `ZEROPG_HTTP_UNAUTHORIZED`**
```
zeropg: POST /sql requires a credential. Send it as: Authorization: Basic postgres:<password>,
or Authorization: Bearer <password>. Print a ready-to-paste URL with:
  zeropg fleet credential <service>
Set your own with ZEROPG_PASSWORD or ZEROPG_PASSWORD_FILE. To serve /sql to anyone with the URL,
set ZEROPG_INSECURE=i-know-this-is-public.
```

**H2 - 403 `ZEROPG_REST_NOT_PUBLIC`**
```
zeropg: /rest is not public on this instance. Either send Authorization: Basic postgres:<password>
(server-to-server), or set ZEROPG_REST_PUBLIC=on to serve it anonymously - in which case row-level
security is your only boundary, so enable RLS on every table in the exposed schemas first
(ALTER TABLE t ENABLE ROW LEVEL SECURITY).
```

**H3 - 400 `ZEROPG_SQL_BAD_BODY`**
```
zeropg: POST /sql expects {"sql": "select 1"} or
{"sql": "insert into t(name) values ($1) returning *", "params": ["hi"]} or
{"queries": [{"sql": ..., "params": [...]}], "transaction": true}.
Got keys: [a, b]. Placeholders are $1, $2, ... and params are bound server-side - never
string-interpolate values into sql.
```

**H4 - 423 `ZEROPG_FENCED`**
```
zeropg: this instance lost the writer lease (its fencing token 41 is older than the bucket's 42) -
another instance, a `zeropg fleet export`, or a `zeropg local` took over. Writes are rejected to
protect the bucket; nothing was applied. Retry the request: the platform will replace this
instance. If you are running `zeropg local` against the same bucket, stop it first.
```

**H5 - 503 `ZEROPG_NOT_READY`** (residual only; the normal path now *holds* the request, see M2 below)
```
zeropg: still restoring from the bucket (phase=restoring, 30.0s elapsed, ceiling exceeded).
Poll GET /ready until it returns {"ready":true}. Retry-After: 5
```

### Wire
All as real ErrorResponse messages with S/C/M/H fields, so psql and every driver print the HINT.

**W1 - 53300 too_many_connections** (replaces pglite-socket writing the raw ASCII `"Too many connections\n"`, which every client reports as `Connection terminated unexpectedly` or `read ECONNRESET`)
```
M: too many connections for this zeropg instance (limit 20: 20 in use, 0 available)
H: zeropg multiplexes every connection onto one PGlite session, so a bigger pool buys no
   parallelism. Lower your pool size (node-postgres: new Pool({max:4}); Prisma:
   ?connection_limit=4; pgx: pool_max_conns=4; SQLAlchemy: pool_size=4), or raise
   ZEROPG_WIRE_MAX_CONNECTIONS on the server.
```
(If the built-in PostgREST is enabled, the message must state both numbers: `limit 20: 18 available to clients, 2 reserved for the built-in PostgREST; disable it with ZEROPG_POSTGREST=off to reclaim them`.)

**W2 - 28P01**
```
M: password authentication failed for user "postgres"
H: print a ready-to-paste connection string with: zeropg fleet credential <service>.
   Set the password with ZEROPG_PASSWORD or ZEROPG_PASSWORD_FILE before boot.
```

**W3 - 08P01 unsupported frontend message**
```
M: unsupported frontend message type 'p' (0x70) on a zeropg wire connection
H: zeropg accepts Q P B D E C H S F X d c f. If a mainstream driver produced this, it is a zeropg
   bug - report the driver and version.
```

**W4 - 0A000 COPY FROM STDIN, rejected BEFORE dispatch** (the original "intercept CopyInResponse" design is impossible: PGlite throws `ExitStatus: exit(1)` and hangs forever rather than emitting the message)
```
M: COPY ... FROM STDIN is not supported over the zeropg wire
H: the CopyData stream is not carried into PGlite and would kill the shared session for every
   other connection. Use INSERT statements instead (pg_dump --inserts), or restore locally with:
   zeropg local <bucket-or-datadir>. COPY ... TO STDOUT works normally.
```

**W5 - 26000 after namespacing**
```
M: prepared statement "s1" does not exist
H: zeropg namespaces server-side prepared statement names per connection, so SQL-level
   PREPARE/DEALLOCATE and pg_prepared_statements show a prefixed name. Use your driver's
   parameterized query (extended protocol) instead of SQL PREPARE.
```

**W6 - NOTICE after 30s of held transaction**
```
zeropg: this connection has held an open transaction for 30s. PGlite is a single session, so every
other connection to this instance is blocked until you COMMIT or ROLLBACK.
```

**W9 - 0A000 non-UTF8 client encoding** (new; verified to wedge PGlite dead via a perfectly legal `Q`, so the message-type whitelist gives no protection)
```
M: SET client_encoding = 'LATIN1' is not supported
H: zeropg's PGlite backend is UTF8-only and a non-UTF8 client_encoding permanently wedges it.
   Use UTF8. Reached from psql \encoding, DBeaver charset settings, and pg_dump --encoding.
```

**W10 - 57P01 admin_shutdown, from the instance-death supervisor**
```
M: the database backend terminated abnormally and this instance is restarting
H: an operation killed the embedded Postgres (most often COPY FROM STDIN or a non-UTF8
   client_encoding). No data was lost: the instance re-restores from its bucket. Reconnect.
```

### Boot refusals
Single block to stderr, non-zero exit. Each names every way out.

**B1 - non-loopback wire, no password**
```
zeropg: refusing to start. The Postgres wire resolves to a non-loopback address (ZEROPG_WIRE_HOST
="" -> ::) with no password, which would let anyone who can reach port 5432 connect as a Postgres
superuser with full access to this database.
Fix one of:
  ZEROPG_PASSWORD=<password>               require SCRAM-SHA-256 (recommended)
  ZEROPG_PASSWORD_FILE=/run/secret         read it from a Secret Manager or Kubernetes mount
  ZEROPG_WIRE_HOST=127.0.0.1               bind loopback only (this is the default)
  ZEROPG_WIRE_SOCKET=/var/run/postgresql   serve a unix socket instead; filesystem perms are the ACL
  ZEROPG_INSECURE=i-know-this-is-public    restore 0.1.0 behavior (logged every boot, gone in 0.3.0)
```

**B2 - HTTP admin routes reachable, no credential** (0.2.0)
```
zeropg: refusing to start. POST /sql is reachable from the network with no credential configured.
Fix one of:
  ZEROPG_PASSWORD=<password>               clients send Authorization: Basic postgres:<password>
  ZEROPG_PASSWORD_FILE=/run/secret         read it from a file
  ZEROPG_HTTP=readonly                     serve /up /wake /ready only; /sql and /flush return 404
  ZEROPG_INSECURE=i-know-this-is-public    restore 0.1.0 behavior (removed in 0.3.0)
```

**B5 - empty credential** (new; the `??` bug class)
```
zeropg: refusing to start. ZEROPG_PASSWORD is set but empty. An explicitly-set-but-empty
credential is a misconfiguration, not a choice - it would accept "Authorization: Basic postgres:"
from anyone. Unset it to run without a credential, or give it a value of at least 128 bits of
entropy (ASCII only; non-ASCII passwords do not interoperate with SCRAM clients).
```

---

## 8. MILESTONES

Every estimate below is the **post-critique** figure. The pre-critique figures were fantasy in two places and I say so.

### 0.1.1 - strictly additive, nothing that works today stops working. **3-4 weeks.**

*(The original estimate for this was "3-5 days". That was written before the SQL guard, the instance-death supervisor, the doc reconciliation and the driver shim were known to belong here.)*

**M1a - stop the silent failures.**
- Bump `@electric-sql/pglite-socket` `^0.2.2` → `^0.2.7` (peer ranges already permit it: client/server declare `*`, cli declares `>=0.2.2`). This alone answers SSLRequest with `N` and retires the `sslmode=prefer` hang. **Then re-test psql, pg_dump, Adminer, WhoDB and Prisma's native engine before touching a single doc.**
- `POST /sql` learns parameters and batches: `{sql|query, params?}`, `{queries:[...], transaction?}`, multi-statement bodies routed through `db.exec()` not `db.query()`. Body shape deliberately mirrors Neon's so agents already know it. Delete the throw at `packages/client/src/remote.ts:20-24`.
- Connection cap becomes a real 53300 ErrorResponse; `maxConnections` becomes an option defaulting to 20 (currently hardcoded 10 at `server.ts:166`).
- `ZEROPG_POSTGREST` flips to default **off**; when on, set `PGRST_DB_CHANNEL_ENABLED=false` explicitly.
- ~450 LOC + ~600 LOC tests.

**M1b - the SQL guard and the death supervisor.** Pre-dispatch rejection of `COPY ... FROM STDIN` and non-UTF8 `SET client_encoding` at the `Q`/`Parse` boundary (W4, W9). Plus the half that actually matters: wrap every `execProtocolRaw` call so an `ExitStatus` throw or a zero-byte response to a `Q` marks the instance permanently dead, fails every in-flight and queued connection with 57P01 (W10), and exits so the platform restarts and re-restores. Without the supervisor, any missed wrapping (`DO $$`, dynamic `EXECUTE`, third statement of a multi-statement `Q`) is an unrecoverable silent hang. ~250 LOC + tests. **Depends on U3, U6.**

**M1c - the `pg`-compatible HTTP driver shim. This is the highest-value item in the entire plan and it was in nobody's milestone list.** Verified: `pg-connection-string` parses `https://:TOKEN@mydb-abc.a.run.app` into `{user:"", password:"TOKEN", host:"mydb-abc.a.run.app", port:"", database:null}` - the scheme is *discarded*, `pg` defaults to 5432 and dials raw TCP at a hostname that does not answer TCP. The agent gets `ETIMEDOUT` and **not one line of our error catalogue ever prints**, because zeropg code was never loaded. Ship what `@neondatabase/serverless` ships: `Pool`/`Client` over POST /sql with identical constructor and `query(text, values)` signature and `rows`/`rowCount`/`fields` shape, plus a `drizzle-orm` HTTP driver and a Prisma driver adapter. ~500 LOC + tests. **Depends on U5.**

**M1d - credential machinery, enforced when present.** Sources 1-3 (option, `_FILE`, env), verifier derived at boot, three-tier HTTP router, Basic and Bearer accepted, length-independent constant-time compare, explicit `http.listen(host)`. Empty string is a hard failure. `ZEROPG_*` name allowlist. **0.1.1 enforces whenever a credential is present; only its absence is staged.** ~350 LOC + 200 LOC of an exhaustive route-tier test table.

**M1e - `zeropg` and `@zeropg/cli` published.** Neither name is on npm today; claim them now. Compiled JS bin, not a tsx shebang (kills the `INIT_CWD` gotcha and npx startup cost). `serve`, `sql --param`, `deploy`, `fleet credential|url|status|doctor`, `migrate dev|deploy`, `run <cmd>`. **`DATABASE_URL` is written only when a real `postgres://` string exists**; the HTTP face goes into `ZEROPG_URL`, and the JSON key for an HTTP-only instance is `httpUrl`, not `databaseUrl`. Writing an `https://` value into `DATABASE_URL` manufactures the M1c failure and poisons every third-party tool that reads `.env`. ~600 LOC.

**M1f - doc reconciliation, as a gated deliverable not a risk.** `docs/LIMITATIONS.md:41` says `prisma migrate deploy` "cannot run"; `docs/ORM-ADAPTER-NOTES.md:198` says it "works", verified. LIMITATIONS.md is the file the README links as the truth table, so agents believe the wrong one and abandon Prisma. Also: mark `docs/TODO-pglite-socket-prepared-statements.md` SUPERSEDED (its "bounded, localized handler patch" recommendation and its `simple_protocol` advice are both wrong); mark `docs/STATUS-nostr-relay.md` superseded; repair the corrupted XML tail at `docs/ORM-ADAPTER-NOTES.md:300-301`. Add **new** limitation entries for advisory locks (no mutual exclusion, verified) and `LISTEN`/`NOTIFY` (delivered to the notifier). Add a CI grep that fails on retired `sslmode=disable is REQUIRED` assertions so the sweep cannot be left half-finished.

**M1g - bucket schemes and bare paths.** `gs:// r2:// s3:// cos://` wired in `connect()` (`packages/client/src/index.ts:93` currently throws while the README advertises it), bare paths accepted as `file://`, C6/C7/C8/C9. ~350 LOC. Fail fast on lease contention; do not wait out `acquireTimeoutMs`.

### 0.2.0 - the vendored wire and the default flip. **10-14 weeks total.**

**M2 - `packages/wire`, the vendored frontend. 6-10 weeks, not 2.5-4.** The original estimate did not include: the driver interop harnesses (~1 week before a single assertion runs), the Flush-vs-Sync cursor decision and its tests, ParameterStatus tracking and async broadcast, LISTEN routing or an explicit limitation, per-connection statement cleanup on detach, ALPN, and replacing `@std/crypto`. Contents: vendored subset with `node:crypto`; the seven patches (WritableStream crash, tri-state TLS defaulting to *optional*, NegotiateProtocolVersion, BackendKeyData + CancelRequest, live-tracked ParameterStatus replay rather than a boot snapshot, never-forward SSLRequest/GSSENC/Cancel/Password, ALPN direct TLS); our own framer with the U4-derived whitelist and a length cap; the **literally ported** stall-based affinity queue with the window closing at Flush *or* Sync and affinity held from the first extended-protocol message to its matching Sync, with a 30s cap on an unsynced hold. Gate: an expanded isolation suite, not the existing one - including **abrupt disconnect mid-transaction** (PGlite swallows Terminate and the transaction survives; a client can send `BEGIN; SET ROLE service_role;` then RST), extended-protocol concurrency, and a transaction left in the failed `Z(E)` state.

**M3 - prepared-statement namespacing. ~250 LOC, 3-5 days.** The rewriter is ~45 lines and is proven. The real work is un-prefixing names in outbound ErrorResponse text and `Close('S', name)` per statement on detach (300 named statements survive Terminate; without cleanup they accumulate against the 0.5GB ceiling). **Promise downgraded from "unblocks sqlx and Diesel" to "removes the 42P05 wall"** - advisory locks are a verified no-op, so migrations would silently race even with namespacing working perfectly.

**M4 - cold-start absorption, at BOTH faces. ~500 LOC, 1.5-2 weeks.** The original scoped this to the wire only, leaving `POST /sql` returning 503 on the first request after idle - on the only face the flagship platform has. Hold HTTP requests too, same 30s ceiling, same distinct paths for restore-failed and FencedError, `Retry-After` on any 503 that escapes. Resolve the credential **before binding any listener** (a bucket GET is tens of ms and is not on the restore path); a wire connection must never reach the authenticated state while the credential is unresolved.

**M5 - the default flip.** B1/B2 become real, the peer check becomes defense-in-depth only, `ZEROPG_INSECURE=i-know-this-is-public` ships. `docs/UPGRADE-0.2.md` with a four-row decision table. `zeropg fleet status` gains a "would this boot under 0.2.0" column. The 11 demos mostly take `ZEROPG_INSECURE` plus a banner; **the Supabase demo takes a real credential** because it holds real `auth.users` emails behind one factor. **Do not backport the flip to any 0.1.x patch, including for the demos.**

### Later / 0.2.x

Unix socket face (~200 LOC, low complexity, but it is the thing that makes bare `psql` with no arguments work and it turns "is my wire exposed" from a config question into a filesystem fact). Per-connection role and GUC emulation, with the response-filtering contract stated explicitly - an injected `SET` produces `C(SET)` + up to six `S(...)` + `Z(I)`, and forwarding those desynchronizes the connection permanently, which is worse than the bug it fixes. TLS materials. `zeropg deploy --fly`.

---

## 9. OPEN DISAGREEMENTS - for you to decide

**Q1. Do we build TLS on the wire at all in this cycle?**
The three designs said *optional*, *default on*, and *required-else-refuse*. I resolved it to optional. But the protocol critic went further and argued TLS is theater in every topology this repo actually deploys - Cloud Run and the sidecar are loopback where an attacker already has code execution, and the load-bearing justification is Fly, for which **there is no fly.toml in the repo**. Answering SSLRequest with `N` already satisfies libpq's default `sslmode=prefer`, which is the real north-star failure. My recommendation: **ship SSLRequest + SCRAM first, defer TLS until a raw-TCP deployment actually exists, and when it does take the cert from `ZEROPG_TLS_CERT`/`_KEY` only.** You wanted TLS built ("ultra standard software"), so this is the place I am most directly pushing back and I want your call.

**Q2. Is the wire replacement worth 6-10 weeks given Cloud Run has no TCP?**
The naive-agent critique is the strongest single finding in the pack: after all eight original milestones, an agent handed a deployed connection string still fails at step one, outside our code. The wire buys laptops, Fly, graduation, and the 42P05 wall. The HTTP shim buys the flagship. I have sequenced HTTP first, but I have not cut the wire. **Is the wire a 0.2.0 commitment or a "when the HTTP story is done" item?**

**Q3. Do we ship a read-only HTTP tier now?**
The security reviewer argues one superuser credential is below the bar we are positioning against - Supabase's browser key is safe *by construction* (anon under RLS), Neon separates the owner role from JWT-driven `authenticated`. A read-only tier is available today at the HTTP face (a second independently-salted verifier; requests wrapped `BEGIN READ ONLY; <stmt>; COMMIT` inside one exclusive batch, enforced by Postgres not by us parsing SQL). That is a **second credential**, which cuts against the "one credential" decision. My lean: **do not ship it in 0.1.1; instead change the docs posture** - `/sql` is an *operator* face for migrations and admin, application traffic belongs on `/rest` with JWT + RLS. But that posture only works once §Q4 is resolved.

**Q4. Can we recommend `ZEROPG_REST_PUBLIC=on` before per-connection session state exists?**
`SET ROLE` leaks across the shared session, `RESET ALL` does not clear it, and `pg_dump`'s `set_config('search_path','',false)` persists so other connections see an empty search_path. Anyone who can reach `/sql` can poison the shared session's search_path, and unqualified references in RLS policy expressions and SECURITY DEFINER functions then resolve against it. The existing RLS proof only covers transaction-scoped `SET LOCAL`, not session-scoped poisoning from a different connection. The security reviewer wants GUC emulation to be a **prerequisite** for recommending public `/rest`, not a follow-up. That would push the Supabase-on-zeropg recommendation out to 0.2.x.

**Q5. `deploy.sh --allow-unauthenticated`: keep or drop?**
The credential design kept it ("public one-click URLs are the product; the fix is app-level auth"). The security reviewer wants `--auth iam` offered as the real answer, partly because `/wake` is an unauthenticated cost lever that **authentication cannot fix** - the container is already running by the time the handler sees the request. Their cost analysis: forced cold starts are ~$0.06/day/service and irrelevant; the real attack is one request every ~10 minutes to *prevent* scale-to-zero, ~$60/month/service if CPU is always-allocated, a few hundred a month across the 11 demos from a cron job on a $5 VPS. Mitigations that actually work are deployment flags (never set `--cpu-always-allocated`, enforce `--max-instances=1` in the CLI) and Cloud Armor, not route auth.

**Q6. Version cadence.** You said slow increments. I have put a large amount into 0.1.1 (3-4 weeks) and the breaking flip into 0.2.0. The alternative is 0.1.1 (security + /sql params, ~1 week), 0.1.2 (driver shim + CLI), 0.2.0 (wire), 0.3.0 (flip). More versions, smaller each, and the flip lands later. **Your call on which shape you want to ship.**

---

## 10. WHAT WE ARE NOT DOING

- **Mandatory TLS (Neon's posture).** Empirically breaks the number-one case: `new pg.Client({connectionString})` with no ssl option fails 08P01 against a TLS-required server. Neon only survives it by controlling every connection string. Supabase's stated reason for allowing plaintext - "to maximize client compatibility" - is our reason too.
- **TLS private keys in the object store.** Proposed by two designs so the cert is stable across the constant cold starts of a scale-to-zero database. Rejected: it makes a bucket reader able to impersonate the server, and it ties wire identity to bucket durability. Per-boot generation for dev (into the datadir, mode 0600) or an operator-supplied PEM.
- **Cleartext credentials in the bucket, and `auth.claim.json`.** GCS has no atomic read-and-delete, soft delete retains deleted objects 7 days by default, and `deploy.sh` shares one bucket across all services with one SA under uniform bucket-level access. Verifiers only. Plaintext is generated in the CLI at deploy time and goes to Secret Manager.
- **The derived HTTP token `HMAC(ServerKey, ...)`.** ServerKey is part of the stored verifier; the token is computable by anyone with bucket read. The feature and its own mitigation cancel out exactly.
- **Peer-based trust as an alternative to a credential.** Converts every SSRF into unauthenticated superuser SQL, and this repo has already shipped an SSRF in that exact shape (`c3120ff`). Sidecars get an injected boot credential instead; we spawn PostgREST ourselves so this is free.
- **`SCRAM-SHA-256-PLUS` / channel binding, and client-certificate mTLS.** libpq defaults `channel_binding=prefer`, so advertising only SCRAM-SHA-256 is sufficient. Neon added `-PLUS` to its default string in June 2025 and it already breaks Go's pgdriver. Neither vendor documents client certs.
- **ACME / Let's Encrypt.** Needs a stable public hostname, a challenge path, and renewal state, all of which fight scale-to-zero.
- **Depending on `pg-gateway@0.3.0-beta.4` from npm.** Remote unauthenticated process kill, unfixable from outside, beta on a branch unmerged 19 months.
- **Per-connection prepared-statement namespacing inside pglite-socket.** It never decodes a message type byte or a name field; namespacing there means adding a full wire parser to a dependency we do not control. ~45 lines in a layer we own.
- **`DISCARD ALL` on disconnect, and true session-per-connection.** The first nukes a concurrent peer's statements and must be its own statement or it fails 25001. The second is impossible: PGlite is one instance, one session, and two instances cannot share a datadir.
- **A hosted control plane, a stored fleet registry, or credential rotation as a service.** Already a settled non-goal (`docs/FLEET.md:205-216`); the bucket-write IAM boundary does the authorization for rotation, which is why no new trust boundary is needed.
- **Advertising query cancellation.** BackendKeyData is a hardcoded constant in PGlite (pid=42, key=2875488) on every instance, and PGlite cannot interrupt a running query - `statement_timeout` is already inert. Recognize 80877102, log, close silently, never throw. Say nothing more.
- **Promising that M3 unblocks sqlx and Diesel.** Advisory locks are a verified no-op on the shared session. Do not make that claim until `nostr-rs-relay` actually boots *and* two concurrent connections demonstrate real mutual exclusion.