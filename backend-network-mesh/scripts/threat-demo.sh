#!/usr/bin/env bash
# threat-demo.sh — the escalation-ladder demo, against a running control plane
# (npm run dev + POST /api/demo first, or just run this; it boots the fleet).
#
# Injects a missile threat, kills the assigned layer, and shows the mesh
# re-deciding: aegis → smartfalcon → edgefuse → aegis again after revive.
# The sleeps are the SWIM suspect window — the honest cost of failure detection.
set -euo pipefail
API=${API:-http://127.0.0.1:7000}

threat() {
  curl -s -X POST "$API/api/threat" -H 'content-type: application/json' \
    -d "{\"threat\":\"$1\"}" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(f"  {a[\"threat\"]}: primary={a[\"primary\"]}, fallbacks={a[\"fallbacks\"]} (via {a[\"via\"]})")'
}

echo "booting demo fleet (idempotent)…"
curl -s -X POST "$API/api/demo" > /dev/null
sleep 8

echo "1) all layers alive:"
threat missile
echo "   killing aegis (Layer 2)…"
curl -s -X POST "$API/api/procs/aegis/kill" > /dev/null
sleep 10

echo "2) after aegis conviction:"
threat missile
echo "   killing smartfalcon (Layer 3)…"
curl -s -X POST "$API/api/procs/smartfalcon/kill" > /dev/null
sleep 10

echo "3) layers 2 and 3 down — EdgeFuse goes for the kill:"
threat missile
echo "   reviving aegis and smartfalcon…"
curl -s -X POST "$API/api/procs/aegis/start" > /dev/null
curl -s -X POST "$API/api/procs/smartfalcon/start" > /dev/null
sleep 6

echo "4) after rejoin:"
threat missile
echo "done — same experiment works for swarm (maelstrom) and emp (wisl)."
