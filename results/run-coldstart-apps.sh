#!/usr/bin/env bash
# Repeated cold-start harness for the live scale-to-zero app demos (calcom dropped).
# Each round hits all apps cold; ~14min sleeps between rounds let instances scale to
# zero so the next round is a genuine cold start. Every reading appends to
# results/coldstart-apps.jsonl. Post-classify: time_total >8s = cold, <2s = was warm.
RES=/Users/user/workspace/zeropg/results/coldstart-apps.jsonl
declare -a APPS=(
  "privatebin|https://privatebin-scale-to-zero.0rs.org|120"
  "nocodb|https://nocodb-scale-to-zero.0rs.org|120"
  "rallly|https://rallly-scale-to-zero.0rs.org|120"
  "documenso|https://documenso-scale-to-zero.0rs.org|120"
  "pds|https://pds-scale-to-zero.0rs.org|120"
)
hit(){ local app=$1 url=$2 mt=$3 rnd=$4 out code t ts
  out=$(curl -o /dev/null -s -w "%{http_code} %{time_total}" --max-time "$mt" "$url" 2>/dev/null || echo "000 timeout")
  code=${out%% *}; t=${out##* }; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"ts\":\"$ts\",\"round\":$rnd,\"app\":\"$app\",\"http_code\":\"$code\",\"time_total_s\":$t}" >> "$RES"
}
sleep 840   # let current warmth scale to zero before round 1
for rnd in 1 2 3 4; do
  for pair in "${APPS[@]}"; do
    IFS='|' read -r a u m <<< "$pair"; hit "$a" "$u" "$m" "$rnd"
  done
  [ "$rnd" -lt 4 ] && sleep 840
done
echo "## harness done $(date -u +%H:%M:%S)Z"
