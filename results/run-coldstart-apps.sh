#!/usr/bin/env bash
# Multi-round cold-start harness for the scale-to-zero Next.js demos.
# Each round hits the 3 apps cold; ~14min sleeps between rounds let instances
# scale to zero so the next round is a real cold start. Appends every raw data
# point to results/coldstart-apps.jsonl (don't-lose-info). Classify cold vs warm
# in post: time_total >8s = cold, <2s = the instance hadn't scaled down yet.
RES=/Users/user/workspace/zeropg/results/coldstart-apps.jsonl
declare -a APPS=(
  "rallly|https://rallly-zeropg-71428757273.europe-west1.run.app|90"
  "documenso|https://documenso-zeropg-71428757273.europe-west1.run.app|90"
  "calcom|https://calcom-zeropg-71428757273.europe-west1.run.app|200"
)
hit(){ local app=$1 url=$2 mt=$3 rnd=$4
  local out code t ts
  out=$(curl -o /dev/null -s -w "%{http_code} %{time_total}" --max-time "$mt" "$url" 2>/dev/null || echo "000 timeout")
  code=${out%% *}; t=${out##* }; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"ts\":\"$ts\",\"round\":$rnd,\"app\":\"$app\",\"http_code\":\"$code\",\"time_total_s\":$t}" >> "$RES"
  echo "round$rnd $app -> code=$code t=${t}s"
}
# let the one-shot's warming scale back to zero before round 1
sleep 840
for rnd in 1 2 3; do
  for pair in "${APPS[@]}"; do
    IFS='|' read -r a u m <<< "$pair"; hit "$a" "$u" "$m" "$rnd"
  done
  [ "$rnd" -lt 3 ] && sleep 840
done
echo "## harness done"
