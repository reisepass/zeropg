#!/usr/bin/env bash
# Reproduce the zeropg Cloud Run + GCS demo on IBM Cloud: IBM Code Engine
# (scale-to-zero containers, the Cloud Run analog) backed by IBM Cloud Object
# Storage (S3-compatible, conditional-write CAS). Same image, same server, same
# single-writer lease model — the only difference vs scripts/deploy.sh is the
# transport: the server builds an R2BlobStore (S3 + SigV4) pointed at the COS
# endpoint when COS_* env is present (see experiments/e3-service/server.ts).
#
#   scripts/deploy-ibm.sh [app-name] [db-prefix] [app-label]
#
# Prereqs (already prepared on the orchestrator VM):
#   - ibmcloud CLI logged in (region eu-de); code-engine + container-registry
#     plugins installed.
#   - source ~/.zeropg-ibm.env  → IBMCLOUD_API_KEY, COS_HMAC_ACCESS_KEY_ID,
#     COS_HMAC_SECRET_ACCESS_KEY, COS_ENDPOINT, COS_ENDPOINT_DIRECT, COS_BUCKET,
#     IBM_COS_REGION.
#
# Env knobs:
#   DURABILITY=sleep|interval|strict   default sleep (see server.ts)
#   SKIP_BUILD=1                       reuse the already-pushed :latest image
set -euo pipefail

: "${COS_HMAC_ACCESS_KEY_ID:?source ~/.zeropg-ibm.env first}"
: "${COS_HMAC_SECRET_ACCESS_KEY:?source ~/.zeropg-ibm.env first}"
: "${COS_BUCKET:?source ~/.zeropg-ibm.env first}"

PROJECT=zeropg                       # Code Engine project
REGION="${IBM_COS_REGION:-eu-de}"
CR_REGISTRY=de.icr.io                # IBM Container Registry for eu region
CR_NAMESPACE="${CR_NAMESPACE:-zeropg-cd4040f4}"
REGISTRY_SECRET=icr-de               # CE secret authenticating to ICR
COS_SECRET=cos-creds                 # CE secret holding the COS_* credentials

APP="${1:-zeropg-demo}"
DB_PREFIX="${2:-demo/app-ibm}"
APP_LABEL="${3:-zeropg on IBM Code Engine + COS}"
IMAGE="${CR_REGISTRY}/${CR_NAMESPACE}/${APP}:latest"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> targeting Code Engine project '$PROJECT' (region $REGION)"
ibmcloud target -r "$REGION" >/dev/null
ibmcloud ce project select --name "$PROJECT" >/dev/null 2>&1 \
  || ibmcloud ce project create --name "$PROJECT" --wait

echo "==> ensuring ICR namespace '$CR_NAMESPACE' + CE registry secret '$REGISTRY_SECRET'"
ibmcloud cr region-set eu-central >/dev/null 2>&1 || true
ibmcloud cr namespace-add "$CR_NAMESPACE" >/dev/null 2>&1 || true
ibmcloud ce secret get --name "$REGISTRY_SECRET" >/dev/null 2>&1 \
  || ibmcloud ce registry create --name "$REGISTRY_SECRET" --server "$CR_REGISTRY" \
       --username iamapikey --password "$IBMCLOUD_API_KEY"

echo "==> ensuring CE secret '$COS_SECRET' (COS credentials)"
ibmcloud ce secret get --name "$COS_SECRET" >/dev/null 2>&1 \
  || ibmcloud ce secret create --name "$COS_SECRET" \
       --from-literal "COS_HMAC_ACCESS_KEY_ID=$COS_HMAC_ACCESS_KEY_ID" \
       --from-literal "COS_HMAC_SECRET_ACCESS_KEY=$COS_HMAC_SECRET_ACCESS_KEY" \
       --from-literal "COS_ENDPOINT_DIRECT=${COS_ENDPOINT_DIRECT:-}" \
       --from-literal "COS_ENDPOINT=${COS_ENDPOINT:-}" \
       --from-literal "COS_BUCKET=$COS_BUCKET" \
       --from-literal "IBM_COS_REGION=$REGION"

echo "==> bundling service"
npx tsx experiments/e3-service/build.mjs

# Code Engine builds the image in-cloud from the local source (no local docker).
# --min-scale 0 / --max-scale 1 / --concurrency 1 are the direct analogs of the
# Cloud Run --min-instances=0 / --max-instances=1 / --concurrency=1 flags and
# match the single-writer lease model.
CMD=(application)
if ibmcloud ce application get --name "$APP" >/dev/null 2>&1; then CMD+=(update); else CMD+=(create); fi

echo "==> ${CMD[1]} Code Engine application '$APP' (prefix=$DB_PREFIX)"
ARGS=(
  --name "$APP"
  --port 8080
  --cpu 1 --memory 2G
  --min-scale 0 --max-scale 1 --concurrency 1
  --env-from-secret "$COS_SECRET"
  --env "ZEROPG_PREFIX=${DB_PREFIX}"
  --env "APP_LABEL=${APP_LABEL}"
  --env "ZEROPG_DURABILITY=${DURABILITY:-sleep}"
  --env "ZEROPG_IDLE_FLUSH_MS=25000"
  --wait
)
if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  ARGS+=(--image "$IMAGE")
else
  ARGS+=(--build-source ./experiments/e3-service --build-strategy dockerfile \
         --build-dockerfile Dockerfile --image "$IMAGE" --registry-secret "$REGISTRY_SECRET")
fi
ibmcloud ce "${CMD[@]}" "${ARGS[@]}"

URL=$(ibmcloud ce application get --name "$APP" --output jsonpath='{.status.url}')
echo "==> deployed: $URL"
