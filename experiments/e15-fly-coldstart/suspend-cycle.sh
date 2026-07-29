#!/usr/bin/env bash
# E15 experiment 2: resume time-to-first-row, against the stop baseline, over a
# range of idle gaps.
#
#   suspend-cycle.sh <app> <machine-id> <host> <label> <idle-seconds> [stop|suspend]
#
# The gap is the variable. Fly documents that a snapshot "isn't guaranteed to
# persist" - host migration, maintenance or space reclamation can turn what
# should have been a resume into a cold boot - but documents no TTL. So the
# question is not "how fast is a resume" (one measurement answers that) but "how
# often is it still a resume after N minutes", and only a spread of gaps can say.
#
# Every rep records THREE things, because the latency number alone is not
# interpretable without them:
#
#   the state Fly reports after the gap  - a Machine that fell out of `suspended`
#                                          on its own is the fallback case
#   whether the guest saw a freeze       - /trace's resume detector. A resume
#                                          leaves the ORIGINAL process running,
#                                          so its boot stamps are unchanged and
#                                          the wall clock jumped. A fallback cold
#                                          boot has fresh stamps and no jump.
#                                          This is what makes "was it really a
#                                          resume" a measurement, not an
#                                          inference from a fast number.
#   the client's phase split             - what a user actually experiences
#
# A fast number with fresh boot stamps would be a cold start that happened to be
# quick, and reporting it as a resume would be the mistake this script exists to
# prevent.
set -uo pipefail

APP="${1:?usage: suspend-cycle.sh <app> <machine> <host> <label> <idle-s> [stop|suspend]}"
MACHINE="${2:?}"
HOST="${3:?}"
LABEL="${4:?}"
IDLE_S="${5:?}"
MODE="${6:-suspend}"

export PATH="$HOME/.fly/bin:$PATH"
export FLY_API_TOKEN="${FLY_API_TOKEN:-$(cat "$HOME/.fly_token")}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT_DIR:-/tmp/e15}"
mkdir -p "$OUT"

state() {
  flyctl machines list -a "$APP" --json 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['state'] if d else 'none')"
}

echo "=== $LABEL: mode=$MODE idle=${IDLE_S}s ==="

# Make sure it is RUNNING first. Suspending an already-stopped Machine is a
# no-op that would silently measure a cold boot under a "resume" label.
if [ "$(state)" != "started" ]; then
  echo "machine not started; waking it first"
  flyctl machines start "$MACHINE" -a "$APP" >/dev/null 2>&1
  for _ in $(seq 1 60); do [ "$(state)" = "started" ] && break; sleep 2; done
  # Let the boot finish, so the thing being suspended is a fully-open database
  # rather than one mid-restore.
  for _ in $(seq 1 30); do
    curl -sf --max-time 5 "http://${HOST}:8081/read" >/dev/null 2>&1 && break
    sleep 2
  done
fi

if [ "$MODE" = "suspend" ]; then
  flyctl machines suspend "$MACHINE" -a "$APP" >/dev/null 2>&1
  WANT="suspended"
else
  flyctl machines stop "$MACHINE" -a "$APP" >/dev/null 2>&1
  WANT="stopped"
fi
for _ in $(seq 1 60); do [ "$(state)" = "$WANT" ] && break; sleep 2; done
ST_BEFORE=$(state)
echo "state after $MODE: $ST_BEFORE (wanted $WANT) at $(date -u +%H:%M:%SZ)"

if [ "$IDLE_S" -gt 0 ]; then
  echo "holding for ${IDLE_S}s ..."
  sleep "$IDLE_S"
fi
ST_AFTER=$(state)
echo "state after ${IDLE_S}s idle: $ST_AFTER"

LOGF="$OUT/${LABEL}.proxy.log"
: > "$LOGF"
flyctl logs -a "$APP" >> "$LOGF" 2>&1 &
LOGPID=$!
sleep 3

echo "dialing at $(date -u +%H:%M:%S.%3NZ)"
node "$HERE/connect-timing.mjs" "$HOST" 5432 "$LABEL" | tee "$OUT/${LABEL}.client.json"

sleep 4
curl -s --max-time 30 "http://${HOST}:8081/trace" > "$OUT/${LABEL}.trace.json" 2>/dev/null

sleep 3
kill "$LOGPID" 2>/dev/null; wait "$LOGPID" 2>/dev/null

# The verdict: resume or cold boot? Decided from the guest's own evidence, not
# from how fast the number looked.
python3 - "$OUT/${LABEL}.trace.json" "$ST_BEFORE" "$ST_AFTER" "$IDLE_S" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"  VERDICT: unknown (no trace: {e})"); sys.exit()
resumes = d.get('resumes') or []
boot = next((s for s in d['stamps'] if s['event'] == 'proc-start'), None)
print(f"  state before gap : {sys.argv[2]}")
print(f"  state after gap  : {sys.argv[3]}  (gap {sys.argv[4]}s)")
print(f"  original boot at : {boot['at'] if boot else '?'}")
print(f"  guest freezes    : {[r['frozenS'] for r in resumes]}")
print(f"  kernel uptime now: {d.get('kernelUptimeNowMs')} ms")
# A resume keeps the ORIGINAL process, so its boot stamps predate the gap and a
# wall-clock jump was observed. A fallback cold boot has neither.
print("  VERDICT:", "RESUME (original process, freeze observed)" if resumes
      else "COLD BOOT (fresh process, no freeze seen) - snapshot did NOT survive")
PY

grep -aE "Starting machine|started in|became reachable|gave up|resum|suspend" "$LOGF" \
  | sed 's/\x1b\[[0-9;]*m//g' | tail -8
echo
