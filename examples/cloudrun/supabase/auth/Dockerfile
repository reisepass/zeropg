# GoTrue (Supabase auth) for the stripped Supabase stack on zeropg.
#
# Unmodified upstream supabase/gotrue image + a thin entrypoint that waits for the
# zeropg `db` sidecar wire before exec'ing GoTrue (Cloud Run container-dependencies
# gate us on the db sidecar's /healthz, but the wire can lag the control face).
#
# The single-session-wire compatibility is achieved PURELY via env in service.yaml:
#   GOTRUE_DB_DATABASE_URL=...&statement_cache_mode=describe
#     -> pgx v4 DESCRIBEs via the anonymous prepared statement (correct type OIDs)
#        but never persists a NAMED server-side prepared statement => no 42P05 on
#        the shared single PGlite session. (v4 equivalent of v5 cache_describe.)
# No app code is patched. The `auth` schema + search_path are set up by the db
# sidecar's bootstrap (see ../zeropg-db/bootstrap.sql + server.mjs).
FROM supabase/gotrue:v2.189.0

# postgres-client for the wire readiness probe; bash for the entrypoint.
USER root
RUN apk add --no-cache bash postgresql-client curl
COPY entrypoint.sh /usr/local/bin/zeropg-entrypoint.sh
RUN chmod +x /usr/local/bin/zeropg-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/zeropg-entrypoint.sh"]
