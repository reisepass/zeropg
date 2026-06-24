#!/bin/sh
# Frontend entrypoint. The FIRST thing we do, before the static server even
# starts serving, is fire a server-side fire-and-forget WAKE at the backend so it
# begins cold-starting in PARALLEL the instant this frontend instance comes up -
# even before any browser loads and runs its own /wake. Best-effort: a failure
# never blocks the frontend from serving the shell.
set -e

if [ -n "${AIRTABLE_API}" ]; then
  echo "[frontend-entrypoint] firing wake at ${AIRTABLE_API}/wake (background)"
  ( wget -q -T 8 -O /dev/null "${AIRTABLE_API}/wake" >/dev/null 2>&1 || true ) &
fi

exec /frontend
