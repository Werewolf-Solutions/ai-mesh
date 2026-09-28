#!/usr/bin/env bash
# Run every automated test tier, then the scripted failover demo on a Docker cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
pnpm test:unit
pnpm test:integration          # fake runtime: fault injection only
pnpm test:real                 # real llama.cpp + verified model
scripts/local-cluster.sh 3
./mesh demo failover --dir deploy/generated/cluster-3
