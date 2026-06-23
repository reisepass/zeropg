#!/bin/sh
# Pack the workspace @zeropg/client into the zeropg-db build context, so this
# example builds without the package being published to npm. Run once before
# `docker compose up --build`. (The tarball is already committed in zeropg-db/ for
# convenience; re-run this to refresh it from the workspace.)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
( cd "$ROOT" && npm pack -w @zeropg/client --pack-destination "$HERE/zeropg-db" >/dev/null )
echo "packed @zeropg/client -> zeropg-db/zeropg-client-0.0.1.tgz"
echo "now run:  docker compose -p privatebin-zeropg up -d --build"
