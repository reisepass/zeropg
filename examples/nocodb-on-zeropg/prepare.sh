#!/bin/sh
# Pack the workspace @zeropg/client into the zeropg-db build context, so this
# example builds without needing the package published to npm. Run this once
# before `docker compose build`.
#
# (In this repo's shared setup the tarball is already pre-packed at
# /tmp/zeropg-pack-shared/zeropg-client-0.0.1.tgz — if it exists, just copy it.)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SHARED=/tmp/zeropg-pack-shared/zeropg-client-0.0.1.tgz
if [ -f "$SHARED" ]; then
  cp "$SHARED" "$HERE/zeropg-db/zeropg-client-0.0.1.tgz"
  echo "copied pre-packed @zeropg/client -> zeropg-db/zeropg-client-0.0.1.tgz"
else
  ROOT=$(cd "$HERE/../.." && pwd)
  ( cd "$ROOT" && npm pack -w @zeropg/client --pack-destination "$HERE/zeropg-db" >/dev/null )
  echo "packed @zeropg/client -> zeropg-db/zeropg-client-0.0.1.tgz"
fi
echo "now run:  docker compose -p nocodb-zeropg up -d --build"
