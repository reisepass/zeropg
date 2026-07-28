# Wire layer and auth: research dossier, 2026-07-28

Raw output of a parallel research fan-out run while planning a real Postgres wire frontend
(TLS + SCRAM) and a credential model able to stand next to Neon and Supabase. Four research
tracks completed; a fifth (pglite-socket internals vs PGlite's protocol surface) and the
design/critique phases were still running when this was written, so **this file is evidence,
not conclusions.** Decisions live in
[CONNECTION-SECURITY-AND-WIRE.md](CONNECTION-SECURITY-AND-WIRE.md).

## The three findings that change the plan

1. **pg-gateway already exists in this repo and is already spiked.** MIT, by Greg Richardson
   (supabase-community), a full server-side Postgres v3 frontend with SSLRequest/TLS upgrade
   and trust/md5/scram-sha-256 auth. It is already a root devDependency at `^0.3.0-beta.4`,
   already exercised at `experiments/prisma-spike/pggw.ts`, and `docs/ORM-ADAPTER-NOTES.md:255-262`
   already concluded it is "the better wire layer for everything else" and named the swap as
   a candidate follow-up. **Build-vs-adopt is close to settled: adopt.**
2. **The SSLRequest fix exists upstream.** pglite-socket 0.2.3 added `handleSslRequest()`
   replying `'N'`. The monorepo pins `^0.2.2`, which lacks it. Peer ranges already permit the
   bump. GSSENCRequest is still unhandled even in 0.2.4.
3. **The single biggest regression risk in any wire swap** is pglite-socket's
   transaction-aware `QueryQueueManager`. That is what makes RLS isolation safe on the shared
   session (proven: 2s held transaction + 100 concurrent cross-user reads, zero bleed). It has
   never been tested against pg-gateway. Any swap must re-verify it first.

Also settled and NOT to be redone: per-connection prepared-statement namespacing was
assessed against source as a deep architectural change, not a patch; `DISCARD ALL` at
connection close is unsafe because it nukes a concurrent peer's statements; true
session-per-connection is impossible on PGlite.

---


## PRIOR ART IN THE ZEROPG REPO

The zeropg repo has months of settled design work across all four areas you asked about; almost nothing here needs redoing.

**(a) Wire layer / pglite-socket.** The architecture is fixed: PGlite is one Postgres session, and `@electric-sql/pglite-socket`'s `PGLiteSocketServer` multiplexes every TCP connection onto it (`packages/client/src/wire.ts`, `packages/server/src/server.ts:158-168`). This is a *throughput* limit, never a correctness one (measured: Pool(10) × 20 overlapping queries = exactly serialized, 1033ms). Consequences already characterized and documented: read-after-write can lag seconds behind an HTTP 200; `COPY ... FROM STDIN` is not carried and wedges the session with FATAL `08P01`; session GUCs (`search_path`, `SET ROLE`) leak across connections; an idle-open explicit transaction freezes *every* client; server-side `statement_timeout` is inert on PGlite. The one property that makes RLS safe is pglite-socket's transaction-aware `QueryQueueManager`. `pg-gateway` was already spiked as an alternative wire layer (`experiments/prisma-spike/pggw.ts`) and judged better for everything except `prisma migrate dev` — a documented candidate follow-up, not done.

**(b) Auth / passwords / TLS.** Decided and written down: **zeropg has no built-in auth anywhere; the wire accepts any username/password, and every security property comes from network placement plus gates in front of it** (docs/EDITOR-AUTH-SECURITY.md:18-21). `@zeropg/server`'s HTTP `/sql` is unauthenticated by construction; the CLI actively warns that an `allUsers` invoker binding is an open SQL endpoint. The console is loopback-only and refuses to widen; the one wide-bound mode (`--inspector`) uses a single 192-bit bearer token → `zpt` cookie, with structural route pruning and read-only detached replicas. The hardening ladder (IAM identity → per-link HMAC `{target,exp}` → PII redaction) is already specced with the `ConsoleAuth` interface shaped for the third mode. No TLS on the wire, ever, by design — `sslmode=disable` everywhere.

**(c) Prepared statements.** Fully characterized. The wall is *named* server-side prepared statements (`42P05`). Screen: "does the driver name its server-side prepares and keep them across pooled connections?" Blocked with no escape hatch: Rust sqlx, Rust Diesel. Escape hatches found and verified: pgx v5 `cache_describe` (NOT `simple_protocol` — it breaks JSONB with `22P02`), pgx v4/pop `statement_cache_mode=describe`, PostgREST `db-prepared-statements=false` + pool=1.

**(d) Topology.** Loopback wire + HTTP control face; raw 5432 never exposed on Cloud Run; migrations applied by the single writer to itself; graduation is `pg_dump`.

Two things were **explicitly assessed as too hard**: per-connection prepared-statement namespacing in pglite-socket (needs a real wire-protocol parser — deep, not a patch) and session-per-connection (impossible, PGlite is single-session). I found several doc contradictions, the biggest being that the SSLRequest gap is already fixed upstream in pglite-socket 0.2.3.

### Facts

- **verified** zeropg has NO built-in auth anywhere: the Postgres wire accepts any username/password, and all security comes from network placement plus gates in front of it. This is the stated, deliberate design position.
  - evidence: docs/EDITOR-AUTH-SECURITY.md:18-21 "zeropg itself has **no built-in auth anywhere** - the wire accepts any username/password. Every security property therefore comes from *network placement* (what can reach a wire) and *gates in front of it* (the token)."
- **verified** There is no password to leak because none exists: what an editor submits as a DB password is supplied server-side and never verified. Framed as 'the DB-credentials problem is dissolved, not solved.'
  - evidence: docs/EDITOR-AUTH-SECURITY.md:124-126; packages/server/src/postgrest.ts:79 "// No password: pglite-socket accepts any startup and there is exactly one (single-writer) database behind it."
- **verified** @zeropg/server's HTTP face is completely unauthenticated: POST /sql runs arbitrary SQL, POST /flush quiesces, /rest proxies PostgREST. No token/bearer/header check exists in the request router.
  - evidence: packages/server/src/server.ts:282-326 (handle() routes /up,/wake,/ready,/metrics,/sql,/flush,/rest with no auth branch); grep for token|auth|bearer in packages/server/src returns only postgrest role comments and remote-client's optional caller-supplied headers
- **verified** The fleet CLI and console explicitly surface this: a Cloud Run service with an allUsers invoker binding is treated and reported as an open SQL endpoint.
  - evidence: packages/cli/src/fleet/index.ts:152 "'PUBLIC: allUsers can invoke, and zeropg has no built-in auth; anyone with the URL can run SQL'"; docs/FLEET.md:160-162
- **verified** Console auth is already pluggable middleware with exactly two implemented modes, and a third (per-link HMAC of {target,exp}) is designed into the interface but deliberately not built.
  - evidence: packages/cli/src/console/auth.ts:1-18 (header comment) and :30-70 (authNone/authBearer); docs/EDITOR-AUTH-SECURITY.md:176-179
- **verified** The inspector bearer flow is settled: 192-bit token from Secret Manager, ?t=<token> on the first hop -> 302 that sets HttpOnly/Secure/SameSite=Lax cookie 'zpt' and strips the token from the URL; every later request must present the cookie or gets 403. Adminer's login() independently re-checks the same token.
  - evidence: packages/cli/src/console/auth.ts:45-70; docs/EDITOR-AUTH-SECURITY.md:66-104
- **verified** The bearer token comparison is a plain non-constant-time string inequality. Not exploitable at 192 bits, but it is the only crypto-adjacent comparison in the auth path.
  - evidence: packages/cli/src/console/auth.ts (authBearer gate): "if (presented !== token) { res.writeHead(403 ..."
- **verified** Five named weaknesses of the bearer model are already stated plainly and accepted: one shared token with no identity, the link IS the credential, no expiry, real PII (auth.users emails) behind one factor, allUsers invoker. A three-rung hardening ladder is written down.
  - evidence: docs/EDITOR-AUTH-SECURITY.md:139-158 (weaknesses) and :169-180 (hardening ladder: remove allUsers/require Google identity -> per-link expiring HMAC tokens -> redaction at the replica)
- **verified** The load-bearing security rule of the whole editor design: powerful (read-write) access sits behind the strongest boundary (your machine + GCS IAM); the wide-bound cloud surface holds only disposable read-only snapshots. Inverting that is explicitly named as 'the line not to cross'.
  - evidence: docs/EDITOR-AUTH-SECURITY.md:182-189; enforced structurally per docs/FLEET.md:245-249
- **verified** A host-controlling SSRF was found and fixed in the inspector /db reverse proxy: prefix-stripping left a protocol-relative //host that new URL() re-homed off loopback, aimable at the GCP metadata server to steal the runtime SA's OAuth token. Fix = collapse leading slashes AND pin the resolved origin. Regression test exists.
  - evidence: docs/EDITOR-AUTH-SECURITY.md:129-137; commit c3120ff; examples/cloudrun/inspector/test/ssrf.test.mjs
- **verified** The console binds 127.0.0.1 with no flag to widen; the inspector is the single sanctioned 0.0.0.0 mode and refuses to start without INSPECTOR_TOKEN.
  - evidence: packages/cli/src/console/index.ts:451-453; packages/cli/src/console/inspector.ts:139-140 "INSPECTOR_TOKEN is required - the inspector fronts every fleet database and refuses to start without its token gate"; :211-214
- **verified** No TLS on the Postgres wire, by design. pglite-socket is a plaintext loopback TCP endpoint; every documented connection string carries sslmode=disable / PGSSLMODE=disable.
  - evidence: docs/GRADUATION.md:226-229 "**No TLS on the wire - use `sslmode=disable`.**"; docs/GRADUATION.md:94; packages/server/src/postgrest.ts:80-86
- **verified** CONTRADICTION / ALREADY FIXED UPSTREAM: the repo's open 'wire does not answer SSLRequest, clients with default sslmode HANG' finding is stale. pglite-socket 0.2.3 added handleSslRequest() which replies 'N' so clients fall back to cleartext. The root monorepo still pins ^0.2.2 (which lacks it); the from-npm example tree has 0.2.4 (which has it).
  - evidence: docs/LIGHT-PG-EDITORS-SURVEY.md:86-98 ("Proper fix candidate: serveWire should answer `N` ... TODO: check whether pglite-socket already supports this") VS examples/from-npm/node_modules/.pnpm/@electric-sql+pglite-socket@0.2.4*/node_modules/@electric-sql/pglite-socket/CHANGELOG.md:17-21 "## 0.2.3 ... 7f6ee05: Handle the `SSLRequest` startup packet per the PostgreSQL wire protocol: when SSL is not available, respond with `N`" and src/index.ts:330-347 handleSslRequest(); root package.json dependencies: "@electric-sql/pglite-socket": "^0.2.2"
- **verified** CONTRADICTION (source vs docs): the code comment in @zeropg/server still asserts pglite-socket 0.2.x does not implement SSLRequest/GSSENCRequest negotiation and that this is why PGRST_DB_URI needs sslmode=disable. True for 0.2.2, false for >=0.2.3.
  - evidence: packages/server/src/postgrest.ts:80-86 "sslmode=disable is REQUIRED: pglite-socket (0.2.x) does not implement the SSLRequest/GSSENCRequest negotiation ... the connection deadlocks."
- **verified** Peer-dependency ranges already permit the fix: @zeropg/client and @zeropg/server declare pglite-socket "*", @zeropg/cli declares ">=0.2.2". Only the monorepo's own dependency pin (^0.2.2, resolved to 0.2.2) holds the dev/test install back.
  - evidence: packages/client/package.json peerDependencies; packages/cli/package.json:19 "@electric-sql/pglite-socket": ">=0.2.2"; root package.json dependencies
- **verified** GSSENCRequest is NOT handled even in 0.2.4 - only SSLRequest (code 80877103) is. A client that probes GSS first is still unhandled.
  - evidence: pglite-socket 0.2.4 src/index.ts:6-7 (SSL_REQUEST_CODE=80877103 only) and :330-347; no GSSENC constant anywhere
- **verified** pg-gateway is ALREADY spiked in this repo as an alternative wire layer and answers SSLRequest correctly; it also supports trust/md5/scram-sha-256 auth and TLS options. A plain pg client reached it with NO sslmode=disable and NO user override.
  - evidence: experiments/prisma-spike/pggw.ts:1-10 and :55-58 (auth: { method: 'trust' }); docs/ORM-ADAPTER-NOTES.md:255-262 "pg-gateway is the better wire layer for everything else ... Candidate follow-up: swap `serveWire`'s backend from `@electric-sql/pglite-socket` to `pg-gateway`"; node_modules/pg-gateway/dist/index.d.ts:1 exports Md5AuthFlow, ScramSha256AuthFlow, TlsOptions, verifyScramSha256Password; pg-gateway ^0.3.0-beta.4 is a root devDependency
- **verified** DECIDED, DO NOT REDO: the named-prepared-statement wall. The screen is 'does the driver create NAMED server-side prepared statements and keep them across pooled connections', not 'is it sqlx'. Blocked with no escape hatch: Rust sqlx and Rust Diesel.
  - evidence: docs/POSTGRES-APP-COMPAT.md:125-138; docs/LIMITATIONS.md:45-52
- **verified** ASSESSED TOO HARD (the key negative result): per-connection prepared-statement namespacing in pglite-socket is a DEEP architectural change, not a patch. The socket layer frames messages only by length prefix and forwards each as an opaque Uint8Array into execProtocolRawStream - it never decodes the message type or statement-name field, so name rewriting requires adding a real wire-protocol parser.
  - evidence: docs/POSTGRES-APP-COMPAT.md:169-177 "**Fix scope (assessed against `@electric-sql/pglite-socket@0.2.2` source):** it's a DEEP/architectural change, not a small patch."; echoed in docs/LIMITATIONS.md:50-52
- **verified** ASSESSED AND REJECTED: DISCARD ALL / DEALLOCATE ALL at connection close is unsafe as a general fix, because the server tracks concurrent overlapping connections on the shared session - clearing one connection's statements nukes a peer's.
  - evidence: docs/POSTGRES-APP-COMPAT.md:174-177; docs/TODO-pglite-socket-prepared-statements.md:88-95 (option 2, 'only correct for non-overlapping connections ... use only as a stopgap behind a flag')
- **verified** ASSESSED AND REJECTED as impossible: true session-per-connection. PGlite is single-instance/single-session and two instances cannot share a datadir.
  - evidence: docs/TODO-pglite-socket-prepared-statements.md:97-100 "### 3. (NOT VIABLE) True session-per-connection ... Rejected."
- **verified** CONTRADICTION (stale vs source-verified): docs/TODO-pglite-socket-prepared-statements.md still calls the namespacing fix 'a bounded, localized change in the handler - a fork/patch of pglite-socket, not a deep rewrite' and RECOMMENDS it. The later, source-verified assessment in POSTGRES-APP-COMPAT.md says the opposite. The compat doc is newer and evidence-backed and should be treated as superseding.
  - evidence: docs/TODO-pglite-socket-prepared-statements.md:83-86 "pglite-socket already parses/forwards the wire protocol ... so this is a bounded, localized change in the handler — **a fork/patch of pglite-socket, not a deep rewrite.**" VS docs/POSTGRES-APP-COMPAT.md:169-177
- **verified** CONTRADICTION (stale): the prepared-statement TODO doc still prescribes pgx `?default_query_exec_mode=simple_protocol` as the Go escape hatch. That was corrected: simple_protocol sends []byte params untyped and breaks JSONB (webhookx hit 22P02). The current rule is `cache_describe`.
  - evidence: docs/TODO-pglite-socket-prepared-statements.md:16-21 (simple_protocol) VS docs/POSTGRES-APP-COMPAT.md:153-167 "**CORRECTION (from webhookx): `simple_protocol` is NOT the right default - use `cache_describe`.**" and docs/LIMITATIONS.md:42
- **verified** Verified per-driver escape hatches, all DSN/config-only, no app patches: pgx v5/GORM -> default_query_exec_mode=cache_describe plus pool>1 (pool=1 deadlocks golang-migrate's advisory-lock connection); GoTrue (pop/pgx v4) -> statement_cache_mode=describe; PostgREST -> db-prepared-statements=false + pool=1 (built into @zeropg/server).
  - evidence: docs/POSTGRES-APP-COMPAT.md:153-167; docs/LIMITATIONS.md:42-44; packages/server/src/postgrest.ts:87-101 (PGRST_DB_POOL='1', PGRST_DB_PREPARED_STATEMENTS='false')
- **verified** postgres-meta needs NO prepared-statement workaround at all: node-postgres only creates a named server-side statement when a query is given a `name`, and postgres-meta never does. Its default pool max:1 plus unnamed statements sidestep the whole 42P05 class. Verified with 20 concurrent mixed requests and 50x identical query, zero 42P05.
  - evidence: docs/STUDIO-PGMETA-COMPAT.md sections 'How postgres-meta talks to Postgres' and 'Adversarial findings 1'
- **verified** Single-session behavior is fully characterized, with numbers: concurrency is a throughput not correctness limit (Pool(10), 20 overlapping pg_sleep(0.05) = 1033ms, exactly serialized); read-after-write across separate connections can lag seconds behind an HTTP 200 so verification must poll.
  - evidence: docs/POSTGRES-APP-COMPAT.md:100-113; docs/LIMITATIONS.md:12-18
- **verified** RLS IS SAFE on the shared session, and the reason is known: pglite-socket's QueryQueueManager is transaction-aware - while a transaction is open it dispatches only that handler's statements, so PostgREST's per-request BEGIN; SET LOCAL role; ...; COMMIT is atomic. Proven with a 2s held transaction + 100 concurrent cross-user reads = zero bleed. Any wire-layer swap must re-verify this property.
  - evidence: examples/cloudrun/supabase/README.md section 3 'RLS isolation'; test/killswitch-rls-isolation.mjs; docs/STUDIO-PGMETA-COMPAT.md finding 4
- **verified** Known shared-session landmines, all with verified error codes: COPY ... FROM STDIN wedges the wire with FATAL 08P01 (COPY TO STDOUT is harmless); DISCARD ALL must be sent as its own single statement or it fails 25001 inside node-postgres's implicit transaction; RESET ALL does NOT clear SET ROLE; an idle-open explicit BEGIN freezes every other client until commit/detach; server-side statement_timeout and idle_session_timeout are INERT on PGlite (client-side timeout only, and it is not a cancel).
  - evidence: docs/STUDIO-PGMETA-COMPAT.md 'Addendum' and 'Adversarial findings 3 and 4'; docs/LIMITATIONS.md:78-83
- **verified** Session GUC bleed is documented as a graduation caveat too: pg_dump's `set_config('search_path','',false)` persists on the multiplexed session and other connections observe an empty search_path afterwards.
  - evidence: docs/GRADUATION.md:243-254 (caveat 4)
- **verified** Prisma verdict is settled empirically: `migrate diff --script`, `migrate deploy`, `generate` + @prisma/adapter-pg all work over the wire; `migrate dev` fails P1017 and is structurally impossible on any single PGlite (needs multiple independent sessions for shadow reset + advisory lock). pg-gateway was tested and does NOT fix it. A homegrown ~100-line migrateDev() orchestrating diff --from-migrations + migrate deploy IS built and verified 6/6.
  - evidence: docs/ORM-ADAPTER-NOTES.md:196-227 (table + pg-gateway result) and :229-253 (the homegrown solution, experiments/prisma-spike/zeropg-migrate.ts, migrate-dev-tool.test.ts)
- **verified** Prisma's NATIVE query engine needs exactly two connection-string prerequisites over pglite-socket: ?sslmode=disable (Rust engine defaults to prefer, sends SSLRequest -> P1001) and user `postgres` (else P1010). node-postgres/Drizzle need neither.
  - evidence: docs/ORM-ADAPTER-NOTES.md:187-191; docs/POSTGRES-APP-COMPAT.md:81-90; examples/drizzle-board/README.md:40-43 ("A plain `pg` Pool connects to the wire with no `?sslmode=disable` and no user override")
- **verified** Governing topology decision (already resolved, do not re-litigate): raw 5432 stays loopback because Cloud Run / Code Engine cannot accept raw Postgres TCP; DDL never crosses HTTP as an engine connection; the single-writer instance applies schema to ITSELF under the lease, which IS the advisory lock ORMs reach for. A Neon-style wire-over-WebSocket proxy is named as the only way to make remote look like postgres:// and is deferred to v2/v3.
  - evidence: docs/ORM-ADAPTER-NOTES.md:98-119 ('Governing principle (the resolution)') and :169-177 ('Future option: wire-over-WebSocket proxy')
- **verified** Fleet export/migrate deliberately does NOT go through the service's wire: the CLI boots the DB locally from its bucket (lease takeover), serves a loopback wire, and runs stock pg_dump. It quiesces with POST /flush first, because taking the lease from an awake sleep-durability instance drops its unflushed writes (live-verified; --accept-data-loss is the explicit override on old images).
  - evidence: docs/FLEET.md:164-188
- **verified** pg_dump/psql client tools must be >= the PGlite Postgres major (18+ today) or the dump aborts on server version mismatch; and the default COPY-format dump must NOT be restored back into a pglite-socket wire (use --inserts for zeropg-to-zeropg).
  - evidence: docs/GRADUATION.md:100-104 and :218-241 (caveats 1 and 3); docs/LIMITATIONS.md:78-83
- **verified** Extensions: PGlite only has an extension if its JS contrib module was preloaded into PGlite.create({extensions}); CREATE EXTENSION IF NOT EXISTS does not lazy-load. ~33 contrib bundles ship. pgvector is a separate package; PostGIS does not exist. Across 880 real migrations only citext, pgcrypto, pg_trgm were ever needed.
  - evidence: docs/POSTGRES-APP-COMPAT.md:41-79; docs/LIMITATIONS.md:55-67
- **verified** CONTRADICTION (stale doc): docs/STATUS-nostr-relay.md says znostr-relay is 'Built, deploy + round-trip verification unfinished' and that nostr work is paused (2026-06-23). POSTGRES-APP-COMPAT.md and README both record znostr-relay and nostream as VERIFIED locally AND live on Cloud Run with cold-restart durability proof.
  - evidence: docs/STATUS-nostr-relay.md:12 and 'What's left before this can be called done' VS docs/POSTGRES-APP-COMPAT.md:216-239 and README.md:86
- **verified** DOC DEFECT: docs/ORM-ADAPTER-NOTES.md has a corrupted tail - the file ends with a stray '</content>' and '</invoke>' XML artifact after line 299.
  - evidence: docs/ORM-ADAPTER-NOTES.md:300-301
- **verified** CONTRADICTION (internal): docs/ORM-ADAPTER-NOTES.md's header says 'Status: notes / design thinking, not implemented' and a banner says 'NOTHING HERE IS CONCLUDED', yet the bottom half contains firmly verified 2026-06-21 conclusions and the local-wire mode it proposes (serveWire) is shipped in packages/client/src/wire.ts.
  - evidence: docs/ORM-ADAPTER-NOTES.md:3-5 and :14-38 VS :181-186 and packages/client/src/wire.ts:91
- **verified** CONTRADICTION (internal, minor): docs/FLEET.md states contexts are saved in ~/.config/zeropg/contexts.json in one section and that ~/.zeropg is now the single home dir with contexts.json moved there (old path a fallback) in another.
  - evidence: docs/FLEET.md:41-43 VS docs/FLEET.md:118-120
- **verified** KNOWN UNFIXED DEVIATION: the studio/postgres-meta up-local test harness binds its wire on 0.0.0.0 so the wire is reachable from the LAN with no auth while that stack is up. Documented as 'known deviation to fix'; the tracked fix is making bind mode an explicit loudly-labeled opt-in. Still present in source.
  - evidence: docs/EDITOR-AUTH-SECURITY.md:53-58; examples/cloudrun/supabase/test/up-local.mjs:48 ZEROPG_WIRE_HOST: '0.0.0.0'; docs/STUDIO-PGMETA-COMPAT.md:63-64
- **verified** Explicitly NOT BUILT, on purpose (fleet doc): no stored registry, no hosted control plane / orchestrator node (a second trust boundary and a credential store someone must secure), no vendor provisioning APIs, and no password/token rotation - 'zeropg has no auth to rotate yet'.
  - evidence: docs/FLEET.md:205-216
- **verified** Client-side encryption (AES-256-GCM, turbolite-style) for the 'untrusted bucket' positioning is a named, unbuilt Track A4 item; DESIGN.md earlier called it 'probably a v2 flag, buckets have SSE anyway'. Bucket-side encryption at rest + customer-managed KMS is the current stance.
  - evidence: TODO.md:220-223; DESIGN.md:276; docs/pglite-stream.md:57
- **verified** The auth-adjacent app work already proven on the wire: self-hosted Supabase (PostgREST + GoTrue + RLS) runs live, with GoTrue needing search_path set on the LIVE session because ALTER ROLE/DATABASE SET search_path does not take effect on the multiplexed session; the demo mints an HS256 anon key and proxies Kong-style so stock supabase-js works unmodified.
  - evidence: examples/cloudrun/supabase/README.md sections 2 and 'Client'; examples/cloudrun/supabase/service.yaml:62
- **likely** An app-level auth reference implementation exists in-repo: the studio's admin auth is bcrypt password + HMAC-signed cookie + session-bound CSRF + login rate limiting + strict route allowlist; zeropocket implements JWT+bcrypt over the wire.
  - evidence: content/posts/09-building-a-studio.md:113; examples/cloudrun/zeropocket/ (per project memory: JWT+bcrypt, pgx cache_describe)
- **verified** The wire/manifest design is otherwise settled and evidence-backed: single writer enforced by conditional-write lease + monotonic fencing tokens embedded in object keys, manifest CAS as THE commit point, three durability modes (strict/interval/sleep). Numbered immutable manifests (to escape GCS's ~1 mutation/sec per object name, measured 52% 429s) are DESIGN-ONLY, not implemented.
  - evidence: DESIGN.md:150-181; TODO.md:158-163 ("A2 **design only** - docs/A2-NUMBERED-MANIFESTS.md, no change to the commit point yet"); STATUS.md:17
- **verified** The prepared-statement fix has written acceptance criteria already: nostr-rs-relay (sqlx) boots with no 42P05 and completes a NIP-01 round-trip; the 5 existing unnamed-statement apps do not regress; and a focused test where two CONCURRENT connections each prepare a statement named s1 and both execute without error.
  - evidence: docs/TODO-pglite-socket-prepared-statements.md:113-121

### Open questions

- Should the monorepo bump @electric-sql/pglite-socket from ^0.2.2 to >=0.2.3 to pick up the SSLRequest 'N' reply? That would retire the sslmode=disable/PGSSLMODE=disable requirement across docs, examples, GRADUATION caveat 2, the PostgREST env comment (packages/server/src/postgrest.ts:80-86), and LIGHT-PG-EDITORS-SURVEY Finding 1 - but nothing in the repo has re-tested Adminer/WhoDB/psql/pg_dump against 0.2.3+ to confirm.
- GSSENCRequest is still unhandled even in pglite-socket 0.2.4. Does any target client (JDBC/DBeaver with gssEncMode, libpq with gssencmode=prefer against a non-local host) actually probe it before SSLRequest, and does that reproduce the same buffered-message hang?
- Which doc wins on the prepared-statement fix scope: TODO-pglite-socket-prepared-statements.md ('bounded, localized handler patch, RECOMMENDED') or POSTGRES-APP-COMPAT.md ('deep architectural change, needs a real wire-protocol parser')? The TODO doc needs to be reconciled or superseded, and its stale simple_protocol advice corrected to cache_describe.
- Would swapping serveWire's backend from pglite-socket to pg-gateway (already a devDependency, already spiked, answers SSLRequest, supports trust/md5/scram + TLS) preserve the transaction-aware QueryQueueManager behavior that makes RLS isolation safe and that issues ROLLBACK on detach? That property is the single biggest regression risk and was never tested against pg-gateway.
- If real wire auth is ever wanted, is pg-gateway's scram-sha-256 + TLS the intended path, and what would the credential store be given there is deliberately no control plane and no rotation mechanism (docs/FLEET.md:213-216)?
- Is the 0.0.0.0 wire bind in examples/cloudrun/supabase/test/up-local.mjs:48 still the intended behavior, or should the tracked fix (explicit, loudly-labeled opt-in bind mode) be done now?
- docs/STATUS-nostr-relay.md contradicts README/POSTGRES-APP-COMPAT on znostr-relay's status - should it be marked superseded rather than left as an in-progress doc?
- docs/ORM-ADAPTER-NOTES.md has a corrupted XML tail at lines 300-301 and a stale 'nothing is concluded / not implemented' header over content that is implemented and concluded. Fix or leave?


## NEON MODEL

Neon's connection story is three separate faces over one proxy: the Postgres wire (TCP 5432), a WebSocket tunnel, and SQL-over-HTTP. All three converge on the same Rust proxy (github.com/neondatabase/neon/proxy), which authenticates and then dials the compute.

Connection string: `postgresql://alex:AbC123dEf@ep-cool-darkness-a1b2c3d4-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require&channel_binding=require`. The only truly mandatory things are TLS itself and a resolvable endpoint id. The endpoint id is the first DNS label (`ep-cool-darkness-a1b2c3d4`); `-pooler` selects PgBouncer; port is 5432 for both. `sslmode=` and `channel_binding=` are client-side hints, not server requirements - you can delete `channel_binding=require` and connections still work (Neon added it to the default string in June 2025).

TLS is hard-required: "Neon rejects connections that do not use SSL/TLS", behaving like a pg_hba.conf with only `hostssl` records. `sslmode=disable` yields `connection is insecure (try using sslmode=require)`. `sslmode=prefer` (libpq's default) is not blocked - the server offers TLS so prefer upgrades - but Neon's own blog argues prefer and even require are near-worthless because neither authenticates the server; they compensate with SCRAM-SHA-256-PLUS channel binding, and advocate a new `sslmode=secure` (verify-full + system roots).

Auth: SCRAM-SHA-256 is the default password encryption for roles; the proxy also speaks SCRAM-SHA-256-PLUS. There is a documented downgrade path - if you smuggle the endpoint id into the password field (`endpoint=ep-x;password`), auth drops to cleartext `password` (still inside TLS). The WebSocket driver does the same by default (`forceDisablePgSSL: true`, `pipelineConnect: 'password'`). No client-certificate/mTLS support is documented anywhere.

SNI: the Postgres startup packet carries no hostname, so the proxy cannot know which compute to route to before auth. Neon reads TLS SNI. Clients without SNI get: `ERROR: The endpoint ID is not specified. Either upgrade the Postgres client library (libpq) for SNI support or pass the endpoint ID ... as a parameter: '&options=endpoint%3D'`.

Two auth layers, cleanly separated. Layer 1 is Postgres role auth (SCRAM/password, `neondb_owner`). Layer 2 is Neon Auth - now "Managed Better Auth" (Stack Auth is the legacy implementation, still supported) - which stores users/sessions in a `neon_auth` schema *inside your database*, issues a JWT with a `sub` claim, and never becomes a Postgres login. Instead the proxy/Data API validates the JWT against a JWKS and connects as the fixed `authenticated` or `anonymous` role, exposing identity to RLS via `pg_session_jwt`'s `auth.user_id()` / `auth.uid()` / `auth.session()`.

The answer to question 6 is unambiguously yes: Neon's HTTP `/sql` endpoint is fully parameterized. Body is `{"query": "...", "params": [...]}` (or `{"queries": [...]}` for a batch). The proxy deserializes params to `Vec<Option<String>>`, converting every JSON value to a Postgres *text* literal, then calls `query_raw_txt(query, params)` - so parameters are bound in text format with server-side type inference (no client-supplied type OIDs). Results come back as text with per-column `dataTypeID`, and node-postgres type parsers run client-side. Credentials travel in a `Neon-Connection-String` header; the endpoint id is parsed from that header URL's hostname, so SNI is irrelevant on the HTTP path.

### Facts

- **verified** Neon's canonical connection string is postgresql://alex:AbC123dEf@ep-cool-darkness-a1b2c3d4-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require&channel_binding=require - role:password, endpoint-id as first DNS label, optional -pooler suffix, region, provider, port 5432 implicit
  - evidence: https://neon.com/docs/connect/connect-from-any-app
- **verified** TLS is mandatory server-side: 'Neon requires that all connections use SSL/TLS encryption' and 'Neon rejects connections that do not use SSL/TLS', behaving like standalone Postgres with only hostssl records in pg_hba.conf
  - evidence: https://neon.com/docs/connect/connect-securely - quoted: "Neon rejects connections that do not use SSL/TLS"
- **verified** Neon documents only three sslmode values: require, verify-ca, verify-full. disable and prefer are not listed as supported modes
  - evidence: https://neon.com/docs/connect/connect-securely (sslmode table lists require/verify-ca/verify-full only)
- **verified** sslmode=disable fails with the Postgres-level error 'connection is insecure (try using `sslmode=require`)'
  - evidence: https://github.com/medusajs/medusa/issues/9985 title: '[Bug]: use Vercel postgress show - error: connection is insecure (try using `sslmode=require`)'; corroborated by https://neon.com/docs/connect/connection-errors
- **likely** sslmode=prefer is not blocked by Neon - since the server offers TLS, prefer negotiates TLS successfully - but it provides no server authentication. Neon's own blog calls it out: 'sslmode=prefer is the default purely for backward-compatibility reasons: the Postgres docs themselves admit that it makes little other sense'
  - evidence: https://neon.com/blog/postgres-needs-better-connection-security-defaults
- **verified** Neon argues sslmode=require gives 'barely any security at all' because it does not authenticate the server, and proposes a new sslmode=secure meaning verify-full plus system root certificates
  - evidence: https://neon.com/blog/postgres-needs-better-connection-security-defaults
- **verified** Neon's server certificate is issued by Let's Encrypt (ISRG Root X1), so sslrootcert can point at the OS trust store (e.g. /etc/ssl/certs/ca-certificates.crt on Debian, /etc/ssl/cert.pem on macOS)
  - evidence: https://neon.com/docs/connect/connect-securely
- **verified** channel_binding=require is a client-side parameter, added to Neon's default connection strings in June 2025; it forces SCRAM-SHA-256-PLUS. It is NOT mandatory - clients that do not support it can simply delete '&channel_binding=require'
  - evidence: https://neon.com/docs/changelog/2025-06-27 and https://neon.com/docs/connect/connect-securely: "channel_binding=require ... ensures the client and server mutually authenticate each other using SCRAM-SHA-256-PLUS"
- **likely** Go's pgdriver breaks on channel_binding because it tries to SET channel_binding TO 'require' after connecting; most non-libpq drivers silently ignore the parameter
  - evidence: https://neon.com/blog/postgres-needs-better-connection-security-defaults
- **verified** Neon changed the default password_encryption for roles to scram-sha-256; the proxy supports both SCRAM-SHA-256 and SCRAM-SHA-256-PLUS
  - evidence: https://neon.com/docs/changelog/2023-07-06 and https://neon.com/blog/postgres-needs-better-connection-security-defaults
- **likely** No client-certificate / mTLS authentication is documented. The security overview covers TLS 1.2/1.3, IP allowlist, AWS PrivateLink, API keys, SOC2/ISO27001 - but never sslcert/sslkey or mutual TLS
  - evidence: https://neon.com/docs/security/security-overview (no mention of client certs); https://neon.com/docs/connect/connect-securely covers only server-cert verification
- **verified** SNI is required because the Postgres wire protocol carries no hostname: 'the Postgres wire protocol does not transfer domain name information', so the proxy uses the TLS SNI extension to learn the compute id before the startup packet arrives
  - evidence: https://neon.com/docs/connect/connectivity-issues
- **verified** The exact SNI failure is: 'ERROR: The endpoint ID is not specified. Either upgrade the Postgres client library (libpq) for SNI support or pass the endpoint ID (the first part of the domain name) as a parameter: \'&options=endpoint%3D\'.'
  - evidence: https://neon.com/docs/connect/connection-errors
- **verified** Four SNI workarounds: (A) ?options=endpoint%3D[endpoint-id]; (B) libpq dbname field 'dbname=neondb options=endpoint=[endpoint_id]'; (C) Go clients set sslmode=verify-full to make the driver send SNI; (D) prefix the password with 'endpoint=<id>;' or 'endpoint=<id>$'
  - evidence: https://neon.com/docs/connect/connectivity-issues and https://neon.com/docs/connect/connection-errors
- **verified** The password-field workaround is an explicit auth downgrade: it 'causes the authentication method to be downgraded from scram-sha-256 ... to password', though the connection remains TLS-encrypted. Neon states it intends to deprecate these fallbacks once SNI support is universal
  - evidence: https://neon.com/docs/connect/connectivity-issues
- **likely** The 'options=project=' form is the deprecated predecessor of 'options=endpoint=', still supported for backward compatibility
  - evidence: https://neon.com/docs/changelog/2023-05-16
- **verified** Neon Auth is now 'Managed Better Auth'; Stack Auth is the legacy implementation. 'If you're using the previous Neon Auth implementation via Stack Auth, your version will continue to work.'
  - evidence: https://neon.com/docs/auth/overview
- **verified** Neon Auth stores identity IN your database: 'All authentication data is stored in the neon_auth schema. It's queryable with SQL and compatible with Row Level Security (RLS) policies.' Tables include neon_auth.user, neon_auth.account, neon_auth.session
  - evidence: https://neon.com/docs/auth/overview and https://neon.com/docs/auth/authentication-flow
- **verified** Neon Auth JWTs never become Postgres roles. The session cookie is __Secure-neonauth.session_token; the SDK sends 'Authorization: Bearer <jwt>' to the Data API, which 'validates JWT signature using JWKS public keys' and 'extracts user ID from JWT and makes it available to RLS policies'
  - evidence: https://neon.com/docs/auth/authentication-flow
- **verified** The database layer has two fixed roles for the JWT path - authenticated and anonymous - created by the integration; RLS policies are written FOR authenticated USING (auth.user_id() = user_id)
  - evidence: https://neon.com/docs/data-api/get-started - "CREATE POLICY manage_own_posts ON posts FOR ALL TO authenticated USING (auth.user_id() = user_id) WITH CHECK (auth.user_id() = user_id);"
- **verified** pg_session_jwt exposes auth.user_id() (sub as text), auth.uid() (sub as uuid), auth.session()/auth.jwt() (full payload as JSONB), auth.init() and auth.jwt_session_init()
  - evidence: https://neon.com/docs/extensions/pg_session_jwt
- **verified** pg_session_jwt has two modes and only one is tamper-proof: with a configured JWK the extension validates signatures; in PostgREST-compatible fallback mode 'request.jwt.claims is a regular Postgres parameter that can be modified by any database user'
  - evidence: https://neon.com/docs/extensions/pg_session_jwt
- **verified** The Neon Data API is PostgREST-compatible ('fully compatible with PostgREST'), served over HTTP, JWT-only for access control, currently Beta
  - evidence: https://neon.com/docs/data-api/overview and https://neon.com/docs/data-api/get-started: "The Data API uses JWTs for access control."
- **verified** The serverless driver's HTTP endpoint is derived by replacing the first hostname label (the endpoint id) with 'api.' - or 'apiauth.' when a JWT is supplied - and appending /sql: fetchEndpoint: (host, _port, options) => { ... newHost = host.replace(FIRST_WORD_REGEX, options?.jwtAuth ? 'apiauth.' : 'api.'); return 'https://' + newHost + '/sql'; }
  - evidence: https://github.com/neondatabase/serverless/blob/main/src/shims/net/index.ts lines 119-131
- **verified** HTTP requests are POST with headers: 'Neon-Connection-String': connectionString, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true', optionally 'Authorization': `Bearer ${validAuthToken}`, and for batches 'Neon-Batch-Isolation-Level' / 'Neon-Batch-Read-Only' / 'Neon-Batch-Deferrable'
  - evidence: https://github.com/neondatabase/serverless/blob/main/src/httpQuery.ts lines 350-370
- **verified** YES - the HTTP /sql endpoint fully supports bound parameters. Request body is {query: string, params: any[]} for a single query or {queries: [...]} for a batch; the driver builds it via prepareQuery(): 'return { query, params: params.map((param) => encodeBuffersAsBytea(prepareValue(param))) }'
  - evidence: https://github.com/neondatabase/serverless/blob/main/src/httpQuery.ts lines 101-109 and 292-294
- **verified** Server side, the proxy deserializes params as Vec<Option<String>> - every parameter is converted to its Postgres TEXT representation before binding. json_value_to_pg_text maps Null->None, Bool/Number/Object->to_string(), String->as-is, Array->Postgres array literal '{1,"2",3}'
  - evidence: neondatabase/neon proxy/src/serverless/sql_over_http.rs struct QueryData { query: String, params: Vec<Option<String>>, array_mode: Option<bool> } and proxy/src/serverless/json.rs json_value_to_pg_text
- **verified** The proxy executes via client.query_raw_txt(&data.query, data.params) - i.e. parameters are bound in TEXT format with NO client-supplied type OIDs, so Postgres does the type inference. Results are returned with format 'text' and per-column dataTypeID, and node-postgres type parsers run client-side (that is why Neon-Raw-Text-Output: true is always sent)
  - evidence: neondatabase/neon proxy/src/serverless/sql_over_http.rs query_to_json(): '.query_raw_txt(&data.query, data.params)' and json_field.entry("format", "text")
- **verified** The proxy parses the endpoint id from the hostname INSIDE the Neon-Connection-String header (first DNS label), not from TLS SNI - so the HTTP path sidesteps the SNI problem entirely
  - evidence: neondatabase/neon proxy/src/serverless/http_util.rs get_conn_info(): 'let endpoint: EndpointId = match connection_url.host() { Some(url::Host::Domain(hostname)) => hostname.split_once('.').map_or(hostname, |(prefix, _)| prefix).into(), ... }'
- **verified** Password auth and JWT auth on the HTTP endpoint are mutually exclusive per-deployment: if config.accept_jwts is set, a password in the connection string is rejected with MissingCredentials(BearerJwt), and vice versa. This is why the driver switches to apiauth.* when authToken is present
  - evidence: neondatabase/neon proxy/src/serverless/http_util.rs get_conn_info() lines 179-206
- **verified** The serverless driver validates the connection string client-side and requires scheme postgres:/postgresql:, a username, a hostname and a path: 'Database connection string format for `neon()` should be: postgresql://user:password@host.tld/dbname?option=value'. sslmode is NOT required by the driver (the transport is HTTPS)
  - evidence: https://github.com/neondatabase/serverless/blob/main/src/httpQuery.ts lines 218-228
- **verified** Parameterized query APIs: tagged template sql`SELECT * FROM posts WHERE id = ${postId}` (auto $1/$2), sql.query('SELECT $1 || \' \' || $2 AS greeting', [h, w], opts) for manual placeholders, and sql.unsafe(rawSql) for trusted identifiers. Templates are composable (a sql`` fragment can be embedded in another)
  - evidence: https://github.com/neondatabase/serverless/blob/main/src/httpQuery.ts doc comment examples 1-5; https://neon.com/docs/serverless/serverless-driver
- **verified** sql.query() was added in driver 1.0.0 (2025-03-25); authToken/JWT support was added in 0.10.0 (2024-10-07). Before 1.0.0 the template function could not be called as a plain function
  - evidence: https://github.com/neondatabase/serverless/blob/main/CHANGELOG.md
- **verified** HTTP mode supports non-interactive batch transactions via sql.transaction([...], { isolationLevel: 'RepeatableRead', readOnly: true, deferrable: false }); interactive sessions/transactions require the WebSocket Pool/Client. Max request/response size is 64 MB
  - evidence: https://neon.com/docs/serverless/serverless-driver; proxy enforces config.http_config.max_request_size_bytes and max_response_size_bytes in sql_over_http.rs
- **verified** Over WebSockets the driver deliberately disables Postgres-native TLS and downgrades to cleartext password auth inside the wss tunnel: defaults are useSecureWebSocket: true, forceDisablePgSSL: true, pipelineConnect: 'password'
  - evidence: https://github.com/neondatabase/serverless/blob/main/src/shims/net/index.ts lines 137-140; https://neon.com/blog/quicker-serverless-postgres describes replacing SCRAM-SHA-256 with 'simple password auth (which is still protected by TLS encryption)'
- **verified** Role passwords are auto-generated on creation via Console/CLI/API: 'The role is created and you are provided with the password for the role.' Passwords 'must be supplied in plain text but are encrypted when stored. Hashed passwords are not supported.' Minimum entropy 60 bits
  - evidence: https://neon.com/docs/manage/roles
- **verified** There is no automatic rotation. Rotation = password reset, via Console (generates a new value), the Neon API endpoint resetprojectbranchrolepassword, or ALTER USER ... WITH PASSWORD. 'A password reset takes effect immediately. The old password stops working on the next connection.'
  - evidence: https://neon.com/docs/manage/roles and https://api-docs.neon.tech/reference/resetprojectbranchrolepassword
- **likely** Neon's recommended zero-downtime rotation is a parallel role: create a second role, grant it the old role's access, migrate consumers one service at a time while both connection strings work
  - evidence: https://neon.com/docs/manage/roles (Rotate credentials section)
- **verified** Default owner role is neondb_owner, named after the project's default database; protected branches auto-generate passwords for new roles; Neon is a GitHub Secret Scanning partner for leaked connection strings
  - evidence: https://neon.com/docs/manage/roles and https://neon.com/docs/security/security-overview
- **verified** The pooled endpoint (-pooler, PgBouncer) rejects most startup parameters: 'unsupported startup parameter: <...>' - only client_encoding, datestyle, timezone, standard_conforming_strings and application_name are permitted
  - evidence: https://neon.com/docs/connect/connection-errors

### Open questions

- Does Neon's proxy answer the Postgres SSLRequest with 'N' (allowing a plaintext downgrade attempt that later fails at auth) or does it terminate immediately? This determines whether sslmode=prefer silently succeeds over TLS or produces a confusing error - relevant to the known serveWire SSLRequest hang in zeropg. Not documented; would need a live probe against a Neon endpoint.
- Are the Neon-Batch-* headers the only way to control transaction semantics over HTTP, or does the /sql endpoint accept BEGIN/COMMIT inline in a single query string? The proxy uses query_raw_txt (extended protocol), which normally forbids multi-statement strings - unverified.
- What exact type-inference failures does the text-only parameter binding produce? Because Neon sends no parameter type OIDs, queries like `SELECT $1` or `WHERE col = $1` on ambiguous columns may error with 'could not determine data type of parameter $1'. Worth testing before copying the design.
- Does Neon's HTTP endpoint enforce any rate limit or per-request auth caching (repeated SCRAM against the compute per request vs pooled connection reuse)? conn_pool_lib.rs suggests pooling with allow_pool opt-in, but the caching semantics for credentials were not traced.
- Is client-certificate auth genuinely unsupported or merely undocumented? No Neon doc mentions sslcert/sslkey; a definitive answer would need a support statement or a live test.
- How does the Data API's anonymous role work without a JWT - is there a Supabase-style anon key, or are unauthenticated requests simply mapped to the anonymous role with no token? The get-started doc implies JWT-only but names an anonymous role.


## SUPABASE MODEL

Supabase exposes four Postgres endpoints, all with the SAME password but different hosts/ports/usernames: direct `postgresql://postgres:[YOUR-PASSWORD]@db.<ref>.supabase.co:5432/postgres` (IPv6-only unless you buy the IPv4 add-on); Supavisor shared pooler session mode `postgres://postgres.<ref>:[PW]@aws-<region>.pooler.supabase.com:5432/postgres` (IPv4, prepared statements OK); Supavisor transaction mode, same host on `:6543` (IPv4, "does not support prepared statements"); and a paid dedicated PgBouncer at `db.<ref>.supabase.co:6543`. The pooler encodes the tenant in the USERNAME (`postgres.<project_ref>`) because there is no per-tenant hostname. None of the connection strings Supabase ships contain an `sslmode` param.

TLS is OPTIONAL by default and this is deliberate: "Your Supabase project supports connecting to the Postgres DB without SSL enabled to maximize client compatibility." Their `pg_hba.conf` uses `host all all 0.0.0.0/0 scram-sha-256` (not `hostssl`), and `password_encryption = scram-sha-256`. A dashboard/API/CLI toggle ("Enforce SSL on incoming connections") flips it on (and reboots the DB). They DO ship a CA cert (`prod-ca-2021.crt`, downloadable from Database Settings → SSL Configuration) and document `sslmode=verify-full sslrootcert=...` as the recommended mode, but nothing forces you there. HTTP APIs (PostgREST/Auth/Storage) always enforce SSL.

Auth is three stacked layers that people constantly conflate. (1) Postgres role auth: the `postgres` superuser password is generated/typed at project creation, "for security reasons, your database password is never shown" again, and the only recovery is Reset Password in Database Settings; SCRAM-SHA-256 on the wire. (2) API-key layer answers "WHAT is calling" - publishable `sb_publishable_...` (legacy `anon` JWT) and secret `sb_secret_...` (legacy `service_role` JWT). (3) GoTrue/Supabase Auth answers "WHO", minting a short-lived per-user JWT whose `role` claim is literally "The Postgres role to use when applying Row Level Security policies." PostgREST connects as `authenticator` (very limited), verifies the JWT, and does `SET LOCAL ROLE` into `anon` / `authenticated` / `service_role`, exposing claims via `current_setting('request.jwt.claims')` which `auth.uid()`/`auth.jwt()` read. RLS is the actual enforcement; `service_role` has `BYPASSRLS`. So the key never becomes a Postgres password - it becomes a role switch.

For a naive `new Pool({connectionString: DATABASE_URL})`: it "works" in the worst way. `pg` defaults to `ssl: false`, and since Supabase's copied string has no `sslmode` and their hba allows non-SSL, you get a silent PLAINTEXT connection across the public internet with a superuser password. If you're on Vercel/GH Actions/most Docker and use the direct string you instead get `ENETUNREACH` (IPv6). If you "fix" it by appending `?sslmode=require`, pg-connection-string (non-libpq-compat, the default) sets `ssl = {}` with `rejectUnauthorized` left at Node's true, so verification runs against system roots and Supabase's private CA fails with SELF_SIGNED_CERT_IN_CHAIN - which the internet answers with `rejectUnauthorized: false`, i.e. back to unverified. And if you pointed at :6543 with a driver that names statements, you get prepared-statement errors.

### Facts

- **verified** Supabase direct connection string is postgresql://postgres:[YOUR-PASSWORD]@db.<project-ref>.supabase.co:5432/postgres and is IPv6-only unless the IPv4 add-on is bought
  - evidence: connecting-to-postgres.mdx: "| Direct connection | `db.[project-id].supabase.co:5432` | IPv6 | IPv6 | IPv4 |" and "Direct connections are on IPv6, or on IPv4 if the project has the IPv4 add-on. If your network is IPv4-only and you don't have the add-on, use pooler session mode instead." https://supabase.com/docs/guides/database/connecting-to-postgres
- **verified** Supavisor session mode = aws-[REGION].pooler.supabase.com:5432 with username postgres.<project_ref>; transaction mode = same host on :6543. Tenant is encoded in the username, not the hostname.
  - evidence: connecting-to-postgres.mdx: "postgres://postgres.apbkobhfnmcqqzqeeqss:[YOUR-PASSWORD]@aws-[REGION].pooler.supabase.com:5432/postgres" and "...@aws-[REGION].pooler.supabase.com:6543/postgres"
- **verified** Transaction mode (6543) does not support prepared statements; docs tell you to turn them off per-library
  - evidence: connecting-to-postgres.mdx admonition: "Transaction mode does not support prepared statements. To avoid errors, turn off prepared statements for your connection library." -> https://github.com/orgs/supabase/discussions/28239 (Prisma `?pgbouncer=true`, Drizzle `{ prepare: false }`, asyncpg `statement_cache_size=0`, psycopg `prepare_threshold=None`)
- **verified** Both Supavisor modes share ONE pool-size budget; session and transaction ports draw from the same limit
  - evidence: connecting-to-postgres.mdx FAQ: "These connections are shared between the session mode port (5432) and the transaction mode port (6543). Each mode can use up to 30 connections independently, or split them between both, but the total combined connections across both modes cannot exceed 30."
- **verified** A paid Dedicated Pooler (PgBouncer) exists at db.<ref>.supabase.co:6543, transaction mode only
  - evidence: connecting-to-postgres.mdx: "postgres://postgres:[YOUR-PASSWORD]@db.abcdefghijklmnopqrst.supabase.co:6543/postgres" ... "The Dedicated Pooler runs in transaction mode only"
- **verified** TLS is OPTIONAL by default on Supabase Postgres - non-SSL connections are explicitly allowed for client compatibility
  - evidence: ssl-enforcement.mdx line 6: "Your Supabase project supports connecting to the Postgres DB without SSL enabled to maximize client compatibility. For increased security, you can prevent clients from connecting if they're not using SSL." https://supabase.com/docs/guides/platform/ssl-enforcement
- **verified** Supabase's shipped pg_hba uses `host` (SSL-optional) with scram-sha-256 for all internet addresses, and password_encryption = scram-sha-256
  - evidence: https://raw.githubusercontent.com/supabase/postgres/develop/ansible/files/postgresql_config/pg_hba.conf.j2 -> `host all all 0.0.0.0/0 scram-sha-256` and `host all all ::0/0 scram-sha-256`; postgresql.conf.j2 line 96: `password_encryption = scram-sha-256`
- **verified** None of the connection strings Supabase publishes in the connect docs carry an sslmode parameter
  - evidence: All four connection-string code blocks in connecting-to-postgres.mdx end in `/postgres` with no query string; the only sslmode appears in the psql/SSL-enforcement pages as a manual add-on
- **verified** Supabase ships a private CA cert (prod-ca-2021.crt) for verify-full, downloadable from Database Settings -> SSL Configuration
  - evidence: ssl-enforcement.mdx: "To use `verify-full` you will need to download the Supabase CA certificate for your database. The certificate is available through the dashboard under the SSL Configuration section in the Database Settings page." plus `cat {location of downloaded prod-ca-2021.crt} >> ~/.postgres/root.crt`
- **verified** Supabase documents verify-full as the recommended mode when SSL enforcement is enabled, including for the pooler host
  - evidence: ssl-enforcement.mdx: "psql \"postgresql://aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=verify-full\" -U postgres.<user>"; psql.mdx: "psql \"sslmode=verify-full sslrootcert=/path/to/prod-supabase.cer host=[CLOUD_PROVIDER]-0-[REGION].pooler.supabase.com dbname=postgres user=postgres.[PROJECT_REF]\""
- **verified** SSL enforcement covers direct Postgres, Supavisor and PgBouncer, but the HTTP APIs always enforce SSL regardless
  - evidence: ssl-enforcement.mdx line 8: "Disabling SSL enforcement only applies to connections to Postgres, Supavisor (shared Connection Pooler) and PgBouncer (dedicated Connection Pooler); all HTTP APIs offered by Supabase (e.g., PostgREST, Storage, Auth) automatically enforce SSL on all incoming connections."
- **verified** The postgres database password is set at project creation and NEVER shown again; the only recovery is a reset in Database Settings
  - evidence: Supabase collaborator in https://github.com/orgs/supabase/discussions/33000 : "For security reasons, your database password is never shown." ... "You need to go reset it in the dashboard Settings, Database tab."; docs troubleshooting oTs5sB: "You can reset your database password from the Database > Settings section of the Dashboard."
- **verified** Default Supabase Postgres roles: postgres (admin), authenticator (limited, used by PostgREST to validate JWT and change into another role), anon, authenticated, service_role (bypasses RLS), supabase_auth_admin, supabase_storage_admin, dashboard_user, supabase_admin
  - evidence: https://supabase.com/docs/guides/database/postgres/roles - "authenticator: A special role for the API (PostgREST). It has very limited access, and is used to validate a JWT and then 'change into' another role determined by the JWT verification."
- **verified** The JWT `role` claim IS the Postgres role - that is the whole bridge between GoTrue and Postgres
  - evidence: https://supabase.com/docs/guides/auth/jwts - claim table: "`role` | The Postgres role to use when applying Row Level Security policies."
- **verified** PostgREST connects as authenticator and issues SET LOCAL ROLE from the JWT role claim, exposing claims via current_setting('request.jwt.claims')
  - evidence: https://docs.postgrest.org/en/v12/references/auth.html - "When a request contains a valid JWT with a role claim PostgREST will switch to the database role with that name"; claims read via current_setting('request.jwt.claims', true)::json
- **verified** Key -> Postgres role mapping: publishable/anon key + no user = `anon`; publishable/anon key + logged-in user = `authenticated`; secret/service_role key = `service_role` with BYPASSRLS
  - evidence: api-keys.mdx table: "| Publishable key | No | `anon` | Publishable key | Yes | `authenticated` |" and "Secret keys authorize access to your project's data via the built-in `service_role` Postgres role... It also uses the `BYPASSRLS` attribute, skipping any and all Row Level Security policies you attach." https://supabase.com/docs/guides/getting-started/api-keys
- **verified** API keys answer 'what' is connecting, Supabase Auth answers 'who' - two separate layers by design
  - evidence: api-keys.mdx: "| API keys | **What** is accessing the project? | Web page, mobile app, server, Edge Function... | | Supabase Auth | **Who** is accessing the project? | Monica, Jian Yang... |"
- **verified** New non-JWT keys (sb_publishable_..., sb_secret_...) replaced the legacy anon/service_role JWTs in 2025; legacy keys still work until explicitly disabled
  - evidence: api-keys.mdx types table + "Creating publishable and secret keys adds them alongside your existing `anon` and `service_role` keys without affecting them"; https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
- **verified** RLS is the actual security boundary for the browser-facing API; Supabase says the anon key is safe to expose only because RLS restricts anon/authenticated
  - evidence: row-level-security.mdx: "Supabase allows convenient and secure data access from the browser, as long as you enable RLS" and "RLS must always be enabled on any tables stored in an exposed schema"; api-keys.mdx: "access to your project's data is guarded by Postgres via the built-in `anon` and `authenticated` roles. For full protection make sure: You have enabled Row Level Security on all tables."
- **verified** node-postgres defaults to ssl: false, so `new Pool({connectionString: <supabase string>})` opens a PLAINTEXT connection carrying the superuser password over the internet
  - evidence: /Users/user/workspace/blob-pglite/node_modules/pg/lib/defaults.js:50 `ssl: false`; connection-parameters.js:85 `this.ssl = typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl` which falls through to defaults.ssl when PGSSLMODE is unset. Combined with Supabase's `host ... scram-sha-256` hba, the server accepts it.
- **verified** Appending ?sslmode=require to a Supabase URL in node-postgres produces SELF_SIGNED_CERT_IN_CHAIN, because pg-connection-string (non-libpq-compat, the default) leaves rejectUnauthorized at Node's true and Supabase's cert chains to a private CA
  - evidence: /Users/user/workspace/blob-pglite/node_modules/pg-connection-string/index.js:77 `if (... || config.sslmode) { config.ssl = {} }` then lines 133-146: `case 'prefer': case 'require': case 'verify-ca': case 'verify-full': { if (config.sslmode !== 'verify-full') deprecatedSslModeWarning(...) }` - no rejectUnauthorized:false. Field reports: https://www.answeroverflow.com/m/1324121826359771176 , https://community.fly.io/t/error-self-signed-certificate-in-certificate-chain-when-using-supabase-connection-string/22977
- **likely** The common internet fix for that error is ssl: { rejectUnauthorized: false }, i.e. encryption without authentication - MITM-able
  - evidence: https://github.com/brianc/node-postgres/issues/2558 and multiple Supabase/Drizzle/n8n threads recommending rejectUnauthorized: false
- **verified** Naive direct-connection use from IPv4-only platforms (Vercel, many CI runners) fails with ENETUNREACH before TLS is even a question
  - evidence: connecting-to-postgres.mdx IPv6 admonition + https://github.com/n8n-io/n8n/issues/15239 "connect ENETUNREACH 2600:1f1e:75b:4b01:...:5432"; Supabase FAQ: "The Shared Pooler (Supavisor) is IPv4-only on every project tier"
- **likely** Supabase local dev (CLI) uses postgresql://postgres:postgres@127.0.0.1:54322/postgres - a hardcoded trivial password, and the dashboard cannot reset passwords for CLI/local-dev or self-hosted
  - evidence: Supabase CLI docs / db reference; troubleshooting note "It is not possible to change the password in the UI for CLI/local-dev and self-hosted Supabase."
- **verified** zeropg's Supabase example reproduces the same role model in bootstrap.sql but with NO password and sslmode=disable, because everything is loopback inside one Cloud Run service
  - evidence: /Users/user/workspace/zeropg/examples/cloudrun/supabase/service.yaml:62 GOTRUE_DB_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable&statement_cache_mode=describe"; /Users/user/workspace/zeropg/examples/cloudrun/supabase/zeropg-db/bootstrap.sql creates anon/authenticated/service_role (BYPASSRLS) and GRANTs them to postgres so PostgREST can SET ROLE
- **verified** On zeropg, PostgREST uses `postgres` as the authenticator rather than a separate limited role, and the shared single PGlite session forced PGRST_DB_PREPARED_STATEMENTS=false + PGRST_DB_POOL=1 and GoTrue DSN statement_cache_mode=describe
  - evidence: /Users/user/workspace/zeropg/examples/cloudrun/supabase/README.md lines 26-34 and bootstrap.sql comment "PostgREST connects as `postgres` (the authenticator here) and SET ROLEs into these from the JWT"
- **verified** RLS was proven safe on zeropg's multiplexed single session because pglite-socket's QueryQueueManager is transaction-aware (won't interleave other handlers mid-transaction)
  - evidence: /Users/user/workspace/zeropg/examples/cloudrun/supabase/README.md lines 42-47: "Proven with a 2s held transaction + 100 concurrent cross-user reads = zero bleed. test/killswitch-rls-isolation.mjs"
- **verified** zeropg's example mints the anon key itself as an HS256 JWT with role=anon signed with the shared GOTRUE_JWT_SECRET - i.e. the legacy Supabase key model, not the new sb_publishable_ model
  - evidence: /Users/user/workspace/zeropg/examples/cloudrun/supabase/frontend/server.mjs:42-50 `const ANON_KEY = signJwt({ role: 'anon' })` with createHmac('sha256', JWT_SECRET)
- **verified** zeropg previously found that a wire server which never answers SSLRequest hangs libpq/pgx clients whose default sslmode is `prefer` - directly relevant since Supabase's docs table confirms prefer is the libpq default
  - evidence: memory note servewire-sslrequest-hang.md; ssl-enforcement.mdx SSL-mode table: "`prefer` | Optional | ... | Tries an SSL connection first; falls back to non-SSL if the server doesn't support it. This is the default."

### Open questions

- Is the cert presented on aws-<region>.pooler.supabase.com still signed by Supabase's private CA (prod-ca-2021), or has it moved to a publicly-trusted CA? Sources conflict; a live `openssl s_client -connect aws-0-us-east-1.pooler.supabase.com:6543 -starttls postgres` would settle it and determines whether sslmode=verify-full works with system roots.
- Do NEW Supabase projects (2026) default 'Enforce SSL on incoming connections' to ON? The docs still read as if OFF is the default, but the default may have changed for new projects.
- Is the downloadable CA still literally named prod-ca-2021.crt, and is there a newer root (prod-ca-2025 / regional roots) for projects created after the 2021 CA's issuance?
- How exactly does Supavisor terminate TLS and re-auth to Postgres - does it re-run SCRAM against the backend, or use auth_query + cached credentials? (relevant to whether a pooler compromise exposes password verifiers)
- Does the dashboard 'Connect' modal inject sslmode/ssl options into the framework-specific tabs (Prisma, Drizzle, SQLAlchemy) even though the raw strings in docs have none? Needs a logged-in dashboard look.
- What does Supabase do about the `postgres` role being the connection user for direct connections - is it a true superuser, or has it been de-privileged (they mention supabase_admin as the internal admin)? Affects how bad a leaked DATABASE_URL is.


## WIRE PROTOCOL v3 SERVER + EXISTING LIBRARIES

pg-gateway is real and it is the decisive finding: https://github.com/supabase-community/pg-gateway by Greg Richardson (gregnr), MIT, 260 stars, npm `pg-gateway`. It is a full server-side Postgres v3 frontend (framing, SSLRequest/TLS upgrade, startup params, auth) that hands post-auth bytes to a hook - exactly the shape needed to front PGlite, and its own examples front PGlite. But the maturity picture is split. `main` is frozen at v0.2.4 (July 2024) and only has cleartext/md5/cert auth; that stale README is what web search returns and why every summary claims "no SCRAM". The real code lives on the unmerged branch `next` (PR #21 "Next v0.3.0", open since 2024-09-13, 139 commits, 74 files), published only as `0.3.0-beta.4` on 2024-12-23 and untouched for 19 months. That beta DOES implement SCRAM-SHA-256 (auth/sasl/scram-sha-256.ts, 275 LOC + sasl-mechanism 39 + crypto 120), web/deno/node platform adapters, and SNI. It is not a toy: firebase-tools 15.24.0 depends on `pg-gateway@^0.3.0-beta.4`, driving 7.2M npm downloads/month (up from 1.4k in Jan 2025); windmill, netlify/primitives, nocodb/sql-control and supabase-community/database-build also use it. This repo already has it in devDependencies and already spiked it (experiments/prisma-spike/pggw.ts); docs/ORM-ADAPTER-NOTES.md already recommends swapping serveWire onto it.

I verified it live against real libpq (psql 18.4) with a self-signed CA, TLS, and scram-sha-256: sslmode=require works, sslmode=verify-full works, sslmode=disable is correctly rejected with 08P01, and a wrong password yields the standard FATAL "password authentication failed". sslmode=require validates nothing when no sslrootcert is given (self-signed accepted); with sslrootcert set it validates like verify-ca, per libpq's documented back-compat. channel_binding=require fails (only SCRAM-SHA-256 is advertised, never -PLUS) but that is harmless since libpq's default is `prefer`.

Three real defects found by probing. (1) A client that rejects the server cert (TLS alert unknown_ca) triggers an unhandled ERR_INVALID_STATE "WritableStream is locked" at connection.ts:228 and kills the whole Node process - reproducible, remote, trivially triggerable. (2) A protocol 3.2 startup (PG18 libpq with max_protocol_version=latest) hits `Unexpected initial message`; there is no NegotiateProtocolVersion. (3) It never sends BackendKeyData, and CancelRequest (80877102) falls into the same `Unexpected initial message` throw (it does close with zero bytes written, which is accidentally close to spec).

Q6 is settled empirically. I built the rewriter in ~45 lines over pg-gateway plus one shared PGlite: without it, connection B preparing `s1` fails with 42P05; with Parse/Bind/Describe/Close/Execute names prefixed per connection, both connections prepare `s1` and A's statement still resolves afterwards. Caveats: SQL-level PREPARE/DEALLOCATE bypass the rewriter (26000), and `pg_prepared_statements` exposes the prefixed name. Also note pg-gateway has zero cross-connection serialization - swapping serveWire off pglite-socket would lose its transaction-aware QueryQueueManager, which is what makes the Supabase RLS story safe today.

### Facts

- **verified** pg-gateway exists, is MIT-licensed, authored by Greg Richardson (gregnr) under supabase-community, and is described as "Postgres wire protocol for the server-side"
  - evidence: https://github.com/supabase-community/pg-gateway ; `npm view pg-gateway`: license = 'MIT', maintainers = [ 'gregnr <greg.nmr@gmail.com>' ], description = 'Postgres wire protocol for the server-side'
- **verified** Latest npm release is 0.3.0-beta.4, published 2024-12-23; there has been no npm release since (19 months as of 2026-07-28)
  - evidence: `npm view pg-gateway --json`: dist-tags.latest = 0.3.0-beta.4, time['0.3.0-beta.4'] = '2024-12-23T20:00:15.751Z', modified = '2024-12-23T20:00:15.938Z'
- **verified** The GitHub default branch `main` is stale at v0.2.4 (2024-07-27) and contains NO SCRAM support - this is why the README and every web-search summary claim only cleartextPassword/md5Password/certificate auth
  - evidence: git log on main: `b5e542d 2024-07-27 v0.2.4` is the newest code commit (the only later commit is `5d3571b 2026-05-12 chore: add minimum release age protection`); main's src tree is just connection.ts, index.ts, util.ts - no auth/ directory
- **verified** SCRAM-SHA-256 IS implemented, on the unmerged `next` branch and shipped in the 0.3.0-beta.4 npm tarball
  - evidence: branch `next` contains packages/pg-gateway/src/auth/sasl/scram-sha-256.ts (275 lines) and src/auth/sasl/sasl-mechanism.ts (39 lines); AuthenticationSASL=10, AuthenticationSASLContinue=11, AuthenticationSASLFinal=12 encoded in sasl-mechanism.ts
- **verified** The 0.3.0 line has never been merged: PR #21 "Next v0.3.0" (head `next` -> base `main`) is still OPEN, created 2024-09-13, 139 commits, 74 changed files
  - evidence: gh api repos/supabase-community/pg-gateway/pulls/21 -> {"base":"main","changed":74,"commits":139,"created":"2024-09-13T22:26:56Z","head":"next","state":"open","title":"Next v0.3.0"}
- **verified** Repo is effectively dormant but not archived: 260 stars, 4 open issues, last push 2026-05-12 which was only a dependency-hygiene chore
  - evidence: gh api repos/supabase-community/pg-gateway -> {"archived":false,"license":"MIT","open_issues":4,"pushed_at":"2026-05-12T23:43:49Z","stars":260}
- **verified** Despite being pre-1.0 and dormant, pg-gateway has real production usage: firebase-tools 15.24.0 depends on pg-gateway ^0.3.0-beta.4, and downloads have grown to 7.24M/month
  - evidence: `npm view firebase-tools dependencies.pg-gateway` -> '^0.3.0-beta.4'; npm downloads/range: 2025-01 = 1,447 -> 2026-07 = 7,236,635; last-month point = 8,337,859
- **verified** Other GitHub repos depending on pg-gateway include windmill-labs/windmill, netlify/primitives, nocodb/sql-control, supabase-community/database-build (postgres.new), coder/blink, constructive-io/constructive
  - evidence: gh api search/code q='"pg-gateway" in:file filename:package.json' -> 54 hits including those repos
- **verified** LIVE VERIFIED: pg-gateway 0.3.0-beta.4 + PGlite 0.5.2 + TLS (self-signed CA) + scram-sha-256 accepts real libpq (psql 18.4) at sslmode=require
  - evidence: psql "host=127.0.0.1 port=54329 user=postgres sslmode=require" -c "select version()" returned 'PostgreSQL 18.3 (PGlite 0.5.2) on wasm32-unknown-linux-gnu'
- **verified** LIVE VERIFIED: the same server also satisfies sslmode=verify-full when the client pins the generated CA and connects to host=localhost (cert SAN DNS:localhost,IP:127.0.0.1)
  - evidence: psql "host=localhost port=54329 sslmode=verify-full sslrootcert=<scratchpad>/certs/ca.crt" -c "select 1 as ok" -> 1 row
- **verified** sslmode=require validates NOTHING by itself: a self-signed cert from an untrusted CA was accepted with no sslrootcert. With sslrootcert set it does validate (behaves as verify-ca), per libpq's documented back-compat rule
  - evidence: T1 succeeded with no sslrootcert against a cert signed by a throwaway CA; T7 with sslrootcert=server.crt failed 'SSL error: certificate verify failed'. Docs: "if a root CA file exists, the behavior of sslmode=require will be the same as that of verify-ca" - https://www.postgresql.org/docs/current/libpq-ssl.html
- **verified** Clients do not require channel binding by default: libpq's channel_binding defaults to `prefer`, so advertising only SCRAM-SHA-256 (never SCRAM-SHA-256-PLUS) is sufficient; only channel_binding=require breaks
  - evidence: libpq docs: channel_binding values require/prefer/disable, "Default: prefer if PostgreSQL is compiled with SSL support" - https://www.postgresql.org/docs/current/libpq-connect.html . Live: psql ... channel_binding=require -> 'channel binding is required, but server did not offer an authentication method that supports channel binding'
- **verified** BUG (reproducible, remote): a client that rejects the server certificate crashes the entire Node process - unhandled ERR_INVALID_STATE 'WritableStream is locked' thrown from PostgresConnection.init()
  - evidence: /Users/user/workspace/blob-pglite/node_modules/pg-gateway/src/connection.ts:228 (`await this.duplex.writable.abort()`); after psql with a bad sslrootcert, the server process exited and a follow-up connect got 'Connection refused'. Root cause: upgradeTls does `Duplex.fromWeb(duplex)` which locks the original writable. Related closed issue #22 'Basic example fails with TypeError: this.duplex.writable.abort is not a function'
- **verified** BUG: pg-gateway rejects protocol version 3.2 outright instead of replying NegotiateProtocolVersion - PG18 libpq with max_protocol_version=latest cannot connect
  - evidence: src/connection.ts isStartupMessage() requires `majorVersion === 3 && minorVersion === 0`; live: psql ... max_protocol_version=latest -> client 'SSL error: unexpected eof while reading', server log 'Error: Unexpected initial message at handleClientMessage (connection.ts:334)'
- **verified** pg-gateway never sends BackendKeyData, so clients get no PID/secret key and cannot form a valid CancelRequest
  - evidence: grep of src/ finds only the constant `BackendKeyData: 0x4b` in message-codes.ts, no emitter; live probe with node-postgres: client.processID = null, client.secretKey = null
- **verified** CancelRequest (80877102) on a second connection is not implemented: it falls through to `throw new Error('Unexpected initial message')`, though the socket does close with 0 bytes written (which is close to the spec-required 'no direct reply, then close')
  - evidence: raw 16-byte CancelRequest (len=16, 1234, 5678, pid, key) -> server logged 'Unexpected initial message', client observed 'server replied with 0 bytes'
- **verified** Q6 CONFIRMED EMPIRICALLY: per-connection rewriting of statement/portal names in Parse/Bind/Describe/Close/Execute fixes the 42P05 collision on a single shared PGlite session
  - evidence: Phase A (no rewrite): conn A 's1' ok, conn B FAILED 42P05 'prepared statement "s1" already exists'. Phase B (prefix 'z<n>_'): conn A ok, conn B ok, conn A re-exec ok. Rewriter was ~45 lines: /private/tmp/claude-501/-Users-user-workspace-blob-pglite/b9b81f00-ad6e-41ca-bbf4-71186ef30832/scratchpad/prepared.mts
- **verified** Exactly 5 client-to-server message types must be parsed for namespacing: Parse 'P' (stmt name, first cstring), Bind 'B' (portal then source stmt, two cstrings), Describe 'D' and Close 'C' (kind byte 'S'/'P' then name), Execute 'E' (portal name). Empty names must be left untouched. Server responses carry no names, so no return-path rewrite is needed; each rewritten message must have its int32 length re-encoded
  - evidence: Implemented and passing in scratchpad/prepared.mts; matches the plan already written in /Users/user/workspace/blob-pglite/docs/TODO-pglite-socket-prepared-statements.md
- **verified** Namespacing has two leaks: SQL-level PREPARE/DEALLOCATE bypass the rewriter (they travel as Query text), and pg_prepared_statements exposes the prefixed name
  - evidence: After Parse-rewrite, `DEALLOCATE s1` returned 26000 'prepared statement "s1" does not exist'; `select name from pg_prepared_statements` returned [{"name":"z1_s1"}]
- **likely** ErrorResponse text also leaks prefixed names to the client (e.g. a 42P05 or 26000 message naming z1_s1), so a rewriting proxy should also un-prefix names in error message strings on the return path
  - evidence: Observed 26000 'prepared statement "s1" does not exist' echoing the requested name; the same code path emits the stored (prefixed) name for protocol-level errors
- **verified** pg-gateway performs NO cross-connection serialization - swapping serveWire off @electric-sql/pglite-socket would lose pglite-socket's transaction-aware QueryQueueManager (the property that makes RLS/GUC isolation safe today)
  - evidence: grep for isInTransaction|runExclusive|queue|mutex across pg-gateway/src returns nothing but an unrelated controller.enqueue; pglite-socket dist/index.cjs processQueue does `if(this.db.isInTransaction()&&this.lastHandlerId){...findIndex(r=>r.handlerId===this.lastHandlerId)}`
- **verified** @electric-sql/pglite-socket 0.2.7 (2026-07-02) NOW answers SSLRequest with 'N' and silently swallows CancelRequest - this repo is pinned to ^0.2.2 which does neither, which is why sslmode=disable is required everywhere
  - evidence: 0.2.7 dist/index.cjs: SSL_REQUEST_CODE=80877103, handleSslRequest() writes Buffer.from('N'); CANCEL_REQUEST_CODE=80877102, handleCancelRequest() logs 'CancelRequest received, ignoring (not supported)'. Installed 0.2.2: strings '80877103' and 'SSLRequest' absent. /Users/user/workspace/blob-pglite/package.json pins ^0.2.2
- **verified** pglite-socket 0.2.7 still has no TLS, no auth (trust only), no BackendKeyData, and a copy-paste bug in its startup-version check: `(a===196608||a===196608)`
  - evidence: grep of 0.2.7 dist: 'scram' absent, 'SASL' absent, 'BackendKeyData' absent; handleData contains `(a===196608||a===196608)&&(t=o,...)`
- **verified** Protocol constants: SSLRequest = 80877103 (1234<<16|5679), CancelRequest = 80877102 (1234<<16|5678), GSSENCRequest = 80877104 (1234<<16|5680), StartupMessage v3.0 = 196608, v3.2 = 196610. Server answers a single byte 'S' to accept SSL or 'N' to decline; 'G'/'N' for GSSENCRequest
  - evidence: pg-gateway isSslRequest(): getInt16(4)===1234 && getInt16(6)===5679; PG docs protocol-flow: "the server then responds with a single byte containing S or N" and "a single byte containing G or N" - https://www.postgresql.org/docs/current/protocol-flow.html
- **verified** After sending 'S' the server must send NOTHING else before the TLS handshake - extra readable bytes indicate a buffer-stuffing MITM (CVE-2021-23222); pg-gateway discards its MessageBuffer on upgrade, which is safe but also silently drops legitimately pipelined bytes
  - evidence: PG docs: "If additional bytes are available to read at this point, it likely means that a man-in-the-middle is attempting to perform a buffer-stuffing attack (CVE-2021-23222)"; src/connection.ts init() does `this.messageBuffer = new MessageBuffer()` after upgradeTls; detach() carries a TODO 'inject lingering messageBuffer back onto stream to prevent data loss'
- **verified** Node TLS gotcha: manually constructing `new tls.TLSSocket(socket, {isServer:true, requestCert:true})` leaves `authorized` permanently false - pg-gateway had to copy Node internals (`secureSocket._handle.verifyError()`) to make client-cert auth work
  - evidence: src/platforms/node/tls.ts onServerSocketSecure(): "Internal Node.js handler copied and modified from source to validate client certs... Without this, `authorized` is always `false` on the TLSSocket and we never know if the client cert is valid."
- **verified** Node TLS gotcha: the server-side readiness event is 'secure' (not 'secureConnect'), and SNI requires an SNICallback returning tls.createSecureContext per server name
  - evidence: src/platforms/node/tls.ts: `await once(secureSocket, 'secure')`, `SNICallback: async (serverName, callback) => callback(null, createSecureContext(updatedTlsSocketOptions))`
- **verified** Supporting PG17+ direct TLS (sslnegotiation=direct) additionally requires recognizing an immediate TLS ClientHello (first byte 0x16, no SSLRequest) and negotiating ALPN protocol id "postgresql"; pg-gateway does not implement this
  - evidence: PG docs protocol-flow: "The server will recognize connections which immediately begin SSL negotiation without any previous SSLRequest packets" and "The PostgreSQL protocol is \"postgresql\" as registered at IANA TLS ALPN Protocol IDs"; no ALPN string appears in pg-gateway src
- **verified** Node's built-in crypto/WebCrypto is sufficient for SCRAM-SHA-256: PBKDF2-HMAC-SHA256 (crypto.subtle.deriveBits), HMAC-SHA256 (subtle.sign), SHA-256 (subtle.digest), crypto.getRandomValues for the server nonce, base64, and a timing-safe compare. No third-party crypto dependency is needed
  - evidence: src/crypto.ts (120 lines) uses only crypto.subtle.importKey/deriveBits/sign/digest and exports pbkdf2, createHmacKey, createHashKey, timingSafeEqual
- **verified** A correct server-side SCRAM-SHA-256 implementation is roughly 300-450 lines including types and error paths; pg-gateway's is 275 (scram-sha-256.ts) + 39 (sasl-mechanism.ts) + 120 (crypto.ts) = 434, and a minimal single-mechanism version could be ~150-250
  - evidence: wc -l on branch `next`: auth/sasl/scram-sha-256.ts 275, auth/sasl/sasl-mechanism.ts 39, crypto.ts 120; whole src tree (excluding vendored .d.ts) is 2468 lines
- **verified** pg-gateway's SCRAM omits SASLprep (RFC 4013) normalization of the password, so verifiers derived from non-ASCII passwords will not match real Postgres; it also does not validate the gs2 header (n,, vs y,,) against the c= value it echoes into authMessage
  - evidence: createScramSha256Data() calls pbkdf2(password, ...) directly with no normalization; createServerFinalMessage() reconstructs `c=${channelBinding},r=${fullNonce}` from whatever the client sent, without checking the gs2 header from client-first-message
- **verified** pg-gateway's SCRAM is only unit-tested against node-postgres's own SASL client, in-memory - there is no test against libpq, JDBC, pgx, or sqlx
  - evidence: test/general/auth/scram-sha-256.test.ts imports `startSession, continueSession, finalizeSession` from 'pg/lib/crypto/sasl' over an in-memory createDuplexPair; the whole test dir is 1052 lines total
- **verified** No maintained MIT/Apache alternative implements the Postgres SERVER side in Node. pglite-server (kamilogorek, MIT, 0.1.5, ~9k downloads/month) is self-described as "a spare-time attempt to understand Postgres Wire Protocol" and its own README points readers at pg-gateway; pg-server (ISC, 0.1.8, last publish 2024-08) is a "Postgres DB server emulator, proxy or honeypot"
  - evidence: https://github.com/kamilogorek/pglite-server README; `npm view pg-server` -> license ISC, description 'Postgres DB server emulator, proxy or honeypot', modified 2024-08-06
- **verified** pgwire (kagis/exe-dealer, MIT, 0.8.1) and @databases/pg (MIT) are CLIENT libraries only, not server-side implementations; pg-protocol (MIT, part of node-postgres, actively maintained at 1.15.0) is a reusable parser/serializer but client-oriented (it parses backend messages and serializes frontend ones, the inverse of what a server needs). The npm names 'postgres-server' and 'node-pg-server' do not exist
  - evidence: `npm view pgwire description` -> 'PostgreSQL client library for Deno and Node.js that exposes all features of the wire protocol'; `npm view pg-protocol` -> 'The postgres client/server binary protocol, implemented in TypeScript', modified 2026-06-19; https://github.com/kagis/pgwire ; npm 404 for postgres-server and node-pg-server
- **verified** pg-gateway is designed to work with PGlite and this repo already spiked it: the wiring is `fromNodeSocket(socket, { auth, tls, onMessage: (data, {isAuthenticated}) => isAuthenticated && db.runExclusive(() => db.execProtocolRaw(data)) })`
  - evidence: /Users/user/workspace/blob-pglite/experiments/prisma-spike/pggw.ts lines 47-66; the pg-gateway repo has examples/pglite and examples/pglite-multiple
- **verified** This repo's own notes already conclude pg-gateway is the better wire layer and propose swapping serveWire's backend to it (the sslmode=disable and user-override hacks disappear), while noting it does NOT fix `prisma migrate dev` (P1017 is structural: PGlite is one backend session)
  - evidence: /Users/user/workspace/blob-pglite/docs/ORM-ADAPTER-NOTES.md lines 214-262: "Silver lining - pg-gateway is the better wire layer for everything else... Candidate follow-up: swap serveWire's backend from @electric-sql/pglite-socket to pg-gateway"
- **verified** pg-gateway declares no runtime dependencies (the @std/* encoding and byte helpers are devDependencies bundled by tsup), which keeps adoption cheap; it ships node, deno and web (WebSocket/stream) platform entry points
  - evidence: packages/pg-gateway/package.json on branch `next` has only devDependencies; `require('./node_modules/pg-gateway/package.json').dependencies` -> undefined; exports map has '.', './node', './deno', './web'

### Open questions

- Does pg-gateway's SCRAM-SHA-256 actually satisfy pgx (Go), pgjdbc (Java), and sqlx/Diesel (Rust)? Only libpq/psql 18.4 and node-postgres were verified here; pgjdbc in particular is strict about the server-final signature and about SASLprep of the password.
- Will supabase-community ever merge PR #21 and cut a stable 0.3.0? The branch has been unmerged for 19 months and the only 2026 commit is a dependency-hygiene chore. If we adopt, do we vendor/fork (like pglite-kill-dash-9) or depend on a beta that may never ship?
- How does firebase-tools cope with the TLS-handshake crash at connection.ts:228? Either they do not enable TLS, or they install a process-level unhandledRejection guard - worth checking, because it determines whether the bug is a blocker or a one-line workaround for us.
- Should the prepared-statement namespacing land in pg-gateway (a hook we own, ~45 lines inside onMessage) or be upstreamed into pglite-socket? Doing it in pg-gateway is trivial today, but pg-gateway lacks pglite-socket's transaction-aware queue, so adopting it means re-implementing that serialization ourselves or losing the proven RLS-safety property.
- Does namespacing alone unblock sqlx and Diesel end to end, or do those drivers also depend on other per-session state (search_path, SET, temp tables, LISTEN/NOTIFY, advisory locks) that a single shared PGlite session still leaks across connections?
- Is it worth answering NegotiateProtocolVersion for 3.2 rather than erroring? PG18 libpq only requests 3.2 when the connection string uses a 3.2-only feature, so the blast radius is small today but grows as drivers default upward.
- Does supporting CancelRequest have any value at all given PGlite cannot interrupt a running query (statement_timeout is already documented as inert on PGlite)? The minimum useful behavior may just be: recognize 80877102, log, close silently, never throw.
- Should we upgrade @electric-sql/pglite-socket from the pinned ^0.2.2 to 0.2.7 regardless of the pg-gateway decision? 0.2.7 alone removes the sslmode=disable requirement and the CancelRequest wedge.
