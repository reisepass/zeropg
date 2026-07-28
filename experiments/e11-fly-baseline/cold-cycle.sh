#!/usr/bin/env bash
# E11 step 2 + 3: what does a client actually experience against a STOPPED Fly
# Machine, and how long is the whole cold path?
#
#   cold-cycle.sh <app> <machine-id> <host> [reps]
#
# Each rep: stop the Machine, confirm it is stopped, then dial. The question is
# whether the Fly proxy HOLDS the connection while the Machine boots (the E1
# counterpart, and the whole point of the experiment) or gives up.
#
# Both the raw-wire probe and real psql are run, because a hand-rolled client
# could differ from libpq in timeout behaviour and the user-facing claim depends
# on libpq specifically. The retry after the failure is timed too: if the first
# attempt reliably fails and the second reliably succeeds, the platform is
# usable but only behind a retrying driver, which is a materially different
# product claim from "just works".
set -uo pipefail

APP="${1:?usage: cold-cycle.sh <app> <machine-id> <host> [reps]}"
MACHINE="${2:?}"
HOST="${3:?}"
REPS="${4:-3}"

export PATH="$HOME/.fly/bin:$PATH"
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat "$HOME/.fly_token")}"
HERE="$(cd "$(dirname "$0")" && pwd)"

for i in $(seq 1 "$REPS"); do
  echo "=============== rep $i/$REPS ==============="
  flyctl machines stop "$MACHINE" -a "$APP" >/dev/null 2>&1
  # Poll until genuinely stopped; dialing a still-stopping Machine would
  # measure the wrong thing.
  for _ in $(seq 1 40); do
    st=$(flyctl machines list -a "$APP" --json 2>/dev/null \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['state'] if d else 'none')")
    [ "$st" = "stopped" ] && break
    sleep 2
  done
  echo "machine state before dial: $st  ($(date -u +%H:%M:%SZ))"

  echo "--- attempt 1: raw wire probe against the stopped Machine ---"
  node "$HERE/connect-timing.mjs" "$HOST" 5432 "cold-rep$i-attempt1"

  echo "--- attempt 2: immediate retry (Machine now waking/awake) ---"
  s=$(date +%s.%N)
  out=$(psql "postgres://postgres@${HOST}:5432/postgres?connect_timeout=60" -tAc "select 1;" 2>&1)
  e=$(date +%s.%N)
  echo "retry: $(echo "$out" | tr -d '\n')  in $(echo "$e - $s" | bc)s"

  echo "--- same thing with real psql, from stopped, for the libpq-specific claim ---"
  flyctl machines stop "$MACHINE" -a "$APP" >/dev/null 2>&1
  for _ in $(seq 1 40); do
    st=$(flyctl machines list -a "$APP" --json 2>/dev/null \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['state'] if d else 'none')")
    [ "$st" = "stopped" ] && break
    sleep 2
  done
  s=$(date +%s.%N)
  out=$(psql "postgres://postgres@${HOST}:5432/postgres?connect_timeout=60" -tAc "select 1;" 2>&1)
  e=$(date +%s.%N)
  echo "psql cold attempt 1: $(echo "$out" | tr -d '\n' | head -c 160)"
  echo "                     in $(echo "$e - $s" | bc)s"
  echo
done
