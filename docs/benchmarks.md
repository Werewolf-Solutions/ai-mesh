# Measured performance

Every number here was measured on the one development machine on 2026-09-28. Nothing is extrapolated. Throughput does **not** scale linearly with node count, and ten nodes on one laptop do not behave like ten VPSs.

**Hardware and software:**
- AMD Ryzen 7 3700X (8 cores / 16 threads), 16 GB RAM, NVMe SSD, Ubuntu 24.04, Linux 7.0.
- Model: SmolLM2-135M-Instruct GGUF Q4_K_M (105 MB).
- Runtime: llama.cpp b11223, CPU only.
- Context 2048 tokens, 1 slot, `-t 2 -tb 2` (2 threads).
- Sources: `pnpm test:real` (writes `.cache/measurements.json`), `./mesh demo failover`, and `docker stats`.

## Single node

| Metric | Value | How |
|---|---|---|
| Model SHA-256 verification | 150–210 ms | node log / `./mesh model verify` |
| llama-server load to healthy (native) | 0.53 s | node log `local model ready` |
| Node start to `/health/ready` (native, incl. verify + warm-up) | 0.8–1.3 s | test harness |
| llama.cpp container start to `/health` (2 CPU, 1 GB limit) | 0.25 s | `docker run --cpus 2 --memory 1g` |
| Time to first token, local, short prompt | 20–55 ms | 3 runs, 128-token answers |
| Decode throughput, native 2 threads | 133–136 tok/s | 3 runs, 83 generated tokens each |
| Decode throughput, container capped at 2 CPUs | 135–140 tok/s | llama.cpp `timings` |
| Prompt processing, 2 threads | ≈ 400 tok/s | llama.cpp `timings` |
| RSS node process (native) | ≈ 150 MB | `ps` |
| RSS llama-server (native) | ≈ 198 MB | `ps` |
| Container memory: node / runtime | 92 MiB / 80–83 MiB | `docker stats` (cgroup accounting excludes some mmapped model pages) |
| Node image size | 271 MB | `docker image ls` |

The 2 vCPU / 2 GB sizing target holds comfortably for *this* model: one node plus its runtime used under 400 MB. A larger model would change this completely.

## Reading a long text (UI: Tests → Reading speed test)

The prompt is a 1,178-word text (about 1,400 tokens) plus an instruction to summarise it in one sentence. Each run adds a random tag so the prompt cache cannot be reused. The reading time is measured by the worker, from slot start to the first generated token.

| Worker | Runs | Tokens read | Reading time | Reading speed |
|---|---|---|---|---|
| Local (the gateway itself) | 3 | 1,401–1,402 | 3.74–3.85 s | 365–374 tok/s |
| Remote peer via the mesh | 3 | 1,401–1,404 | 3.79–3.84 s | 365–371 tok/s |
| Remote peer, run from the browser UI | 1 | 1,408 | 3.81 s | 370 tok/s |

Reading speed on a long prompt (≈ 370 tok/s) is a little lower than on a short one (≈ 400 tok/s): attention cost grows with context length. Routing to a peer adds no measurable reading time; the network cost appears only in the browser's "first word" time (a few ms on one host).

## Mesh

| Metric | Value | How |
|---|---|---|
| Peer RTT on one host (status probe) | 4–7 ms | `/admin/peers` |
| Time to first token, remote worker via gateway | 58–61 ms | `pnpm test:real` |
| Failover when the chosen worker is frozen before output | 3.2 s (test config, `connectMs` 3 s); 5.5–5.6 s (default `connectMs` 5 s) | real tests / demo, native and Docker |
| Detecting a worker killed mid-stream | ≈ 30 ms after the kill | `pnpm test:real` (TCP reset seen immediately) |
| First token of the next request after cancelling a 256-token generation | 35–40 ms | proves the runtime slot was released |

A hung worker whose TCP connection stays open, such as a paused VM, is detected only by timeouts: `connectMs` before acceptance, `firstTokenMs`/`streamIdleMs` afterwards. A machine that vanishes without resetting connections is detected mid-stream after `streamIdleMs` (20 s).

## Not measured

- Real multi-machine latency.
- Relay overhead across the internet.
- ARM64 and macOS.
- Throughput under sustained concurrent load across several machines.
- GPU performance.
