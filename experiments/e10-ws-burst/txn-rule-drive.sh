#!/usr/bin/env bash
# Drive the E10 transaction-rule proxy with a REAL psql session.
#
#   txn-rule-drive.sh <backend-host> <backend-port>
#
# The proxy (txn-rule.mjs) closes an idle tunnel after 3s, but only when
# ReadyForQuery reports 'I'. This script produces the three states that matter
# and lets a gap LONGER than the idle timer elapse in each, so the rule is
# actually exercised rather than merely present:
#
#   1. inside an open transaction  ('T') -> close must be REFUSED, COMMIT after
#      the gap must still succeed, and the row must be visible afterwards
#   2. inside a FAILED transaction ('E') -> close must be REFUSED
#   3. idle after COMMIT/ROLLBACK  ('I') -> close must be ALLOWED
#
# psql is fed from a FIFO so one session stays open across the sleeps. Feeding
# it a heredoc would let psql exit at EOF and close the session before the gap.
set -uo pipefail

BACKEND_HOST="${1:?usage: txn-rule-drive.sh <backend-host> <backend-port>}"
BACKEND_PORT="${2:?usage: txn-rule-drive.sh <backend-host> <backend-port>}"
PROXY_PORT="${3:-55432}"
IDLE_MS="${4:-3000}"
GAP="${5:-6}"

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/e10-txn-proxy.log
FIFO=$(mktemp -u /tmp/e10-psql-fifo.XXXXXX)
mkfifo "$FIFO"

echo "== starting transaction-rule proxy (idle close ${IDLE_MS}ms) =="
node "$HERE/txn-rule.mjs" "$BACKEND_HOST" "$BACKEND_PORT" "$PROXY_PORT" "$IDLE_MS" > "$LOG" 2>&1 &
PROXY_PID=$!
sleep 1

# Clean slate, through a direct connection so the proxy log only contains the
# transaction test itself.
psql "postgres://postgres@${BACKEND_HOST}:${BACKEND_PORT}/postgres?connect_timeout=30" \
  -qc "drop table if exists e10_txn; create table e10_txn(id int primary key, note text);" >/dev/null

echo "== opening one psql session THROUGH the proxy =="
psql "postgres://postgres@127.0.0.1:${PROXY_PORT}/postgres?connect_timeout=30" -a -e 2>&1 <"$FIFO" &
PSQL_PID=$!
exec 3>"$FIFO"

send() { echo "$1" >&3; sleep 1; }

echo "--- phase 1: open a transaction, then idle PAST the close timer ---"
send "BEGIN;"
send "INSERT INTO e10_txn VALUES (1, 'written inside the transaction');"
echo "    (sleeping ${GAP}s with ReadyForQuery='T'; close timer is ${IDLE_MS}ms)"
sleep "$GAP"
echo "--- phase 1b: COMMIT after the gap. It must succeed. ---"
send "COMMIT;"

echo "--- phase 2: a FAILED transaction, then idle PAST the close timer ---"
send "BEGIN;"
send "SELECT 1/0;"
echo "    (sleeping ${GAP}s with ReadyForQuery='E')"
sleep "$GAP"
send "ROLLBACK;"

echo "--- phase 3: now idle at 'I'. The close must be ALLOWED. ---"
sleep "$GAP"

exec 3>&-
sleep 1
kill "$PSQL_PID" 2>/dev/null
kill -TERM "$PROXY_PID" 2>/dev/null
sleep 1
rm -f "$FIFO" 2>/dev/null

echo
echo "== proxy decision log =="
cat "$LOG"

echo
echo "== did the committed row survive? (direct connection, not through the proxy) =="
psql "postgres://postgres@${BACKEND_HOST}:${BACKEND_PORT}/postgres?connect_timeout=30" \
  -c "select * from e10_txn;"

echo
echo "== assertions =="
FAIL=0
check() { # check <description> <condition-result>
  if [ "$2" = "1" ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; FAIL=1; fi
}

# The rule is only meaningfully tested if the proxy actually PARSED the
# transaction states. A run where every decision saw a null status is a broken
# instrument, not a passing test, so assert the states were observed.
grep -q '"status":"T"' "$LOG" && SAW_T=1 || SAW_T=0
grep -q '"status":"E"' "$LOG" && SAW_E=1 || SAW_E=0
grep -q '"status":"I"' "$LOG" && SAW_I=1 || SAW_I=0
check "proxy parsed ReadyForQuery='T' (in transaction)" "$SAW_T"
check "proxy parsed ReadyForQuery='E' (failed transaction)" "$SAW_E"
check "proxy parsed ReadyForQuery='I' (idle)" "$SAW_I"

# Refusals must have happened while genuinely inside a transaction, and must
# cite T or E rather than null.
grep -q '"event":"tunnel-close-REFUSED","readyForQueryStatus":"T"' "$LOG" && REF_T=1 || REF_T=0
grep -q '"event":"tunnel-close-REFUSED","readyForQueryStatus":"E"' "$LOG" && REF_E=1 || REF_E=0
check "close REFUSED while ReadyForQuery='T'" "$REF_T"
check "close REFUSED while ReadyForQuery='E'" "$REF_E"

# And the close must actually fire once the session returns to idle, otherwise
# the rule is just "never close", which is not the design.
grep -q '"event":"tunnel-close-ALLOWED","readyForQueryStatus":"I"' "$LOG" && ALLOW_I=1 || ALLOW_I=0
check "close ALLOWED once ReadyForQuery='I'" "$ALLOW_I"

# No close may ever have been authorised on a null / T / E status.
if grep '"event":"tunnel-close-ALLOWED"' "$LOG" | grep -qv '"readyForQueryStatus":"I"'; then
  BAD_ALLOW=0
else
  BAD_ALLOW=1
fi
check "no close ever ALLOWED on a non-'I' status" "$BAD_ALLOW"

# The committed row must be visible: the refusal has to have actually protected
# the transaction, not merely logged that it would.
ROW=$(psql "postgres://postgres@${BACKEND_HOST}:${BACKEND_PORT}/postgres?connect_timeout=30" \
  -tAc "select count(*) from e10_txn where id=1;")
[ "$ROW" = "1" ] && ROWOK=1 || ROWOK=0
check "row committed across the gap survived (count=1, got $ROW)" "$ROWOK"

echo
if [ "$FAIL" = "0" ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit "$FAIL"
