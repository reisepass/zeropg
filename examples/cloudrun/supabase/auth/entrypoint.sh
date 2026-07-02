#!/usr/bin/env bash
# GoTrue entrypoint for the stripped Supabase stack on zeropg.
#
#   1. wait for the zeropg `db` sidecar wire to accept a REAL connection on
#      127.0.0.1:5432. (pg_isready does NOT work against pglite-socket — it uses a
#      probe the socket server does not answer — so we gate on `psql -c 'SELECT 1'`.)
#      We also wait until the `auth` schema exists, which the db sidecar creates in
#      its bootstrap; GoTrue's pop migrations assume it pre-exists.
#   2. exec GoTrue (`auth`). It runs its pop migrations (idempotent; tracked in
#      auth.schema_migrations) on every boot, then serves the API.
#
# All DB wiring comes from GOTRUE_* env in service.yaml — in particular
# GOTRUE_DB_DATABASE_URL carries statement_cache_mode=describe (no named prepared
# statements => no 42P05 on the single-session wire).
set -euo pipefail

DB_HOST="${ZEROPG_DB_HOST:-127.0.0.1}"
DB_PORT="${ZEROPG_DB_PORT:-5432}"
DB_USER="${ZEROPG_DB_USER:-postgres}"
DB_NAME="${ZEROPG_DB_NAME:-postgres}"
CONN="host=${DB_HOST} port=${DB_PORT} user=${DB_USER} dbname=${DB_NAME} sslmode=disable connect_timeout=3"

echo "[auth-entrypoint] waiting for zeropg wire ${DB_HOST}:${DB_PORT} + auth schema ..."
for i in $(seq 1 120); do
  if psql "${CONN}" -tAc "SELECT 1 FROM information_schema.schemata WHERE schema_name='auth'" 2>/dev/null | grep -q 1; then
    echo "[auth-entrypoint] wire up and auth schema present (after ${i} tries)"
    break
  fi
  sleep 1
  if [ "${i}" -eq 120 ]; then
    echo "[auth-entrypoint] FATAL: wire/auth-schema never ready" >&2
    exit 1
  fi
done

echo "[auth-entrypoint] starting GoTrue (auth) ..."
exec auth
