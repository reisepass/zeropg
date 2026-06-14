#!/usr/bin/env bash
# Build + deploy the zeropg loadtest-service (experiments/loadtest-service) to
# Cloud Run, backed by the GCS bucket. This is the continuously-writing app used
# to stress the single-writer lease under real contention.
#
#   scripts/deploy-loadtest.sh [service] [db-prefix] [app-label] [extra gcloud flags...]
#
# Unlike scripts/deploy.sh (which builds experiments/e3-service), this builds the
# loadtest-service image. To force real lease contention you point >1 writer at
# the SAME prefix — e.g. bump --max-instances and lower --concurrency so Cloud
# Run runs several instances, and/or run a local writer against the same prefix.
#
# Env knobs:
#   DURABILITY=strict|interval|sleep   default strict (every sim write is a CAS)
#   MAX_INSTANCES=N                    default 1 (set >1 to force in-cloud contention)
#   LOADTEST_RPS=N                     background simulator writes/sec (default 3)
#   SKIP_BUILD=1                       reuse the already-pushed :latest image
set -euo pipefail

PROJECT=blob-pglite
REGION=europe-west1
REPO=zeropg
BUCKET=zeropg-experiments-euw1
SA=blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/loadtest-service:latest"

SERVICE="${1:-zeropg-loadtest}"
DB_PREFIX="${2:-demo/loadtest}"
APP_LABEL="${3:-zeropg loadtest (single-writer stress)}"
shift 3 2>/dev/null || true

MAX_INSTANCES="${MAX_INSTANCES:-1}"
LOADTEST_RPS="${LOADTEST_RPS:-3}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> bundling loadtest-service"
  npx tsx experiments/loadtest-service/build.mjs

  echo "==> building image via Cloud Build (async): $IMAGE"
  BUILD_ID=$(gcloud builds submit experiments/loadtest-service \
    --tag "$IMAGE" --project "$PROJECT" --region "$REGION" --async \
    --format='value(id)')
  echo "    build id: $BUILD_ID"
  while :; do
    ST=$(gcloud builds describe "$BUILD_ID" --region "$REGION" --format='value(status)')
    echo "    build status: $ST"
    case "$ST" in
      SUCCESS) break ;;
      FAILURE|TIMEOUT|CANCELLED) echo "build failed: $ST"; exit 1 ;;
    esac
    sleep 10
  done
fi

echo "==> deploying Cloud Run service: $SERVICE (prefix=$DB_PREFIX, max-instances=$MAX_INSTANCES)"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances="$MAX_INSTANCES" \
  --concurrency=1 \
  --cpu=1 \
  --memory=1Gi \
  --timeout=60 \
  --cpu-boost \
  --set-env-vars "ZEROPG_BUCKET=${BUCKET},ZEROPG_PREFIX=${DB_PREFIX},APP_LABEL=${APP_LABEL},ZEROPG_DURABILITY=${DURABILITY:-strict},LOADTEST_RPS=${LOADTEST_RPS}" \
  "$@"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo "==> deployed: $URL"
