# Sharing a GPU with the pack

A node can run its models on a GPU instead of the CPU. Other nodes then send it more work, because they measure that it answers faster.

## Turning it on

**UI:** Models → *This computer's GPU* → **Use the GPU**. This button only shows for the node's operator.

**CLI:**

```bash
./mesh gpu status            # what GPU was found, and what the node uses now
./mesh gpu on                # CUDA on NVIDIA (default)
./mesh gpu on vulkan         # Vulkan: NVIDIA, AMD or Intel
./mesh gpu off               # back to the CPU
```

The first time, the node downloads the **pinned GPU build of the same llama.cpp version** from `models/runtime.json`, verified by SHA-256:
- CUDA 12.8: 170 MB, plus 590 MB of NVIDIA runtime libraries.
- Vulkan: 31 MB.

It then restarts every hosted model on the GPU. The choice is saved in `data/<node>/models-state.json` and kept across restarts. A model that no longer fits after a switch (for example an 8B model moving from GPU to CPU) is stopped with the reason shown, rather than exhausting memory.

**Requirements:**
- CUDA: an NVIDIA GPU with driver ≥ 525.
- Vulkan: any GPU with a Vulkan 1.2 driver (on Ubuntu, `mesa-vulkan-drivers` for AMD/Intel, or the NVIDIA driver).
- Nothing else to install: the build ships its own libraries.

## Measured (RTX 3060 12 GB, driver 580, Ryzen 7 3700X, 2026-09-28)

| Qwen3 8B Q4_K_M | Load | Generation | Prompt reading | GPU memory |
|---|---|---|---|---|
| CPU, 8 threads | 15 s | 6 tok/s | 35 tok/s | — |
| **CUDA** | 4 s | **58 tok/s** | **363 tok/s** | 5.8 GB |
| Vulkan | 7 s | 45 tok/s | 22 tok/s (first run) | 5.7 GB |

- Qwen3 8B with thinking (535 tokens) answered in **9.2 s** on CUDA, versus about 90 s on the CPU.
- Qwen3.5 0.8B runs above 60 tok/s on CUDA, versus 26 tok/s on 4 CPU threads (checked by `tests/real/gpu.test.ts`).
- With the GPU on, the RAM check counts only what stays in system memory. Qwen3 8B, which was refused on the CPU (needs ~9.3 GB of free RAM), installed and ran on the GPU. GPU memory is checked against the card's size, with every model on the GPU counted.

## How the pack decides who answers

Every gateway keeps its own measurements. When a node answers, the gateway records how fast the tokens actually arrived (tokens/s from first token to done) for that node and that model, and smooths it over time. The router then picks the node with the shortest *expected* time:

```
expected seconds = (jobs ahead of you + 1) × 256 tokens / measured speed
                   + (remote ? 0.5 s + round trip : 0)
```

- A node's **hardware hint** (`cpu`, `cuda`, `vulkan` in its status) is only a starting guess: CPU 8 tok/s, GPU 40 tok/s. A node can't make itself look faster than it really answers.
- A fast GPU node wins **even over the gateway's own idle CPU**, until its queue makes it slower. On an RTX 3060 serving Qwen3 8B, it stays preferred until about 7 requests are waiting.
- **Tested:**
  - In a real CPU + GPU pair, every request from the CPU node was answered by the GPU node in about 0.2 s.
  - In `tests/integration/speed.test.ts`, the gateway learns which of two nodes is faster and sends it the work.

The Network page shows a **GPU** badge and each peer's measured speed. So does `./mesh peers status`.

## What this is and isn't

- **It shares a GPU for whole models.** The model must fit on one machine (GPU memory, plus RAM for layers left on the CPU). Splitting one big model across several people's GPUs is future work ([roadmap](roadmap.md)).
- **Bigger models for GPU owners.** A 12 GB card can run models the CPU can't, such as Qwen3 8B comfortably. Larger catalog entries (e.g. Qwen3 14B, about 9 GB) can be added once tested; see [models.md](models.md#adding-a-model-to-the-catalog).
- **Not available yet:**
  - GPU inside **Docker**: this needs the NVIDIA Container Toolkit and a GPU image; use a native node for now.
  - **macOS Metal**, and AMD/Intel via Vulkan: pinned where available, but not tested.
- **Costs:** a GPU uses more power while answering. Sharing it means other people's requests use your electricity; there is no payment system.
