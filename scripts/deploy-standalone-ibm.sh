#!/usr/bin/env bash
# Deploy the zeropg STANDALONE server (PostgREST default-on + POST /sql + /wake +
# /ready, real Postgres wire on loopback) to IBM Code Engine, backed by IBM COS
# (R2BlobStore over the COS S3 endpoint). This is the HTTP-faces demo: a remote
# app talks to a dedicated, scale-to-zero Postgres over HTTP. Same transport +
# lease model as scripts/deploy-ibm.sh; the difference is the image
# (experiments/standalone-service) which adds the PostgREST binary + wire server.
#
#   scripts/deploy-standalone-ibm.sh [app-name] [db-prefix] [app-label]
#
# Prereqs (same as deploy-ibm.sh):
#   - ibmcloud CLI logged in (region eu-de); code-engine + container-registry
#     plugins installed.
#   - source ~/.zeropg-ibm.env  → IBMCLOUD_API_KEY, COS_HMAC_*, COS_ENDPOINT*,
#     COS_BUCKET, IBM_COS_REGION.
#
# Env knobs:
#   DURABILITY=sleep|interval|strict   default sleep
#   ZEROPG_POSTGREST=on|off            default on (off => skip PostgREST, save RAM)
#   MEMORY=2G CPU=1                    Code Engine resources
#   SKIP_BUILD=1                       reuse the already-pushed :latest image
set -euo pipefail

: "${COS_HMAC_ACCESS_KEY_ID:?source ~/.zeropg-ibm.env first}"
: "${COS_HMAC_SECRET_ACCESS_KEY:?source ~/.zeropg-ibm.env first}"
: "${COS_BUCKET:?source ~/.zeropg-ibm.env first}"

PROJECT=zeropg
REGION="${IBM_COS_REGION:-eu-de}"
CR_REGISTRY=de.icr.io
CR_NAMESPACE="${CR_NAMESPACE:-zeropg-cd4040f4}"
REGISTRY_SECRET=icr-de
COS_SECRET=cos-creds

APP="${1:-zeropg-standalone}"
DB_PREFIX="${2:-demo/standalone}"
APP_LABEL="${3:-zeropg standalone (dedicated Postgres) on IBM Code Engine + COS}"
IMAGE="${CR_REGISTRY}/${CR_NAMESPACE}/${APP}:latest"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> targeting Code Engine project '$PROJECT' (region $REGION)"
ibmcloud target -r "$REGION" >/dev/null
ibmcloud ce project select --name "$PROJECT" >/dev/null 2>&1 \
  || ibmcloud ce project create --name "$PROJECT" --wait

echo "==> ensuring ICR namespace + CE registry/COS secrets"
ibmcloud cr region-set eu-central >/dev/null 2>&1 || true
ibmcloud cr namespace-add "$CR_NAMESPACE" >/dev/null 2>&1 || true
ibmcloud ce secret get --name "$REGISTRY_SECRET" >/dev/null 2>&1 \
  || ibmcloud ce registry create --name "$REGISTRY_SECRET" --server "$CR_REGISTRY" \
       --username iamapikey --password "$IBMCLOUD_API_KEY"
ibmcloud ce secret get --name "$COS_SECRET" >/dev/null 2>&1 \
  || ibmcloud ce secret create --name "$COS_SECRET" \
       --from-literal "COS_HMAC_ACCESS_KEY_ID=$COS_HMAC_ACCESS_KEY_ID" \
       --from-literal "COS_HMAC_SECRET_ACCESS_KEY=$COS_HMAC_SECRET_ACCESS_KEY" \
       --from-literal "COS_ENDPOINT_DIRECT=${COS_ENDPOINT_DIRECT:-}" \
       --from-literal "COS_ENDPOINT=${COS_ENDPOINT:-}" \
       --from-literal "COS_BUCKET=$COS_BUCKET" \
       --from-literal "IBM_COS_REGION=$REGION"

echo "==> bundling standalone service"
npx tsx experiments/standalone-service/build.mjs

# --min-scale 0 / --max-scale 1 / --concurrency 1 keep the single-writer lease
# model: one instance, scale-to-zero. PostgREST + PGlite want a little headroom.
CMD=(application)
if ibmcloud ce application get --name "$APP" >/dev/null 2>&1; then CMD+=(update); else CMD+=(create); fi

echo "==> ${CMD[1]} Code Engine application '$APP' (prefix=$DB_PREFIX, postgrest=${ZEROPG_POSTGREST:-on})"
ARGS=(
  --name "$APP"
  --port 8080
  --cpu "${CPU:-1}" --memory "${MEMORY:-2G}"
  --min-scale 0 --max-scale 1 --concurrency 1
  --env-from-secret "$COS_SECRET"
  --env "ZEROPG_PREFIX=${DB_PREFIX}"
  --env "APP_LABEL=${APP_LABEL}"
  --env "ZEROPG_DURABILITY=${DURABILITY:-sleep}"
  --env "ZEROPG_POSTGREST=${ZEROPG_POSTGREST:-on}"
  --wait
)
if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  ARGS+=(--image "$IMAGE")
else
  ARGS+=(--build-source ./experiments/standalone-service --build-strategy dockerfile \
         --build-dockerfile Dockerfile --image "$IMAGE" --registry-secret "$REGISTRY_SECRET")
fi
ibmcloud ce "${CMD[@]}" "${ARGS[@]}"

URL=$(ibmcloud ce application get --name "$APP" --output jsonpath='{.status.url}')
echo "==> deployed: $URL"
echo "STANDALONE HTTP DEMO URL: $URL"
