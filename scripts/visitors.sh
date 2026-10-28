#!/usr/bin/env bash
#
# Landing page visitors from Cloudflare Web Analytics, without opening the dashboard.
#
#     set -a; source .cf.env; set +a
#     scripts/visitors.sh        # last 7 days, today included
#     scripts/visitors.sh 30     # last 30 days
#
# Days are UTC. Counts only salts.dev: Vercel preview URLs carry the same beacon and
# report to the same site, so they are filtered out by host. A visit is a pageload
# that arrived from outside the site (a link, a search, a typed URL); page views count
# every pageload. CF_API_TOKEN's "Account Analytics: Read" is enough.
#
# Keep each GraphQL query on one physical line (see cost.sh for why).
set -euo pipefail

DAYS=${1:-7}
SITE_TAG=ff5b07e5c88746df8f53fa8c5812ebd6
HOST=salts.dev
: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID (source .cf.env)}"
: "${CF_API_TOKEN:?set CF_API_TOKEN (source .cf.env)}"

# BSD date (macOS) first, GNU date otherwise.
FROM=$(date -u -v-"$((DAYS - 1))"d +%F 2>/dev/null || date -u -d "$((DAYS - 1)) days ago" +%F)

gql() {
  local body out
  body=$(cat)
  out=$(curl -s https://api.cloudflare.com/client/v4/graphql \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H 'content-type: application/json' --data "$body")
  if [ "$(jq -r 'if (.errors|type)=="array" and (.errors|length)>0 then "bad" else "ok" end' <<<"$out")" = bad ]; then
    echo "GraphQL error: $(jq -c '.errors' <<<"$out")" >&2
    return 1
  fi
  printf '%s' "$out"
}

# One query, grouped by day and the breakdown dimensions; the tables below fold it.
Q='query($a:String!,$s:String!,$h:String!,$f:Date!){viewer{accounts(filter:{accountTag:$a}){rumPageloadEventsAdaptiveGroups(limit:10000,filter:{siteTag:$s,requestHost:$h,date_geq:$f}){count sum{visits} dimensions{date requestPath refererHost countryName deviceType}}}}}'

ROWS=$(jq -n --arg q "$Q" --arg a "$CF_ACCOUNT_ID" --arg s "$SITE_TAG" --arg h "$HOST" --arg f "$FROM" \
  '{query:$q,variables:{a:$a,s:$s,h:$h,f:$f}}' | gql | jq -c '.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups')

echo "$HOST, $FROM to today (UTC)"
echo

# Every day in the window gets a row, zero if nobody came.
jq -r --arg from "$FROM" --argjson days "$DAYS" '
  (group_by(.dimensions.date) | map({key: .[0].dimensions.date, value: {v: (map(.sum.visits)|add), p: (map(.count)|add)}}) | from_entries) as $by
  | ["date", "visits", "page views"],
    ([range(0; $days)] | map(($from + "T00:00:00Z" | fromdateiso8601) + . * 86400 | strftime("%Y-%m-%d"))[]
      | [., ($by[.].v // 0), ($by[.].p // 0)]),
    ["total", (map(.sum.visits)|add // 0), (map(.count)|add // 0)]
  | @tsv' <<<"$ROWS" | column -t -s $'\t'

# Top 10 by visits for one dimension; an empty value gets a readable label.
top() {
  local title=$1 dim=$2 empty=$3
  echo
  echo "$title"
  jq -r --arg d "$dim" --arg e "$empty" '
    group_by(.dimensions[$d]) | map([(.[0].dimensions[$d] | if . == "" then $e else . end), (map(.sum.visits)|add)])
    | sort_by(-.[1]) | .[:10][] | "  \(.[1])\t\(.[0])"' <<<"$ROWS" | column -t -s $'\t' | grep . || echo "  none"
}

top "Pages" requestPath "?"
top "Referrers" refererHost "(direct)"
top "Countries" countryName "?"
top "Devices" deviceType "?"
