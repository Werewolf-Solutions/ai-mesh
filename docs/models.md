# Models, effort, and sharing compute

## Choosing a model

The UI has a **Model** picker and an **Effort** control above the message box.

- **Running in the pack:** models some node you can reach is serving right now, with how many nodes serve each.
- **Not running yet:** the rest of the catalog.
  - If you are the **operator** of the gateway you're using (your own node), each entry offers **Download and run on this computer**, showing the download size and RAM needed and refusing if it won't fit.
  - Otherwise it says a node operator can add it.

When you run a model, your computer serves it for **everyone in the pack**, and your node uses models other computers run. That is the resource sharing: every node that serves a model holds a full copy and adds capacity. Nothing is pooled or split across machines (see the [roadmap](roadmap.md)).

From the command line:

```bash
./mesh models                               # catalog: size, RAM, thinking, state on this node
./mesh models install qwen3-1.7b-q8_0       # download (verified) and serve; works with a running node too
./mesh models unhost qwen3-1.7b-q8_0        # stop serving (file kept)
./mesh models remove qwen3-1.7b-q8_0        # delete the file (must not be served)
```

The HTTP API uses standard OpenAI fields: `"model": "<catalog id>"` and `"reasoning_effort"`. See [api.md](api.md).

## The catalog

Only models in `models/catalog/` can run on the mesh. Each entry is:

- openly licensed (all Apache-2.0 today)
- pinned to one exact GGUF file at an immutable revision, with its SHA-256
- published by the model's authors or by the llama.cpp maintainers (ggml-org), with one exception noted below
- **tested on the pinned llama.cpp build** (b11223)

Files are verified before every load. Peers can never make your node download or run anything; only the node's operator can (admin token or loopback).

Measured on 2026-09-28 (Ryzen 7 3700X, 4 threads, 8k context, CPU only), on one arithmetic check ("What is 17×23?"):

| Model | Thinking | Download | RAM | Speed | Without thinking | With thinking |
|---|---|---|---|---|---|---|
| SmolLM2 135M (default) | — | 0.1 GB | ~0.4 GB | 176 tok/s | 421 ✗ | — |
| Qwen3.5 0.8B | yes | 0.8 GB | ~1.2 GB | 26 tok/s | 491 ✗ | 391 ✓ |
| SmolLM2 1.7B | — | 1.0 GB | ~3.7 GB | 24 tok/s | 431 ✗ | — |
| Qwen3 1.7B | yes | 1.7 GB | ~3.2 GB | 14 tok/s | 391 ✓ | 391 ✓ |
| Gemma 4 E2B | yes | 3.1 GB | ~3.5 GB | 17 tok/s | 391 ✓ | 391 ✓ |
| Granite 4.2 3B | yes | 2.1 GB | ~4.6 GB | 13 tok/s | 391 ✓ | 391 ✓ |
| Ministral 3 3B | — | 2.0 GB | ~4.2 GB | 12 tok/s | 411 ✗ | — |
| Qwen3 4B | yes | 2.3 GB | ~6.0 GB | 11 tok/s | 391 ✓ | ran out of 1,200 tokens (see budgets) |
| Qwen3 8B | yes | 4.7 GB | ~9.5 GB | 6 tok/s | 391 ✓ | 391 ✓ |

One question is not a benchmark. It does show two things: thinking can turn a small model's wrong answer into a right one, and an unbounded thinker needs a budget.

The exception: SmolLM2 135M uses the community conversion from v0.1 (bartowski), kept so v0.1 fingerprints stay valid. Everything else is from the model's authors or ggml-org.

## Effort

Effort uses OpenAI's `reasoning_effort` values:

| UI | `reasoning_effort` | Models with thinking | Models without |
|---|---|---|---|
| Fast | `none` (or `minimal`) | answer straight away | short answers (512 tokens) |
| Balanced (default) | `low` | think first, up to **512** tokens | 768 |
| — | `medium` | up to **1,536** tokens | 1,024 |
| Thorough | `high` | up to **4,096** tokens | 2,048 |

- Budgets are clamped so prompt + thinking + answer always fit the model's context (8,192 tokens for most models, 2,048 for SmolLM2 135M).
- **How the budget is enforced:** the worker streams the model's thinking separately (llama.cpp `--reasoning-format deepseek`) and counts it. When the budget is reached, it calls llama.cpp's `reasoning_end` control, and the model closes its thinking and answers.
- **Verified:** Qwen3 4B, which thought past 1,200 tokens without answering when unbounded, stopped at its 512-token budget and answered (`tests/real/models.test.ts`).
- The UI shows thinking live, then as *"Thought for N s · show"*. Thinking is streamed as `delta.reasoning_content`, and in non-streaming replies as `message.reasoning_content`.

## How a request finds a model

- Each node advertises, in its authenticated status record, every model it serves, with that model's own load (`modelLoad`).
- A gateway routes a request only to itself or to peers serving the requested model, choosing by load and latency as before.
- Failover before output, interruption after output, cancellation, dedup and queues all work per model.
- Each hosted model has its own llama.cpp process (127.0.0.1 only, per-start API key) and its own queue: 1 running + 8 waiting.

If no reachable node serves the model, the gateway answers `503 no_workers`: *"no node you can reach is running this model right now"*.

## Installing: what happens

1. **Fit check:**
   - The RAM of all hosted models plus this one must stay under 85% of the machine's memory and fit in currently free memory.
   - The disk needs the download size plus 512 MB.
   - Refused, with the reason shown, if either fails.
2. **Download:**
   - from the pinned URL, into `<model dir>/<file>.part`, with progress shown
   - **resumable**: a cancelled or broken download continues from where it stopped
   - locked, so two nodes sharing a folder never write the same file
3. **Verify:** size and SHA-256 against the catalog. A mismatch deletes the file.
4. **Start** the model's runtime and warm it up.
5. **Advertise:** the node's next status exchange tells its peers (within seconds).
6. **Persist:** the hosted list is saved to `data/<node>/models-state.json`, so the node serves it again after a restart.

Tested for real: cancelling at 318 of 1,007 MB kept the partial file, and installing again resumed from there. The finished file matched byte for byte and served requests.

## Resource guidance

- RAM adds up. Hosting SmolLM2 135M plus Qwen3 1.7B needs about 3.6 GB.
- On a 2 vCPU / 4 GB VPS, host one small model (up to Qwen3 1.7B or Gemma 4 E2B).
- The 8B model needs a machine with 12 GB or more, and is slow on a CPU (about 6 tokens/s).
- In Docker, `MESH_MEM` (default 3g) caps the node **and** its models together; raise it before installing bigger models.

## Adding a model to the catalog

A catalog entry is a promise that the model is licensed for this use, pinned, and works. To add one:

1. **Licence:** it must allow free use and redistribution of outputs (Apache-2.0, MIT or similar). Record it from the official model card.
2. **Pin the file:** exact repo, revision (commit SHA), filename, size, and SHA-256 (the Hugging Face LFS ID, recomputed after download).
3. **Test it** on the pinned llama.cpp: it loads, answers, thinking off/on works if the template supports it, and RSS is measured at the entry's context. `.cache/probe-models.mjs` is the script used to measure the table above.
4. **Write** `models/catalog/<id>.json`, where `<id>` must match the file name.

Every node of a mesh should use the same catalog (the same repository version). A model's fingerprint is `<id>:sha256:<file hash>`, so nodes only exchange jobs for byte-identical models.

## Not included

- Models needing a newer llama.cpp than the pinned build.
- Vision/audio input: Gemma 4 and Qwen3.5 are multimodal, but the mesh passes text only.
- Tool calling.
- GPU builds.
- Splitting one model across several machines (see the [roadmap](roadmap.md)).
