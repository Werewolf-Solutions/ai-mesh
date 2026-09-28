# Werewolf AI Mesh v0.1 — progress checklist

Status legend: [x] done and verified · [~] implemented, partially verified · [ ] not done

## 0. Environment
- [x] Inspect repo (empty) and host (Ubuntu 24.04 x86-64, 16 cores, 15 GiB, Docker 29.8.1, Node 22.17.0)
- [x] Verify model licence (Apache-2.0) and pin GGUF revision + SHA-256
- [x] Pin llama.cpp runtime (b11223) binary + container image digest
- [x] Prove one real CPU completion with raw llama-server

## 1. One full node, real model
- [x] Workspace, protocol package, config/identity persistence
- [x] Model manifest, download/import/verify commands
- [x] InferenceAdapter + llama.cpp adapter (spawn + external modes), token budget via runtime tokenizer
- [x] Worker queue (1 concurrent, 8 queued), cancellation
- [x] Fastify API: health, models, chat completions (stream + non-stream)

## 2. Networking
- [x] libp2p node: TCP, Noise, Yamux, identify, ping, circuit relay v2
- [x] Admission: network ID + authorised peer list; connection gater + per-protocol checks
- [x] Status protocol, probes, expiry, backoff, peer exchange hints, peer cache
- [x] Inference protocol: framed, validated, bounded, cancellable

## 3. Routing & resilience
- [x] Gateway scheduler (local vs. remote), target override, attribution
- [x] Bounded retries before first token; interrupted after output
- [x] Dedup cache, draining, graceful shutdown

## 4. Client & UI
- [x] packages/client with gateway failover and interruption detection
- [x] React UI: chat, stop/retry, history export/delete, gateways, dashboard

## 5. Deployment
- [x] CLI (`./mesh`), prerequisite checks, cluster generator (2/3/10)
- [x] Dockerfile, one-node Compose, generated multi-node Compose
- [x] Failover demo script

## 6. Tests & docs
- [x] Unit tests (16); fault-injection integration tests (38, fake adapter); real-model tests (8)
- [x] Docker cluster validation
- [x] Docs: README, architecture, protocol, operations/Ubuntu, security, benchmarks, roadmap

## Not validated here (see docs/testing.md)
- [ ] Two physical machines / real VPS relay / NAT (manual procedure in docs/operations.md §9)
- [ ] HTTPS reverse proxy, systemd unit
- [ ] ARM64 / macOS runtime binaries
- [ ] Ten nodes each running the real model on one host (generation + fake-runtime 10-process mesh tested)

## v0.2: choosing models and effort
- [x] Vetted catalog of 9 Apache-2.0 models, pinned and tested on llama.cpp b11223
- [x] Several models per node; per-model load in status; routing by model
- [x] Effort (reasoning_effort) with enforced thinking budgets; thinking streamed separately
- [x] Operator install: fit check, resumable verified download, start, advertise, persist (UI, CLI, API)
- [x] UI: model picker, effort control, thinking display, Models page
- [x] Docker image contains llama.cpp; one container per node
- [ ] Qwen3 8B in Docker, ARM64/macOS, GPU builds (not tested)

## GPU sharing
- [x] Pinned CUDA 12.8 and Vulkan builds of llama.cpp b11223; `./mesh gpu`, admin API, UI switch
- [x] GPU-aware fit checks (VRAM + remaining RAM); models that no longer fit are stopped on switch
- [x] Gateways measure real speed per node and model; time-based routing prefers faster nodes
- [ ] GPU in Docker, AMD/Intel Vulkan and Metal (not tested)
