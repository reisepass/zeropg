#!/bin/sh
# Pack the workspace @zeropg/client (with the serveWire extensions feature) into
# the zeropg-db build context, so this example builds without needing the package
# published to npm. Run this once before `docker compose build`.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
( cd "$ROOT" && npm pack -w @zeropg/client --pack-destination "$HERE/zeropg-db" >/dev/null )
echo "packed @zeropg/client -> zeropg-db/zeropg-client-0.0.1.tgz"
echo "now run:  docker compose up --build"
