#!/bin/sh
# Startup/liveness probe for the zeropg sidecar.
# Polls /ready on the HTTP control face (same port as $PORT, default 8080).
# Returns 0 when {"ready":true}, 1 otherwise.
# Cloud Run uses this as the startup probe for container dependency ordering:
# the app container will not start until this passes.
PORT="${PORT:-8080}"
result=$(wget -qO- --timeout=5 "http://127.0.0.1:${PORT}/ready" 2>/dev/null) || exit 1
echo "$result" | grep -q '"ready":true' && exit 0 || exit 1
