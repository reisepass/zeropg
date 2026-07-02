// KILL-SWITCH #3 (the load-bearing one): RLS claim/role isolation on the SHARED
// single PGlite session.
//
// The risk (raised in adversarial review): GoTrue + PostgREST multiplex many wire
// connections onto ONE PGlite session. PostgREST enforces RLS per request via
//   BEGIN; SET LOCAL ROLE authenticated;
//   SELECT set_config('request.jwt.claims', '<jwt>', true);  -- is_local=true
//   <query>; COMMIT;
// If the multiplexer interleaved another connection's statements INSIDE that
// transaction, user B could execute while user A's role+claims are active =>
// catastrophic cross-user data leak.
//
// pglite-socket 0.2.2's QueryQueueManager is transaction-AWARE: while
// db.isInTransaction() is true it only dequeues messages from the SAME handler
// that opened the transaction (lastHandlerId), so no other connection can run a
// statement until that transaction COMMIT/ROLLBACKs. This test PROVES that holds
// end to end through real PostgREST + real RLS:
//
//   - table private_items with RLS USING (owner_id = auth.uid())
//   - two users A and B, each owns rows
//   - a slow authenticated RPC (pg_sleep) as user A held OPEN while many
//     authenticated reads as user B fire concurrently
//   - assert: B NEVER sees A's rows, A NEVER sees B's rows, anon sees none
//   - hammer hundreds of interleaved authenticated reads from both users
//
// JWTs are minted locally with the same secret PostgREST verifies (PGRST_JWT_SECRET),
// so no GoTrue needed for THIS test (it isolates the RLS/session question).
//
// Run from repo root:
//   PGRST_BIN=$(cat /tmp/pgrst_path.txt) node examples/cloudrun/supabase/test/killswitch-rls-isolation.mjs

import { ZeroPGServer } from '@zeropg/server'
import { GcsBlobStore } from '@zeropg/blobstore'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { Client } from 'pg'
import { createHmac, randomUUID } from 'node:crypto'

const BUCKET = process.env.ZEROPG_BUCKET || 'zeropg-experiments-euw1'
const PREFIX = process.env.ZEROPG_PREFIX || `killswitch-rls-${Date.now()}`
const CTRL = 8801
const WIRE = 5801
const REST = 3801
const PGRST_BIN = process.env.PGRST_BIN || 'postgrest'
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

const fail = (m) => {
  console.error(`  FAIL ${m}`)
  process.exitCode = 1
}
const ok = (m) => console.log(`  ok   ${m}`)

// Minimal HS256 JWT signer (role + sub claims, what PostgREST/RLS read).
const b64url = (buf) => Buffer.from(buf).toString('base64url')
function jwt(claims) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

const ctrl = `http://127.0.0.1:${CTRL}`
async function restAs(token, path, init = {}) {
  const res = await fetch(`${ctrl}/rest${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

console.log(`[killswitch-rls] bucket=${BUCKET} prefix=${PREFIX}`)

const USER_A = randomUUID()
const USER_B = randomUUID()

// Boot the stack. The schema sets up Supabase-style roles, the auth.uid() helper
// (search_path-pinned), RLS, and seeds rows for A and B — all at boot so
// PostgREST introspects the final schema. JWT verification + role-switch are
// configured via PGRST_* env passed through to the in-process PostgREST.
const SCHEMA_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
-- search_path-pinned helper (security review: definer-style functions must pin path)
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
  SET search_path = pg_catalog AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  SET search_path = pg_catalog AS $$ SELECT nullif(auth.jwt() ->> 'sub','')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.private_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  body text NOT NULL
);
ALTER TABLE public.private_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON public.private_items;
CREATE POLICY own_rows ON public.private_items
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.private_items TO authenticated;
-- anon gets the table grant but RLS (owner_id = auth.uid(), null for anon) hides all rows.
GRANT SELECT ON public.private_items TO anon;

INSERT INTO public.private_items (owner_id, body) VALUES
  ('${USER_A}', 'A-secret-1'), ('${USER_A}', 'A-secret-2'),
  ('${USER_B}', 'B-secret-1');

-- slow RPC to hold a transaction open as one user while others fire.
CREATE OR REPLACE FUNCTION public.slow_whoami(sleep_s double precision)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
  SET search_path = pg_catalog, public AS $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_sleep(sleep_s);
  SELECT jsonb_build_object('uid', auth.uid(), 'role', current_user) INTO r;
  RETURN r;
END $$;
GRANT EXECUTE ON FUNCTION public.slow_whoami(double precision) TO authenticated, anon;
`

const store = new GcsBlobStore({ bucket: BUCKET, prefix: PREFIX })

// Pass PostgREST the JWT secret + role config via env BEFORE start (PostgrestProcess
// inherits process.env). PGRST_DB_ANON_ROLE defaults to anon in the wrapper.
process.env.PGRST_JWT_SECRET = JWT_SECRET
process.env.PGRST_DB_ANON_ROLE = 'anon'

await ZeroPGServer.start({
  store,
  holder: `killswitch-rls-${process.pid}`,
  port: CTRL,
  wireHost: '127.0.0.1',
  wirePort: WIRE,
  restPort: REST,
  postgrest: true,
  postgrestBin: PGRST_BIN,
  restSchemas: 'public',
  extensions: { pgcrypto },
  schemaSql: SCHEMA_SQL,
  label: 'killswitch-rls',
})

// Wait ready.
{
  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < 120_000) {
    try {
      const b = await (await fetch(`${ctrl}/ready`)).json()
      if (b.ready) { ready = true; break }
      if (b.phase === 'error') { fail(`boot error: ${b.error}`); break }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!ready) { fail('server never reached ready'); process.exit(1) }
  console.log(`[killswitch-rls] ready`)
}

const tokenA = jwt({ role: 'authenticated', sub: USER_A, aud: 'authenticated' })
const tokenB = jwt({ role: 'authenticated', sub: USER_B, aud: 'authenticated' })
const tokenAnon = '' // no bearer => anon

try {
  // sanity: PostgREST verifies the JWT, switches role, RLS scopes rows.
  const aRows = await restAs(tokenA, '/private_items?select=body&order=body')
  if (aRows.status === 200 && aRows.body.length === 2 && aRows.body.every((r) => r.body.startsWith('A-'))) ok('user A sees exactly own 2 rows')
  else fail(`user A baseline wrong: ${JSON.stringify(aRows)}`)

  const bRows = await restAs(tokenB, '/private_items?select=body')
  if (bRows.status === 200 && bRows.body.length === 1 && bRows.body[0].body === 'B-secret-1') ok('user B sees exactly own 1 row')
  else fail(`user B baseline wrong: ${JSON.stringify(bRows)}`)

  const anonRows = await fetch(`${ctrl}/rest/private_items?select=body`)
  const anonBody = await anonRows.json()
  if (anonRows.status === 200 && Array.isArray(anonBody) && anonBody.length === 0) ok('anon sees zero rows (RLS)')
  else fail(`anon should see 0 rows, got: ${anonRows.status} ${JSON.stringify(anonBody)}`)

  // THE BLEED TEST: hold a slow transaction open as user A (2s pg_sleep inside the
  // request's BEGIN..COMMIT) and fire many user-B reads concurrently. If the
  // multiplexer let B's statements run inside A's open transaction, B would
  // inherit A's role+claims and see A's rows (or the slow_whoami would report B's
  // uid running while A is "active"). Assert strict isolation.
  const slowA = restAs(tokenA, '/rpc/slow_whoami', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sleep_s: 2.0 }),
  })
  // give A's transaction a moment to open on the session
  await new Promise((r) => setTimeout(r, 150))

  const N = 100
  const bReads = await Promise.all(
    Array.from({ length: N }, () => restAs(tokenB, '/private_items?select=body')),
  )
  const slowResult = await slowA

  // A's slow RPC must report A's uid (not contaminated by B traffic).
  if (slowResult.status === 200 && slowResult.body?.uid === USER_A && slowResult.body?.role === 'authenticated') {
    ok(`slow A RPC returned A's uid + role=authenticated while ${N} B-reads ran concurrently`)
  } else {
    fail(`slow A RPC contaminated: ${JSON.stringify(slowResult)}`)
  }

  // Every B read must return EXACTLY B's one row — never A's, never empty-by-mistake.
  let bleed = 0
  let wrongCount = 0
  for (const r of bReads) {
    if (r.status !== 200 || !Array.isArray(r.body)) { wrongCount++; continue }
    if (r.body.some((row) => String(row.body).startsWith('A-'))) bleed++
    if (!(r.body.length === 1 && r.body[0]?.body === 'B-secret-1')) wrongCount++
  }
  if (bleed === 0) ok(`ZERO cross-user bleed across ${N} concurrent B-reads during A's open transaction`)
  else fail(`CROSS-USER BLEED: ${bleed}/${N} B-reads saw user A's rows`)
  if (wrongCount === 0) ok(`all ${N} B-reads returned exactly B's row (no empty/garbled)`)
  else fail(`${wrongCount}/${N} B-reads returned wrong row set`)

  // Interleave A and B reads heavily; assert each only ever sees own rows.
  const M = 200
  const mixed = await Promise.all(
    Array.from({ length: M }, (_, i) => {
      const isA = i % 2 === 0
      return restAs(isA ? tokenA : tokenB, '/private_items?select=body').then((r) => ({ isA, r }))
    }),
  )
  let mixBleed = 0
  for (const { isA, r } of mixed) {
    if (r.status !== 200 || !Array.isArray(r.body)) { mixBleed++; continue }
    const wantPrefix = isA ? 'A-' : 'B-'
    if (!r.body.every((row) => String(row.body).startsWith(wantPrefix))) mixBleed++
  }
  if (mixBleed === 0) ok(`${M} interleaved A/B reads, each saw ONLY own rows (no bleed)`)
  else fail(`${mixBleed}/${M} interleaved reads bled across users`)
} catch (e) {
  fail(String(e))
}

console.log(process.exitCode ? '\n[killswitch-rls] RESULT: FAIL' : '\n[killswitch-rls] RESULT: PASS')
process.exit(process.exitCode || 0)
