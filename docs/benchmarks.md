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

### Scoring the summaries

Each summary is compared on the gateway with an ideal answer to the question ("what is the main lesson of the text?"). The ideal was written by hand and is editable in the UI:

> A group survives a long, hard journey when knowledge and work are shared by many members instead of relying on one leader, so it keeps going even when some individuals fail.

- **Meaning match:** cosine similarity of bge-small-en-v1.5 embeddings (Q8_0, MIT), shown on a scale from an unrelated sentence (0%) to the ideal itself (100%).
- **Word overlap:** ROUGE-L F1, with no model.

Measured on a real 3-node cluster (2026-09-28). Each run adds a random tag to the prompt, so even temperature-0 runs differ slightly.

| Candidate | Cosine | Meaning match | Word overlap |
|---|---|---|---|
| Hand-written paraphrase of the ideal | 0.91 | 86% | 27% |
| SmolLM2 best run (t=0.7): "…success is largely due to the shared knowledge…" | 0.71 | 55% | 14% |
| SmolLM2, 3 runs at t=0 (the UI setting) | 0.59–0.67 | 38–49% | 8–14% |
| SmolLM2, 5 runs at t=0.7 | 0.54–0.71 | 30–55% | 8–14% |
| Loosely related sentence ("wolves travel a long way every winter…") | 0.54 | 30% | 14% |
| Unrelated sentence (stock market) | 0.33 | 0% | 0% |

What this shows:

- Summaries that name the actual lesson (shared knowledge, surviving losses) score highest.
- Summaries that only retell the plot ("the pack spends the warm months in a valley…") score about the same as a loosely related sentence.
- Word overlap barely separates them: even the faithful paraphrase shares only 27% of the wording, so meaning match is the more useful score.

Labels in the UI: ≥ 70% "close to the ideal", ≥ 35% "partly matches", below that "far from the ideal". These are rough guides from this calibration, not grades. SmolLM2-135M mostly lands at "partly matches": it reads the right text but rarely states its point.

Reading speed on a long prompt (≈ 370 tok/s) is a little lower than on a short one (≈ 400 tok/s): attention cost grows with context length. Routing to a peer adds no measurable reading time; the network cost appears only in the browser's "first word" time (a few ms on one host).

## Catalog models

Load time, RAM, speed and thinking checks for all 9 catalog models (4 threads, 8k context) are in [models.md](models.md#the-catalog). On this CPU, speed ranges from 176 tokens/s (SmolLM2 135M) to 6 tokens/s (Qwen3 8B).

## Coding with Qwen3 8B (small benchmark)

This is 6 everyday coding tasks, not a standard benchmark:
- validate an IPv4 address
- merge intervals
- an LRU cache class
- a CSV line parser with quoted fields
- top-N word counts
- fixing a buggy `median` function

Each answer's code runs against hidden tests in a Docker container with no network (`scripts/code-eval.mjs`). The model is Qwen3 8B Q4_K_M, running natively with 8 threads on the Ryzen 7 3700X, at temperature 0.

| Effort | Passed | Time per task | Tokens per task |
|---|---|---|---|
| Fast (no thinking) | 4 / 6 | 12–43 s (median ≈ 25 s) | 60–230 |
| Balanced (thinking ≤ 512 tokens) | 4 / 6 | 109–129 s | ≈ 600–700 |

- **Both modes failed the same two tasks:**
  - the CSV parser, on an edge case (empty quoted fields)
  - the median fix, which corrected the maths but still sorted the caller's list in place. The prompt did not forbid that; the hidden test checked for it.
- **Found and fixed during this benchmark:**
  - At first, when the thinking budget ran out, the model sometimes kept "thinking" inside its answer until the length limit, producing truncated code (3 of 6 answers).
  - Nodes now start llama.cpp with a budget message ("Time is up: stop thinking now and write the final answer directly."). On the rerun, all answers finished normally, in about half the time.
- **Take-away:** Qwen3 8B on a CPU writes correct small functions and classes most of the time, but misses edge cases and unstated requirements. Always run tests on its code. At about 6 tokens/s, a short answer takes about 30 s, and one with thinking about 2 minutes.

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
