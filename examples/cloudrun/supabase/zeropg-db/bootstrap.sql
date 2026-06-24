-- Canonical boot schema for the stripped Supabase stack on zeropg.
-- Applied via ZEROPG_SCHEMA_SQL on every cold start, BEFORE PostgREST introspects
-- and BEFORE GoTrue connects. Idempotent. Runs as the PGlite superuser (postgres).
--
-- This file is the integration glue the adversarial review demanded:
--   * Supabase roles (anon / authenticated / service_role) + an authenticator-style
--     grant model so PostgREST can SET ROLE into them from the JWT `role` claim.
--   * the `auth` schema GoTrue's pop migrations require to pre-exist.
--   * auth.uid()/auth.role()/auth.jwt() helpers (DO NOT exist in vanilla Postgres;
--     every copied Supabase RLS policy calls them). search_path PINNED on each
--     (security hardening: a SECURITY-sensitive/STABLE helper must not resolve
--     objects through a mutable search_path on this shared single session).
--   * a demo `todos` table with RLS scoped to auth.uid(), to prove the typed
--     supabase-js -> PostgREST -> RLS path end to end.
--
-- NOTE on search_path: GoTrue issues UNQUALIFIED runtime queries (users,
-- identities, ...) and relies on the connection search_path including `auth`.
-- ALTER ROLE/DATABASE SET search_path does NOT take effect on pglite-socket's
-- multiplexed single session, so the sidecar sets it on the LIVE session after
-- this file runs (SET search_path TO public, auth) — see server.mjs. `public`
-- stays first so PostgREST's public tables resolve too.

-- ---- roles ----
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

-- PostgREST connects as `postgres` (the authenticator here) and SET ROLEs into
-- these from the JWT. Grant membership so the role switch is permitted.
GRANT anon, authenticated, service_role TO postgres;

-- Lock down the public schema: the live-session search_path is `public, auth`
-- (public first), so an untrusted role that could CREATE in public could shadow
-- an unqualified name. Revoke CREATE from PUBLIC + the API roles; USAGE only.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ---- auth schema + helpers ----
CREATE SCHEMA IF NOT EXISTS auth;
REVOKE CREATE ON SCHEMA auth FROM PUBLIC;
REVOKE CREATE ON SCHEMA auth FROM anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(auth.jwt() ->> 'sub','')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(auth.jwt() ->> 'role', 'anon')
$$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT auth.jwt() ->> 'email'
$$;
REVOKE ALL ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;

-- ---- pgvector (extension preloaded by the sidecar) ----
CREATE EXTENSION IF NOT EXISTS vector;

-- ---- demo table: todos, RLS scoped to the owner ----
CREATE TABLE IF NOT EXISTS public.todos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL DEFAULT auth.uid(),
  task        text NOT NULL,
  done        boolean NOT NULL DEFAULT false,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
-- FORCE so even the table owner is subject to RLS (defense in depth: no future
-- owner-context function can bypass the policy).
ALTER TABLE public.todos FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS todos_select_own ON public.todos;
DROP POLICY IF EXISTS todos_modify_own ON public.todos;
CREATE POLICY todos_select_own ON public.todos
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY todos_modify_own ON public.todos
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON public.todos FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO authenticated;
-- anon may read the table but RLS (user_id = auth.uid() = NULL for anon) hides all rows.
GRANT SELECT ON public.todos TO anon;

-- ---- demo vector table: documents with embeddings ----
CREATE TABLE IF NOT EXISTS public.documents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL DEFAULT auth.uid(),
  content     text NOT NULL,
  embedding   vector(3)             -- tiny dim for the demo; real apps use 384/768/1536
);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_own ON public.documents;
CREATE POLICY documents_own ON public.documents
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
REVOKE ALL ON public.documents FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;

-- match_documents RPC: ANN search scoped to the caller's rows (RLS still applies
-- inside the function because it is SECURITY INVOKER).
CREATE OR REPLACE FUNCTION public.match_documents(query_embedding vector(3), match_count int DEFAULT 5)
  RETURNS TABLE (id bigint, content text, distance double precision)
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_catalog AS $$
  SELECT d.id, d.content, (d.embedding <-> query_embedding) AS distance
  FROM public.documents d
  ORDER BY d.embedding <-> query_embedding
  LIMIT match_count
$$;
REVOKE ALL ON FUNCTION public.match_documents(vector, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_documents(vector, int) TO authenticated;
