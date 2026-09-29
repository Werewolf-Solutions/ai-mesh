# External engines (ds4-server, LM Studio, Ollama, vLLM …)

A node can serve a model from another inference server that speaks the OpenAI chat API, for example [ds4](https://github.com/antirez/ds4)'s `ds4-server`, which runs DeepSeek V4 Flash, GLM 5.x or Qwen 3.8 Flash on a 96–128 GB Mac or a DGX Spark. The node offers that model to the whole pack: every other node sees it in its model list and can use it, even though it's not in the vetted catalog.

## Adding one

Start the engine on the same computer as your node (ds4-server listens on `http://127.0.0.1:8000` by default), then:

```bash
./mesh engine add ds4-flash --url http://127.0.0.1:8000 --name "DeepSeek V4 Flash" \
    --context 32768 --max-output 4096 --thinking toggle --thinking-control none \
    --license MIT            # the model's licence, as you understand it
./mesh engine list
./mesh engine remove ds4-flash
```

| Option | Meaning |
|---|---|
| `--model NAME` | Model name the engine expects (default: the first it lists at `/v1/models`) |
| `--key-file FILE` | File holding the engine's API key, if it needs one |
| `--context`, `--max-output` | Limits the mesh plans with; the engine enforces its own |
| `--thinking none\|toggle\|always` | Whether the model can think first |
| `--thinking-control` | How to turn thinking off per request: `reasoning_effort` (sends `"none"`), `chat_template_kwargs` (`enable_thinking: false`), or `none` (the engine decides, e.g. ds4's `--nothink` flag) |
| `--sha256 HASH` | SHA-256 of the weights file, if you know it: nodes that declare the same hash serve "the same model" |

The same is available at `GET/POST /admin/engines` and `DELETE /admin/engines/:id` (operator only).

## How it behaves

- **Discovery.** The model is advertised as `<id>:ext:<hash>`. Other nodes list it as *external engine · not verified*, with conservative limits (8k context), and route requests for it to your node.
- **Health.** The node checks `GET /v1/models` every 10 s. When the engine stops, the model disappears from the pack within about 30 s; when it comes back, it's offered again.
- **Answers** stream as usual; thinking arrives as `reasoning_content`. Responses are marked `runtime: "external"`.
- **Effort.** Fast turns thinking off, if the engine supports a switch. Balanced and Thorough keep the mesh's thinking budget, but an engine cannot be asked to wrap up early the way llama.cpp can, so the budget is **enforced by stopping** the answer (`finish_reason: "length"`).
- **Prompt length** is estimated (about 3.5 characters per token), because these engines have no standard token counter; the engine rejects prompts that don't fit.

## What the mesh does not do for engines

- **It doesn't verify the model.** Catalog models are pinned to a SHA-256 checked before every load; an engine's model is whatever its operator says it is. Other nodes see "not verified".
- **It doesn't run or sandbox the engine.** You start it, keep it updated, and keep it on 127.0.0.1. ds4-server has no login of its own; its docs say to put authentication in front of it if exposed. Only your node should talk to it.
- **Licences** of models like DeepSeek V4, GLM 5.x or Qwen 3.8 are your responsibility when you share them with the pack.

## Testing status

- Tested against a **stand-in** OpenAI-compatible server (`tests/standin-engine.ts`, `tests/integration/engines.test.ts`): a second node discovers and uses the model; API key; thinking switch and budget; engine loss and return; removal.
- **Not tested against real ds4-server:** its models need far more memory than the test machine has (16 GB RAM, 12 GB VRAM). Its documented API (`/v1/models`, `/v1/chat/completions` with SSE, reasoning returned separately) matches what the adapter uses.
