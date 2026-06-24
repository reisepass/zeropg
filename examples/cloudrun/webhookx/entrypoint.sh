#!/usr/bin/env bash
# webhookx entrypoint for Cloud Run on zeropg.
#
#   1. wait for the zeropg `db` sidecar wire to accept connections on
#      127.0.0.1:5432 (Cloud Run container-dependencies already gate us on the
#      db sidecar's /healthz, but the wire can lag the control face slightly).
#   2. run `webhookx db up` (golang-migrate; idempotent — tracks applied
#      versions in schema_migrations, so a warm restore re-runs it as a no-op).
#   3. exec `webhookx start` (proxy on the Cloud Run PORT, admin+status loopback,
#      and the delivery worker).
#
# All DB/Redis wiring comes from WEBHOOKX_* env in service.yaml. In particular
# WEBHOOKX_DATABASE_PARAMETERS carries default_query_exec_mode=cache_describe
# (pgx extended protocol with cached DESCRIBE, no persisted named prepared
# statements => no 42P05 on the single-session wire, and correct JSONB encoding),
# and WEBHOOKX_DATABASE_MAX_POOL_SIZE=4 (must be >1: the migrator deadlocks at 1).
set -euo pipefail

DB_HOST="${WEBHOOKX_DATABASE_HOST:-127.0.0.1}"
DB_PORT="${WEBHOOKX_DATABASE_PORT:-5432}"
DB_USER="${WEBHOOKX_DATABASE_USERNAME:-postgres}"
DB_NAME="${WEBHOOKX_DATABASE_DATABASE:-postgres}"

DB_PASS="${WEBHOOKX_DATABASE_PASSWORD:-postgres}"

# NOTE: pg_isready does NOT work against the pglite-socket wire (it uses a
# lightweight probe the socket server does not answer). A real connection does,
# so we gate on `psql -c 'SELECT 1'` instead.
echo "[webhookx-entrypoint] waiting for zeropg wire ${DB_HOST}:${DB_PORT} ..."
for i in $(seq 1 120); do
  if PGPASSWORD="${DB_PASS}" psql \
       "host=${DB_HOST} port=${DB_PORT} user=${DB_USER} dbname=${DB_NAME} sslmode=disable connect_timeout=3" \
       -tAc 'SELECT 1' >/dev/null 2>&1; then
    echo "[webhookx-entrypoint] wire accepted a real connection (after ${i} tries)"
    break
  fi
  sleep 1
  if [ "${i}" -eq 120 ]; then
    echo "[webhookx-entrypoint] FATAL: zeropg wire never accepted a connection" >&2
    exit 1
  fi
done

# golang-migrate up. Idempotent: re-running when already current is a no-op.
echo "[webhookx-entrypoint] applying migrations (webhookx db up) ..."
webhookx db up

# Ensure the default workspace row exists. webhookx's migrator only inserts it
# when `client.Up()` actually applies new migrations; on a warm restore where
# the schema is already current it returns ErrNoChange and the insert is
# skipped. The admin/proxy APIs reject requests if no default workspace exists,
# so we create it idempotently here. ON CONFLICT(name) makes this a no-op once
# present.
echo "[webhookx-entrypoint] ensuring default workspace exists ..."
WS_ID="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-27)"
PGPASSWORD="${DB_PASS}" psql \
  "host=${DB_HOST} port=${DB_PORT} user=${DB_USER} dbname=${DB_NAME} sslmode=disable connect_timeout=5" \
  -v ON_ERROR_STOP=1 \
  -c "INSERT INTO workspaces(id, name) VALUES('${WS_ID}', 'default') ON CONFLICT(name) DO NOTHING;"

# Optional self-configuration: if WEBHOOKX_DEMO_ENDPOINT_URL is set, sync a
# declarative config (one HTTP source at /ingest + one endpoint forwarding the
# "demo.ping" event to that URL) once webhookx's admin API is up. The admin API
# binds to loopback only, so this runs in-container against 127.0.0.1:9601.
# Idempotent: `admin sync` reconciles to the declared state on every boot.
ADMIN_ADDR="${WEBHOOKX_DEMO_ADMIN_ADDR:-http://127.0.0.1:9601}"
if [ -n "${WEBHOOKX_DEMO_ENDPOINT_URL:-}" ]; then
  cat > /tmp/webhookx-demo.yml <<YAML
endpoints:
  - name: demo-endpoint
    enabled: true
    request:
      url: ${WEBHOOKX_DEMO_ENDPOINT_URL}
      method: POST
      timeout: 10000
    retry:
      strategy: fixed
      config:
        attempts: [0, 30, 60]
    events:
      - demo.ping
sources:
  - name: demo-source
    type: http
    async: false
    enabled: true
    config:
      http:
        path: /ingest
        methods: [POST]
        response:
          code: 200
          content_type: application/json
          body: '{"message":"accepted"}'
YAML
  (
    # wait for the admin API, then sync (best-effort; never block ingress).
    for i in $(seq 1 60); do
      if curl -fsS -m 3 "${ADMIN_ADDR}/workspaces" >/dev/null 2>&1; then
        echo "[webhookx-entrypoint] admin API up; syncing demo config -> ${WEBHOOKX_DEMO_ENDPOINT_URL}"
        if webhookx admin sync --addr "${ADMIN_ADDR}" /tmp/webhookx-demo.yml; then
          echo "[webhookx-entrypoint] demo config synced"
        else
          echo "[webhookx-entrypoint] WARN: demo config sync failed (continuing)"
        fi
        break
      fi
      sleep 2
    done
  ) &
fi

echo "[webhookx-entrypoint] migrations applied; starting webhookx ..."
exec webhookx start
