#!/usr/bin/env bash
# Deploy the zeropg fleet inspector: build both images, refresh the targets
# secret from live fleet discovery, mint the token secret if absent, roll the
# service. Run from the repo root:  bash examples/cloudrun/inspector/deploy.sh
set -euo pipefail
PROJECT=blob-pglite
REGION=europe-west1
REPO=europe-west1-docker.pkg.dev/$PROJECT/zeropg
DIR="$(dirname "$0")"

echo "== build images"
gcloud builds submit "$DIR" --project $PROJECT --tag $REPO/zeropg-inspector:latest --quiet
gcloud builds submit "$DIR/adminer" --project $PROJECT --tag $REPO/zeropg-inspector-adminer:latest --quiet

echo "== token secret (created once, reused after)"
if ! gcloud secrets describe inspector-token --project $PROJECT >/dev/null 2>&1; then
  openssl rand -hex 24 | tr -d '\n' | gcloud secrets create inspector-token --project $PROJECT --data-file=-
fi

echo "== targets secret from live fleet discovery"
npx tsx packages/cli/src/zeropg.ts fleet ls --json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([{"name":i["name"],"prefix":i["prefix"]} for i in d["instances"] if i.get("bucket")=="zeropg-experiments-euw1" and i.get("prefix")]))' \
  | tr -d '\n' \
  | gcloud secrets versions add inspector-targets --project $PROJECT --data-file=- 2>/dev/null \
  || { npx tsx packages/cli/src/zeropg.ts fleet ls --json \
       | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps([{"name":i["name"],"prefix":i["prefix"]} for i in d["instances"] if i.get("bucket")=="zeropg-experiments-euw1" and i.get("prefix")]))' \
       | tr -d '\n' \
       | gcloud secrets create inspector-targets --project $PROJECT --data-file=-; }

echo "== roll the service"
gcloud run services replace "$DIR/service.yaml" --project $PROJECT --region $REGION --quiet
gcloud run services add-iam-policy-binding zeropg-inspector --project $PROJECT --region $REGION \
  --member=allUsers --role=roles/run.invoker --quiet >/dev/null

URL=$(gcloud run services describe zeropg-inspector --project $PROJECT --region $REGION --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret inspector-token --project $PROJECT)
echo
echo "inspector: $URL/?t=$TOKEN"
echo "(the token is the only door - treat that link as a credential)"
