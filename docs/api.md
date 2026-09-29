# HTTP API

The HTTP API is how browsers and clients reach a gateway. It is separate from the peer transport: browsers never speak libp2p.

## Authentication

| Route | Access |
|---|---|
| `GET /health/live`, `GET /health/ready` | Anonymous; minimal information |
| `GET /v1/models`, `POST /v1/chat/completions`, `GET /v1/mesh/whoami` | Client token or admin token |
| `GET /admin/models`, `POST /admin/models/:id/install\|cancel\|unhost`, `DELETE /admin/models/:id` | Admin token (this node's operator only) |
| `GET /admin/status`, `/admin/peers`, `/admin/metrics`, `/admin/model`, `/admin/system`, `POST /admin/reload-admission` | Admin token |
| `GET /admin/split`, `POST /admin/split/lend`, `POST /admin/models/:id/split` | Admin token ([split.md](split.md)) |
| `GET /admin/engines`, `POST /admin/engines`, `DELETE /admin/engines/:id` | Admin token ([engines.md](engines.md)) |
| `GET /admin/rewards`, `GET /admin/rewards/bundle`, `POST /admin/rewards/settlement` | Admin token ([rewards.md](rewards.md)) |
| `/` (UI files) | Anonymous; contains no secrets |

- Send tokens as `Authorization: Bearer <token>`. They live in `data/<node>/secrets.json`: `clientTokens[]` and `adminToken`.
- With `http.trustLoopback: true` (the native default), requests from 127.0.0.1/::1 **without** a token get admin access. A presented but wrong token is always `401`.
- Docker and generated clusters set `trustLoopback: false`.
- **Host header allow-list:** by default `localhost`, `127.0.0.1` and `[::1]`; add names to `http.allowedHosts`. This defends against DNS rebinding.
- **CORS:** exact origins from `http.allowedOrigins`, with no credentials mode and no wildcard. Requests with a foreign `Origin` header are refused with `403`.
- The UI never has tokens built in. You type them in, or `./mesh ui-url` passes them in the URL fragment (`#token=…&admin=…`); the fragment is never sent to the server, and the UI removes it after reading.

## `POST /v1/chat/completions` (OpenAI-compatible subset)

**Supported:**

- `messages` (roles `system`, `user`, `assistant`; text content only)
- `stream`, `stream_options.include_usage`
- `max_tokens` / `max_completion_tokens`: the **answer** length (thinking comes on top); at most the model's `maxOutputTokens` (2,048 for most catalog models, 512 for SmolLM2 135M); default depends on effort
- `reasoning_effort`: `none`/`minimal` (answer directly), `low` (think up to 512 tokens, default), `medium` (1,536), `high` (4,096); budgets are clamped to the model's context. Models without a thinking mode only change the default answer length. See [models.md](models.md#effort).
- `temperature`, `top_p`, `seed`, `stop` (≤ 4)
- `presence_penalty`, `frequency_penalty`
- `n` (must be 1)
- `model`: a catalog ID (see `GET /v1/models?all=1`) or a model fingerprint. Default: the first model running on the gateway, else one the pack serves.

**Accepted and ignored:** `user`, `store`, `metadata`, `service_tier`.

**Rejected with `400 unsupported`:**

- `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls` (the mesh runs its own tools; see `mesh.web` and `mesh.code`)
- `logprobs`, `top_logprobs`, `logit_bias`
- `response_format`, `audio`, `modalities`, `prediction`, `web_search_options`

Image or other non-text content parts, and any unknown field, get `400 bad_request`. This is **not** full OpenAI API compatibility.

**Mesh extensions:**

- `"mesh": {"target": "auto" | "local" | "<peerId>", "timeout_ms": 1000–900000}`. `target` pins execution (no failover).
- `"mesh": {"web": "on" | "auto" | "off"}`: web research before answering (see below). Default `off`.
- `"mesh": {"code": "on" | "auto" | "off"}`: write Python, test it in the sandbox and fix it (see below). Default `off`. `code` and `web` cannot both be `"on"`.
- Header `X-Mesh-Prefer: <peerId>`: try that worker first, with normal failover.

**Non-streaming response:** the standard `chat.completion` body plus

```json
"mesh": {"gatewayPeerId": "…", "workerPeerId": "…", "route": "local|remote",
         "attempts": [{"workerPeerId": "…", "route": "remote", "outcome": "connect_timeout"}, …],
         "runtime": "llama.cpp",
         "timings": {"queueMs": 0, "firstTokenMs": 3810, "totalMs": 4480}}
```

`timings` is measured by the worker that produced the answer. `queueMs` is time waiting for a slot; `firstTokenMs` runs from slot start to the first generated token, which is how long the node spent reading the prompt; `totalMs` is the whole job. In streams, `timings` is on the final chunk only.

and the headers `X-Mesh-Worker`, `X-Mesh-Gateway`, `X-Mesh-Route` and `X-Mesh-Runtime`. `X-Mesh-Runtime: fake` appears only on test nodes.

## Streaming contract (SSE)

- Response headers are sent **only when the first token exists**. Every failure before output is therefore an ordinary HTTP error (`429`, `502`, `503`, `504` …) with a JSON body, and a client may safely try another gateway.
- The first chunk carries `delta.role`, the first text, and `mesh` attribution.
- **Success** ends with a chunk that has `finish_reason` and `usage`, followed by `data: [DONE]`.
- **Failure after output** sends `data: {"error": {"code": "interrupted", "message": …, "mesh": …}}` and ends **without** `[DONE]`.
- A stream that ends without `[DONE]`, for whatever reason, must be treated as interrupted. `@werewolf-mesh/client` does exactly this.

## Web research

With `"mesh": {"web": "on"}` the gateway searches the web, reads up to 2 pages and gives them to the model before it answers. `"auto"` does this only when the last message asks for it (a link, "search the web for …", news). How it works and its safety rules are in [agents.md](agents.md).

- **Who may use it:** the node's operator (admin token or trusted loopback). With a client token, `"on"` gets `403 forbidden` and `"auto"` answers without searching, unless the operator set `agent.web.allowClients`.
- **Streaming:** the stream opens at the first step, before a worker is chosen. Step chunks have an empty `delta` and carry `mesh.agent`:

  ```json
  {"mesh": {"agent": {"step": {"kind": "search", "status": "done", "text": "8 results for “…”"}}}}
  {"mesh": {"agent": {"sources": [{"n": 1, "title": "…", "url": "https://…", "kind": "page"}], "query": "…"}}}
  ```

  Step kinds: `query`, `search`, `read`, `answer`; statuses: `running`, `done`, `failed`. Worker attribution (`mesh.workerPeerId`, `route`) then arrives with the first text chunk rather than in the `X-Mesh-Worker` header. While a slow node reads the prompt, `: keep-alive` comments are sent every 15 s.
- **Failure during research:** before the stream opens, an ordinary `502 tool_failed`. After it opened, an error event with code `tool_failed` and no `[DONE]`. Nothing has been answered, so the client may simply ask again.
- **Non-streaming:** `mesh.web` = `{query, sources, steps}` on the response.
- **Timing:** unless `timeout_ms` is set, web requests get the maximum deadline (`timeouts.maxDeadlineMs`, 5 min).

## Tested Python code

With `"mesh": {"code": "on"}` the gateway asks the model for a solution and tests, runs them in its offline Python sandbox, and asks for a fix when they fail, up to 3 rounds. `"auto"` does this only when the last message asks for Python code ("write a Python function…"). How it works and the sandbox's limits are in [agents.md](agents.md#tested-python-code).

- **Who may use it:** the node's operator. With a client token, `"on"` gets `403 forbidden` and `"auto"` answers normally, unless the operator set `agent.code.allowClients`.
- **Streaming:** as for web research, the stream opens at the first step, with step chunks in `mesh.agent`. Step kinds: `write`, `test`, `fix`. Before the answer comes one chunk with the result:

  ```json
  {"mesh": {"agent": {"code": {"passed": true, "untested": false, "rounds": 2, "failure": null}}}}
  ```

  `passed` is `null` when nothing was tested (the model wrote no code, or the sandbox is unavailable). The answer (the model's last reply plus the node's one-line result note) then arrives in one content chunk, followed by the final chunk and `[DONE]`.
- **Answer length:** each round gets at least `agent.code.maxTokens` (1,536) tokens, whatever `max_tokens` says, so there is room for a solution, tests and an explanation. `usage` adds up all rounds.
- **Non-streaming:** `mesh.code` = `{steps, passed, untested, rounds, failure}` on the response.
- **Failure:** as for web research, `tool_failed` (or the model error) before or inside the stream, without `[DONE]`.
- **Timing:** unless `timeout_ms` is set, code requests get the maximum deadline, shared by all rounds.

## Summary scoring (used by the UI's reading test)

`POST /v1/mesh/score` (client token):

```json
{"reference": "ideal text (≤ 4000 chars)", "candidates": ["text", "…"]}
```

It takes 1–20 candidates of ≤ 8000 chars each and returns:

```json
{"rougeL": [{"f1": 0.12, "precision": 0.1, "recall": 0.15}],
 "semantic": {"available": true, "model": "bge-small-en-v1.5-q8_0", "cosine": [0.6], "unrelatedBaseline": 0.3}}
```

- When the embedding model is not installed, `semantic` is `{"available": false, "reason": …}`.
- Scoring runs on the node you call, never on peers, and the texts are neither logged nor stored.
- `GET /v1/mesh/scorer` reports the scorer's state.

## Errors

The body is `{"error": {"message", "type", "code", "retry_after_ms"?, "mesh"?}}`, with a `Retry-After` header where relevant.

| Code | HTTP | Retry elsewhere? |
|---|---|---|
| `bad_request`, `unsupported`, `context_exceeded` | 400 | no |
| `unauthorized` / `forbidden` | 401 / 403 | a different gateway may accept its own token |
| `payload_too_large` | 413 | no |
| `busy`, `gateway_busy` | 429 | yes, after `Retry-After` |
| `draining`, `not_ready`, `no_workers`, `model_mismatch` | 503 | yes |
| `worker_unreachable`, `worker_failed`, `runtime_error`, `protocol_error` | 502 | yes |
| `connect_timeout`, `queue_timeout`, `first_token_timeout` | 504 | yes |
| `interrupted` (stream only) | — | start a **new** answer |
| `tool_failed` | 502 | a tool the gateway ran (web search) failed; ask again later |

## Health

- `GET /health/live`: always `{"status":"ok"}` while the process runs.
- `GET /health/ready`: `200` only when the **local model** is loaded and the node is accepting work, otherwise `503`:

  ```json
  {"ready": true, "model": "ready|loading|unverified|failed|absent", "serving": "accepting|draining|starting", "canServe": true}
  ```

  `canServe` is true when this gateway can route to at least one ready worker, itself or a peer.

## Models

- Time allowed before the first token: `timeouts.firstTokenMs` **plus 80 ms per prompt token**, so long prompts on CPU nodes are not cut off. This applies on the worker and on the gateway.
- `GET /v1/models`: models some reachable node is serving now (usable by OpenAI clients). Each entry's `mesh` field holds name, thinking capability, context, download size, RAM, licence and `available: {nodes, local}`.
- `GET /v1/models?all=1`: the whole vetted catalog. For the node's operator, each entry also has `local: {state, progress, error, fit}`, where state is `not_installed`, `downloading`, `verifying`, `starting`, `serving`, `installed` or `failed`.
- `POST /admin/models/:id/install`: fit check, then resumable verified download, start and advertise, in the background. Poll `GET /admin/models` for progress.
- `GET /admin/runtime`: detected GPUs, installed GPU builds, and the current `accel` (`cpu`/`cuda`/`vulkan`). `POST /admin/runtime {"accel": "cuda"}` switches, installing the pinned GPU build first if needed (see [gpu.md](gpu.md)).
- `POST /admin/models/:id/cancel` stops a download (the partial file is kept for resuming). `POST /admin/models/:id/unhost` stops serving. `DELETE /admin/models/:id` deletes a file that is not served.

Thinking arrives as `delta.reasoning_content` in streams, and as `message.reasoning_content` in non-streaming replies. `mesh.model` and `mesh.effort` report what was used.

## This computer's resources

`GET /admin/system` (admin token) returns one reading of the machine the node runs on:

- `cpu`: model, threads, `usagePct` and `perThreadPct` (since the previous reading), load average, clock, and `tempC` with the sensor it came from (`k10temp Tctl`, `coretemp Package id 0`, …)
- `memory`: total, used, available and swap, in MB
- `gpus[]`: name, load, memory, temperature, power and limit, fan and clock. NVIDIA comes from `nvidia-smi`; AMD from sysfs (`amdgpu`); Intel GPUs are listed without readings.
- `disk`: free and total space on the disk holding the data directory
- `sensors`: every temperature and fan under `/sys/class/hwmon`
- `mesh`: what Werewolf itself uses: the node process and each runtime (one per hosted model, plus the summary scorer), with RAM, CPU (100% = one thread busy) and, for CUDA, GPU memory

A reading the machine cannot provide is `null`. The first request waits about 0.25 s to measure CPU use; requests less than a second apart share one reading. On macOS and Windows only CPU use, memory, load and disk are filled in. The readings are never sent to peers. `./mesh resources [--watch]` prints the same thing in the terminal.

## Splitting and external engines

- `GET /admin/split`: `{accel, lend: {enabled, peers, device, running, detail, tunnels: {active, total, refused, …}}, borrow: {peers: [{peerId, label, connected, lends, reason}]}, models: [{id, split}]}`
- `POST /admin/split/lend` `{"enabled": true, "peers": ["<peerId>"], "device": "cpu" | "gpu"}`
- `POST /admin/models/:id/split` `{"peers": ["<peerId>"], "localShare": 0.6}`: `peers: []` runs the model on this node only; without `localShare`, this node is filled first. The model restarts in the background; `GET /admin/models` shows its `local.split` and `local.detail`.
- `POST /admin/engines` with the fields in [engines.md](engines.md) (`id`, `name`, `url`, …); `GET /admin/engines` lists them with status and fingerprint.
- Responses served by an external engine carry `mesh.runtime: "external"`.
