#!/usr/bin/env bash
# E15 experiment 1: one cold cycle, with both halves of the timeline captured.
#
#   cold-cycle.sh <app> <machine-id> <host> <label> [mode]
#     mode: stop (default) | suspend
#
# E11 could only account for ~5.6s of a ~10.5s cold path because it had one
# clock: the client's. This captures three and joins them:
#
#   the CLIENT's view   connect-timing.mjs phase split (TCP / SSL-neg / startup /
#                       query), which is the number a user actually experiences.
#   the PROXY's view    `flyctl logs`, which prints "Starting machine",
#                       "machine started in Xs" and "machine became reachable in
#                       Ys". This is the only source for what Fly did BEFORE the
#                       guest kernel existed.
#   the GUEST's view    GET /trace, which stamps kernel-boot -> node-exec ->
#                       first user code -> PGlite import -> ZeroPG.open phases ->
#                       wire listening.
#
# Logs are collected in the BACKGROUND FOR THE WHOLE CYCLE rather than fetched
# afterwards. `flyctl logs` is a tail, not a query: run after the fact it shows
# what is arriving now, and the "Starting machine" line - the one that anchors
# the proxy timeline - would already be gone.
set -uo pipefail

APP="${1:?usage: cold-cycle.sh <app> <machine-id> <host> <label> [stop|suspend]}"
MACHINE="${2:?}"
HOST="${3:?}"
LABEL="${4:?}"
MODE="${5:-stop}"

export PATH="$HOME/.fly/bin:$PATH"
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat "$HOME/.fly_token")}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT_DIR:-/tmp/e15}"
mkdir -p "$OUT"

echo "=== $LABEL (mode=$MODE) ==="

# Park the Machine in the state under test. `suspend` and `stop` are different
# API calls, not a flag on one call: suspend snapshots RAM, stop discards it.
if [ "$MODE" = "suspend" ]; then
  flyctl machines suspend "$MACHINE" -a "$APP" >/dev/null 2>&1
  WANT="suspended"
else
  flyctl machines stop "$MACHINE" -a "$APP" >/dev/null 2>&1
  WANT="stopped"
fi

# Poll to the target state. Dialing a still-suspending Machine measures the
# transition rather than the resume.
st=""
for _ in $(seq 1 60); do
  st=$(flyctl machines list -a "$APP" --json 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['state'] if d else 'none')")
  [ "$st" = "$WANT" ] && break
  sleep 2
done
echo "state before dial: $st (wanted $WANT) at $(date -u +%H:%M:%S.%3NZ)"
if [ "$st" != "$WANT" ]; then
  echo "WARN: machine did not reach $WANT; this rep measures something else"
fi

# Optional idle gap. Experiment 2 asks whether a snapshot decays with time, and
# that question is only answerable by holding the Machine in state for a while.
if [ -n "${IDLE_S:-}" ] && [ "${IDLE_S}" -gt 0 ]; then
  echo "holding $WANT for ${IDLE_S}s..."
  sleep "${IDLE_S}"
  st=$(flyctl machines list -a "$APP" --json 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['state'] if d else 'none')")
  # Fly does not guarantee a snapshot survives; a machine that fell out of
  # `suspended` on its own is the fallback case, and it must be visible in the
  # record rather than averaged into the resume numbers.
  echo "state after ${IDLE_S}s idle: $st"
fi

# Start the log tail BEFORE the dial, so "Starting machine" is captured.
LOGF="$OUT/${LABEL}.proxy.log"
: > "$LOGF"
flyctl logs -a "$APP" >> "$LOGF" 2>&1 &
LOGPID=$!
sleep 3   # let the tail attach; a dial before it is live loses the anchor line

DIAL_AT=$(date -u +%H:%M:%S.%3NZ)
echo "dialing at $DIAL_AT"
node "$HERE/connect-timing.mjs" "$HOST" 5432 "$LABEL" | tee "$OUT/${LABEL}.client.json"

# Give the guest a moment to finish booting if the client gave up early, then
# read its self-report.
sleep 5
curl -s --max-time 30 "http://${HOST}:8081/trace" > "$OUT/${LABEL}.trace.json" 2>/dev/null \
  && echo "trace captured" || echo "trace NOT captured"

sleep 5
kill "$LOGPID" 2>/dev/null
wait "$LOGPID" 2>/dev/null

echo "--- proxy lines that anchor the timeline ---"
grep -E "Starting machine|machine started in|became reachable|waiting for machine|gave up|Resuming|resumed|suspend" "$LOGF" \
  | head -20

echo "dial was at $DIAL_AT"
echo "artifacts: $OUT/${LABEL}.{client.json,trace.json,proxy.log}"
echo
