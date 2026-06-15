#!/usr/bin/env bash
# Deploy Cal.com backed by zeropg sidecar on Cloud Run (scale-to-zero).
# Run from any directory; the script resolves its own location.
set -euo pipefail

PROJECT=blob-pglite
REGION=europe-west1
SA=blob-pglite-dev@blob-pglite.iam.gserviceaccount.com
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Secrets ───────────────────────────────────────────────────────────────
# Create if absent; idempotent (add-iam-policy-binding is also idempotent).

create_secret() {
  local name=$1 value=$2
  if gcloud secrets describe "$name" --project="$PROJECT" &>/dev/null; then
    echo "[secrets] $name already exists — skipping create"
  else
    echo "[secrets] creating $name"
    printf '%s' "$value" | gcloud secrets create "$name" \
      --project="$PROJECT" \
      --replication-policy=automatic \
      --data-file=-
  fi
  # Grant the Cloud Run SA access
  gcloud secrets add-iam-policy-binding "$name" \
    --project="$PROJECT" \
    --member="serviceAccount:$SA" \
    --role=roles/secretmanager.secretAccessor \
    --quiet
}

# Generate secrets on first run; subsequent runs reuse existing values.
NEXTAUTH_SECRET="${CALCOM_NEXTAUTH_SECRET:-$(openssl rand -base64 32)}"
ENCRYPTION_KEY="${CALCOM_ENCRYPTION_KEY:-$(openssl rand -base64 24)}"

create_secret calcom-nextauth-secret  "$NEXTAUTH_SECRET"
create_secret calcom-encryption-key   "$ENCRYPTION_KEY"

# ── 2. Ensure bucket prefix exists (zeropg creates objects lazily, no-op) ────
# Nothing to provision — zeropg writes on first boot.

# ── 3. Deploy ────────────────────────────────────────────────────────────────
echo "[deploy] deploying zeropg-calcom to $REGION …"
gcloud run services replace "$DIR/cloudrun.yaml" \
  --region="$REGION" \
  --project="$PROJECT"

# ── 4. Allow unauthenticated access (public demo) ────────────────────────────
gcloud run services add-iam-policy-binding zeropg-calcom \
  --region="$REGION" \
  --project="$PROJECT" \
  --member=allUsers \
  --role=roles/run.invoker \
  --quiet

URL=$(gcloud run services describe zeropg-calcom \
  --region="$REGION" \
  --project="$PROJECT" \
  --format='value(status.url)')

echo ""
echo "✓ deployed: $URL"
echo ""
echo "Cold-start note: first request takes ~3-5 min (bucket restore + prisma migrate + Next.js boot)."
echo "Subsequent cold starts after scale-to-zero: ~2-3 min (data already in bucket)."
echo ""
echo "To enable Google Calendar integration, create a secret:"
echo "  printf '{\"web\":{\"client_id\":\"…\",\"client_secret\":\"…\"}}' | \\"
echo "    gcloud secrets create calcom-google-api-credentials --project=$PROJECT --data-file=-"
echo "Then uncomment GOOGLE_API_CREDENTIALS in cloudrun.yaml and set GOOGLE_LOGIN_ENABLED=true."
