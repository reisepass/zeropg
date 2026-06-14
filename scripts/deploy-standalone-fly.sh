#!/usr/bin/env bash
# Deploy the zeropg STANDALONE server to Fly.io as a RAW-WIRE Postgres: a single
# scale-to-zero Fly Machine exposing the REAL Postgres wire protocol on public
# TCP 5432 (via @electric-sql/pglite-socket), durable home = a Tigris (S3) bucket
# through R2BlobStore. This is the demo Cloud Run / Code Engine cannot do: any
# libpq client (psql, JDBC, asyncpg, ...) connects directly.
#
# Scale-to-zero: the Fly proxy STARTS the machine on an incoming connection and
# STOPS it when idle (auto_start/auto_stop, min_machines_running=0). A fresh psql
# connection wakes it; the cold-start restore comes back from Tigris.
#
#   scripts/deploy-standalone-fly.sh
#
# Prereqs:
#   - flyctl installed + authenticated (personal org).
#   - source ~/.zeropg-fly.env  → FLY_API_TOKEN, AWS_* (Tigris S3 creds +
#     endpoint), TIGRIS_BUCKET.
#   - The app + a DEDICATED IPv4 must exist for raw TCP 5432 (shared IPv4 only
#     routes HTTP). This script creates the app and allocates IPs if missing.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?source ~/.zeropg-fly.env first}"
: "${AWS_SECRET_ACCESS_KEY:?source ~/.zeropg-fly.env first}"
: "${AWS_ENDPOINT_URL_S3:?source ~/.zeropg-fly.env first}"
: "${TIGRIS_BUCKET:?source ~/.zeropg-fly.env first}"

APP="${1:-zeropg-wire-demo}"
ORG="${FLY_ORG:-personal}"
export PATH="$HOME/.fly/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/experiments/standalone-service"

echo "==> ensuring Fly app '$APP' (org $ORG)"
flyctl apps create "$APP" --org "$ORG" 2>/dev/null \
  || echo "    app already exists"

# Raw TCP 5432 needs a DEDICATED public IP. Shared IPv4 routes HTTP only.
if ! flyctl ips list -a "$APP" 2>/dev/null | grep -q "v4"; then
  echo "==> allocating dedicated IPv4 (required for raw TCP 5432)"
  flyctl ips allocate-v4 -a "$APP" --yes
fi
flyctl ips list -a "$APP" 2>/dev/null | grep -q "v6" \
  || flyctl ips allocate-v6 -a "$APP"

echo "==> staging Tigris credentials as Fly secrets"
flyctl secrets set \
  "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" \
  "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY" \
  "AWS_ENDPOINT_URL_S3=$AWS_ENDPOINT_URL_S3" \
  "AWS_REGION=${AWS_REGION:-auto}" \
  "TIGRIS_BUCKET=$TIGRIS_BUCKET" \
  -a "$APP" --stage

echo "==> bundling standalone service"
( cd "$ROOT" && npx tsx experiments/standalone-service/build.mjs )

# --ha=false: a single Machine (the single-writer lease model). fly.toml carries
# the two [[services]] (tcp 5432 wire + http 8080 control face) and the
# auto_start/auto_stop scale-to-zero config.
echo "==> deploying single machine"
( cd "$SVC" && flyctl deploy --remote-only --ha=false -a "$APP" )

IPV4=$(flyctl ips list -a "$APP" 2>/dev/null | awk '/v4/{print $2; exit}')
echo "==> deployed"
echo "FLY PSQL URL: postgres://postgres@${IPV4}:5432/postgres?sslmode=disable"
echo "  psql 'postgres://postgres@${IPV4}:5432/postgres?sslmode=disable&connect_timeout=60' -c 'select 1'"
echo "  (sslmode=disable is required: pglite-socket does not negotiate TLS)"
