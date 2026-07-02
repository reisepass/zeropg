#!/usr/bin/env bash
# E5 (EXPERIMENTS.md): 72h soak + real-bill reconciliation. Deploys:
#   1. a DEDICATED bucket (zeropg-e5-soak-euw1, labeled purpose=e5-soak) so the
#      storage + operations bill lines are cleanly attributable to the soak
#   2. the soak target: one more e3-service deployment (zeropg-e5-soak), same
#      image and knobs as the public demos, labeled purpose=e5-soak
#   3. the burst driver as a Cloud Run job (e5-soak-burst) + a Cloud Scheduler
#      trigger every 20 minutes; each execution is one traffic slot and decides
#      deterministically from the slot number whether it carries traffic
#      (long-tail profile, ~9-10 bursts/day). See experiments/e5-soak/burst.mjs.
#
# Runbook: docs/E5-SOAK.md. Teardown after 72h+:
#   gcloud scheduler jobs delete e5-soak-burst --location europe-west1
#
# Env knobs:
#   SKIP_BUILD=1   reuse the already-pushed driver image
set -euo pipefail

PROJECT=blob-pglite
REGION=europe-west1
REPO=zeropg
SA=blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
SOAK_BUCKET=zeropg-e5-soak-euw1
SERVICE=zeropg-e5-soak
JOB=e5-soak-burst
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/e5-soak-burst:latest"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> dedicated soak bucket: gs://${SOAK_BUCKET}"
if ! gcloud storage buckets describe "gs://${SOAK_BUCKET}" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${SOAK_BUCKET}" \
    --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access
fi
gcloud storage buckets update "gs://${SOAK_BUCKET}" --update-labels purpose=e5-soak >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${SOAK_BUCKET}" \
  --member "serviceAccount:${SA}" --role roles/storage.objectAdmin >/dev/null

echo "==> soak target service: ${SERVICE} (same image + knobs as the public demos)"
SKIP_BUILD=1 BUCKET="$SOAK_BUCKET" DURABILITY=sleep bash scripts/deploy.sh \
  "$SERVICE" "e5/soak" "zeropg E5 soak" --labels purpose=e5-soak

TARGET_URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> building driver image via Cloud Build: $IMAGE"
  BUILD_ID=$(gcloud builds submit experiments/e5-soak \
    --tag "$IMAGE" --project "$PROJECT" --region "$REGION" --async \
    --format='value(id)')
  echo "    build id: $BUILD_ID"
  while :; do
    ST=$(gcloud builds describe "$BUILD_ID" --region "$REGION" --project "$PROJECT" --format='value(status)')
    echo "    build status: $ST"
    case "$ST" in
      SUCCESS) break ;;
      FAILURE|TIMEOUT|CANCELLED) echo "build failed: $ST"; exit 1 ;;
    esac
    sleep 10
  done
fi

echo "==> driver job: ${JOB} -> ${TARGET_URL}"
if gcloud run jobs describe "$JOB" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  VERB=update
else
  VERB=create
fi
gcloud run jobs "$VERB" "$JOB" \
  --image "$IMAGE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --service-account "$SA" \
  --memory 512Mi \
  --cpu 1 \
  --task-timeout 900 \
  --max-retries 0 \
  --labels purpose=e5-soak-driver \
  --set-env-vars "TARGET_URL=${TARGET_URL}"

echo "==> scheduler trigger: every 20 minutes"
gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT" >/dev/null
SCHED_ARGS=(
  --project "$PROJECT"
  --location "$REGION"
  --schedule "*/20 * * * *"
  --time-zone "Etc/UTC"
  --uri "https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
  --http-method POST
  --oauth-service-account-email "$SA"
  --attempt-deadline 900s
)
if gcloud scheduler jobs describe "$JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${SCHED_ARGS[@]}"
else
  gcloud scheduler jobs create http "$JOB" "${SCHED_ARGS[@]}"
fi

echo "==> done. Soak target: ${TARGET_URL}"
echo "    force a burst now: gcloud run jobs execute $JOB --region $REGION --project $PROJECT --update-env-vars FORCE=1 (then unset)"
