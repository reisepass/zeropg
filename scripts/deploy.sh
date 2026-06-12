#!/usr/bin/env bash
# Build the service image with Cloud Build and deploy a scale-to-zero Cloud Run
# service. One image, parameterized per deployment by env vars.
#
#   scripts/deploy.sh <service-name> <db-prefix> <app-label> [extra gcloud run flags...]
set -euo pipefail

PROJECT=blob-pglite
REGION=europe-west1
REPO=zeropg
BUCKET=zeropg-experiments-euw1
SA=blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/service:latest"

SERVICE="${1:?service name required}"
DB_PREFIX="${2:?db prefix required}"
APP_LABEL="${3:?app label required}"
shift 3 || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> bundling service"
npx tsx experiments/e3-service/build.mjs

echo "==> building image via Cloud Build (async; this SA can't stream logs): $IMAGE"
# The build SA isn't a project Viewer, so gcloud can't stream logs and would
# exit non-zero even on a successful build. Submit async and poll status.
BUILD_ID=$(gcloud builds submit experiments/e3-service \
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

echo "==> deploying Cloud Run service: $SERVICE (prefix=$DB_PREFIX)"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=1 \
  --cpu=1 \
  --memory=1Gi \
  --timeout=60 \
  --set-env-vars "ZEROPG_BUCKET=${BUCKET},ZEROPG_PREFIX=${DB_PREFIX},APP_LABEL=${APP_LABEL}" \
  "$@"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo "==> deployed: $URL"
