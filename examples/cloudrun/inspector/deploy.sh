#!/usr/bin/env bash
# Deploy the zeropg inspector = `zeropg console --inspector` from this repo:
# stage the monorepo subset as the build context, build both images, mint the
# token secret if absent, roll the service. Run from the repo root:
#   bash examples/cloudrun/inspector/deploy.sh
set -euo pipefail
PROJECT=blob-pglite
REGION=europe-west1
REPO=europe-west1-docker.pkg.dev/$PROJECT/zeropg
DIR="$(dirname "$0")"

echo "== stage the build context (monorepo subset the console needs)"
# The console + replica-wire code is not published to npm, so the image builds
# from the repo tree. Stage into a temp dir so the context is small and clean
# (no examples/, no experiments/, no .git).
CTX=$(mktemp -d)
cp "$DIR/Dockerfile" package.json package-lock.json tsconfig.json "$CTX/"
cp -r packages "$CTX/packages"

echo "== build images"
gcloud builds submit "$CTX" --project $PROJECT --tag $REPO/zeropg-inspector:latest --quiet
gcloud builds submit "$DIR/adminer" --project $PROJECT --tag $REPO/zeropg-inspector-adminer:latest --quiet

echo "== token secret (created once, reused after)"
if ! gcloud secrets describe inspector-token --project $PROJECT >/dev/null 2>&1; then
  openssl rand -hex 24 | tr -d '\n' | gcloud secrets create inspector-token --project $PROJECT --data-file=-
fi
# The inspector-targets secret is gone: targets come from LIVE fleet discovery
# inside the service (the runtime SA's ADC), with INSPECTOR_TARGETS env JSON
# only as a manual fallback if discovery ever breaks.

echo "== roll the service (pin images by digest - :latest alone does not roll a revision)"
DIGEST_APP=$(gcloud artifacts docker images describe $REPO/zeropg-inspector:latest --project $PROJECT --format='value(image_summary.digest)')
DIGEST_ADM=$(gcloud artifacts docker images describe $REPO/zeropg-inspector-adminer:latest --project $PROJECT --format='value(image_summary.digest)')
SPEC=$(mktemp)
sed -e "s|zeropg-inspector:latest|zeropg-inspector@$DIGEST_APP|" \
    -e "s|zeropg-inspector-adminer:latest|zeropg-inspector-adminer@$DIGEST_ADM|" \
    "$DIR/service.yaml" > "$SPEC"
gcloud run services replace "$SPEC" --project $PROJECT --region $REGION --quiet
gcloud run services add-iam-policy-binding zeropg-inspector --project $PROJECT --region $REGION \
  --member=allUsers --role=roles/run.invoker --quiet >/dev/null

URL=$(gcloud run services describe zeropg-inspector --project $PROJECT --region $REGION --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret inspector-token --project $PROJECT)
echo
echo "inspector: $URL/?t=$TOKEN"
echo "(the token is the only door - treat that link as a credential)"
