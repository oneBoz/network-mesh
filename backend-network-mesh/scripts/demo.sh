#!/usr/bin/env bash
# Boots a full local mesh: 3 lighthouses + 5 defense-system nodes.
# Each process is a "server site" — kill/restart individual PIDs to stress test.
#
# Defense layers:
#   maelstrom    Layer 1 — MAELSTROM Command: anti-swarm, high-speed propulsion
#   aegis        Layer 2 — AEGIS: close-combat interception
#   smartfalcon  Layer 3 — SmartFalcon: backup interceptor if AEGIS fails
#   edgefuse     Layer 4 — EdgeFuse: on-sensor fused detection, last-resort kill
#   wisl         EMP Defense — WISL: EMP jamming / e-warfare specialist
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Starting 3 lighthouses (5001-5003) + 5 defense-system nodes (4001-4005)..."
LH="127.0.0.1:5001,127.0.0.1:5002,127.0.0.1:5003"

npx tsx src/lighthouse.ts --port 5001 &
npx tsx src/lighthouse.ts --port 5002 &
npx tsx src/lighthouse.ts --port 5003 &
sleep 1

npx tsx src/node.ts --id maelstrom   --port 4001 --http 8001 --service maelstrom   --lighthouses "$LH" &
npx tsx src/node.ts --id aegis       --port 4002 --http 8002 --service aegis       --lighthouses "$LH" &
npx tsx src/node.ts --id smartfalcon --port 4003 --http 8003 --service smartfalcon --lighthouses "$LH" &
npx tsx src/node.ts --id edgefuse    --port 4004 --http 8004 --service edgefuse    --lighthouses "$LH" &
npx tsx src/node.ts --id wisl        --port 4005 --http 8005 --service wisl        --lighthouses "$LH" &

echo ""
echo "Mesh running. Try:"
echo "  curl -s localhost:8001/members | head -40"
echo "  curl -s localhost:8001/resolve/aegis"
echo "  kill \$(pgrep -f 'id aegis')     # watch peers mark aegis suspect → dead"
echo ""
echo "Ctrl+C stops everything."
trap 'kill 0' EXIT
wait
