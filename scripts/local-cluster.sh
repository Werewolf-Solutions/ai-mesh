#!/usr/bin/env bash
# Generate and start a local Docker cluster (default 3 nodes) with real inference.
#   scripts/local-cluster.sh [N]
set -euo pipefail
cd "$(dirname "$0")/.."
N="${1:-3}"
DIR="deploy/generated/cluster-$N"
docker image inspect werewolf-mesh/node:0.1.0 >/dev/null 2>&1 || docker build -f deploy/Dockerfile -t werewolf-mesh/node:0.1.0 .
[ -f "$DIR/cluster.json" ] || ./mesh cluster generate --nodes "$N" --mode docker --out "$DIR"
./mesh cluster up --dir "$DIR"
echo "Peers as seen from the last node (wait ~10 s after first start):"
sleep 10
./mesh peers status --data "$DIR/node$N"
