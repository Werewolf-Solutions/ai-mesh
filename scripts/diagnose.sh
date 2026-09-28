#!/usr/bin/env bash
# Collect a redacted diagnostic snapshot of one node (no prompts, no tokens, no keys).
#   scripts/diagnose.sh [data-dir]
set -uo pipefail
cd "$(dirname "$0")/.."
DATA="${1:-data/node}"
./mesh doctor --data "$DATA"
echo; echo "== status"; ./mesh status --data "$DATA" || true
echo; echo "== peers"; ./mesh peers status --data "$DATA" || true
echo; echo "== last log lines (structured; prompts/outputs are never logged)"
tail -n 40 "$DATA/node.log" 2>/dev/null || echo "(no node.log; for Docker use: docker compose -f deploy/compose.yaml logs --tail 40 node)"
