#!/usr/bin/env bash
# Build + deploy the nightly demo-reset Cloud Run JOB and its 04:10 UTC daily
# Cloud Scheduler trigger. The job (scripts/nightly-reset/reset.ts) fences each
# live demo's bucket prefix, resets the DB content, rolls the service, and
# smoke-tests the public URL. See the header of reset.ts for the mechanism.
#
#   scripts/deploy-nightly-reset.sh [extra gcloud run jobs flags...]
#
# Env knobs:
#   SKIP_BUILD=1     reuse the already-pushed :latest image
#   SKIP_IAM=1       skip the one-time IAM grants
#   SKIP_SCHEDULER=1 deploy/update the job only
set -euo pipefail

PROJECT=blob-pglite
REGION=europe-west1
REPO=zeropg
SA=blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/nightly-reset:latest"
JOB=nightly-demo-reset

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> bundling nightly-reset"
  npx tsx scripts/nightly-reset/build.mjs

  echo "==> building image via Cloud Build (async; this SA can't stream logs): $IMAGE"
  BUILD_ID=$(gcloud builds submit scripts/nightly-reset \
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

if [[ "${SKIP_IAM:-}" != "1" ]]; then
  echo "==> one-time IAM: the job's SA rolls services (run.developer) and must actAs itself"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${SA}" --role roles/run.developer --condition=None >/dev/null
  gcloud iam service-accounts add-iam-policy-binding "$SA" \
    --member "serviceAccount:${SA}" --role roles/iam.serviceAccountUser --project "$PROJECT" >/dev/null
fi

echo "==> deploying Cloud Run job: $JOB"
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
  --memory 2Gi \
  --cpu 1 \
  --task-timeout 3600 \
  --max-retries 0 \
  "$@"

if [[ "${SKIP_SCHEDULER:-}" != "1" ]]; then
  echo "==> scheduler trigger: daily 04:10 UTC"
  gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT" >/dev/null
  SCHED_ARGS=(
    --project "$PROJECT"
    --location "$REGION"
    --schedule "10 4 * * *"
    --time-zone "Etc/UTC"
    --uri "https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
    --http-method POST
    --oauth-service-account-email "$SA"
    --attempt-deadline 1800s
  )
  if gcloud scheduler jobs describe "$JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$JOB" "${SCHED_ARGS[@]}"
  else
    gcloud scheduler jobs create http "$JOB" "${SCHED_ARGS[@]}"
  fi
fi

echo "==> done. Run once now with: gcloud run jobs execute $JOB --region $REGION --project $PROJECT"
