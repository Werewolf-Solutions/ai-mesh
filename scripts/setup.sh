#!/usr/bin/env bash
# One-shot local setup: dependencies, build, pinned runtime, verified model, checks.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Node.js >= 22.12 is required (https://nodejs.org or nvm)"; exit 1; }
command -v pnpm >/dev/null || npm install -g pnpm@10.34.5
pnpm install --frozen-lockfile
pnpm build
./mesh runtime install          # pinned llama.cpp b11223, SHA-256 verified (native mode)
./mesh model download           # pinned GGUF, SHA-256 verified, stored once in ./models
./mesh doctor
