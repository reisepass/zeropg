#!/usr/bin/env bash
# Deploy PrivateBin on Cloud Run with zeropg sidecar.
#
# Prerequisites:
#   - zeropg-sidecar image published by the foundation agent:
#       europe-west1-docker.pkg.dev/blob-pglite/zeropg/zeropg-sidecar:latest
#   - gcloud authenticated as blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
#
# Usage: bash apps/privatebin/deploy.sh [--verify]
set -euo pipefail

PROJECT=blob-pglite
REGION=europe-west1
SA=blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
SERVICE=privatebin-zeropg
SECRET_NAME=privatebin-conf-php
SIDECAR_IMAGE=europe-west1-docker.pkg.dev/${PROJECT}/zeropg/zeropg-sidecar:latest

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$ROOT/apps/privatebin"
VERIFY="${1:-}"

echo "==> checking zeropg-sidecar image exists"
gcloud artifacts docker images describe "${SIDECAR_IMAGE}" \
  --project "${PROJECT}" --quiet >/dev/null 2>&1 || {
  echo "ERROR: zeropg-sidecar image not found: ${SIDECAR_IMAGE}"
  echo "       Wait for the foundation agent to publish it, then re-run."
  exit 1
}
echo "    image found"

echo "==> upserting Secret Manager secret: ${SECRET_NAME}"
if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud secrets versions add "${SECRET_NAME}" \
    --data-file="${APP_DIR}/conf.php" \
    --project "${PROJECT}"
  echo "    added new version"
else
  gcloud secrets create "${SECRET_NAME}" \
    --data-file="${APP_DIR}/conf.php" \
    --replication-policy=user-managed \
    --locations="${REGION}" \
    --project "${PROJECT}"
  echo "    created"
fi

echo "==> granting service account access to the secret"
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --member="serviceAccount:${SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --project "${PROJECT}" \
  --quiet

echo "==> deploying Cloud Run service: ${SERVICE}"
gcloud run services replace "${APP_DIR}/service.yaml" \
  --project "${PROJECT}" \
  --region "${REGION}"

echo "==> making service publicly accessible"
gcloud run services add-iam-policy-binding "${SERVICE}" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --region "${REGION}" \
  --project "${PROJECT}" \
  --quiet

URL=$(gcloud run services describe "${SERVICE}" \
  --region "${REGION}" --project "${PROJECT}" \
  --format='value(status.url)')
echo "==> deployed: ${URL}"

if [[ "${VERIFY:-}" == "--verify" ]]; then
  echo ""
  echo "==> verifying end-to-end (cold start + paste round-trip)"
  bash "${APP_DIR}/verify.sh" "${URL}"
fi
