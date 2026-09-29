# Testing: what ran and what did not

Environment: Ubuntu 24.04 x86-64, Ryzen 7 3700X, 16 GB RAM, Docker 29.8.1 / Compose 5.5.1, Node.js 22.17.0, pnpm 10.34.5. Last full run: 2026-09-28.

## Test tiers

| Command | Runtime | Result |
|---|---|---|
| `pnpm test:unit` | none | **112/112 passed** |
| `pnpm test:integration` | **FAKE deterministic adapter**, real separate OS processes, real libp2p | **72/72 passed** |
| `pnpm test:real` | **real llama.cpp b11223 + verified model** | **18 passed** (plus a GPU test when an NVIDIA GPU is present, which passed on an RTX 3060), including meaning-match scoring, pack-memory retrieval, installing a catalog model through the admin API, effort on/off, routing by model across nodes, and the thinking budget stopping Qwen3 4B (the one "skipped" entry is the placeholder that only runs when the model is missing) |

The fake adapter emits placeholder tokens (`t0 t1 …`) and supports fault directives such as `[[fake:crash_after=3]]`. Its guard rails:

- It is enabled only with `runtime.kind: "fake"` **and** `MESH_ALLOW_FAKE_RUNTIME=1`.
- It advertises a distinct model fingerprint, so real nodes never route to it.
- Every response it produces is labelled `runtime: fake`.

It is never used by real deployments.

## Required risks, and where each is covered

| # | Risk | Fake-runtime integration | Real model |
|---|---|---|---|
| 1 | Fresh node initialises, verifies, loads, answers locally | — | `real-model.test.ts` "fresh node" (+ manual `./mesh init/start/chat`) |
| 2 | Distinct persistent identities, discovery, restart keeps identity | `mesh.test.ts` identity / peer exchange / restart; `ten-nodes.test.ts` | "three nodes discover", "restart preserves identity" |
| 3 | Deliberate remote routing with visible serving identity | `mesh.test.ts` "routes … deliberately" | "request routed to a chosen remote node"; Docker demo step 2 |
| 4 | Worker lost before output → bounded failover; during output → interrupted | `mesh.test.ts` SIGSTOP failover, 3-attempt cap, SIGKILL mid-stream | "4a" / "4b"; native and Docker demo steps 3–4 |
| 5 | Cancellation stops work and frees slot / queue entry | `mesh.test.ts` remote cancel; `limits-and-client.test.ts` queued cancel | "5. cancellation" (next TTFT 35–40 ms) |
| 6 | Bootstrap stopped → survivors still serve | `mesh.test.ts` both bootstraps stopped (4 nodes, peer exchange) | "6. after stopping the bootstrap node"; demo step 5 |
| 7 | Client gateway fallback; no merging of answers | `limits-and-client.test.ts` (dead → wrong-token → good gateway; mid-stream failure never calls next gateway; gateway killed → interrupted) | Browser UI checked manually (below) |
| 8 | Unauthorised peers, stale/untrusted adverts, malformed frames, wrong fingerprint, oversized | `security.test.ts` (15 cases incl. 7-byte chunked frames, 10 MiB length prefix, spoofed status/origin, duplicate IDs, HTTP 413) | — |
| 9 | Saturation rejects predictably; bounded memory/connections | `limits-and-client.test.ts` (12 requests → 9 accepted, 3 × 429 with Retry-After; spill-over; burst bounds) | — |
| 10 | Inference with download services unavailable | — | Docker cluster on an `internal: true` network: DNS/HTTPS to huggingface.co failed from node and runtime containers; node3 → node1 real inference succeeded |
| — | Circuit relay between two NAT-only nodes, loss of either relay | `relay.test.ts` (no listening socket on home nodes; both relays lost in turn; reservation restored) | — |

## Also executed by hand

- **Native one-node flow:** `./mesh init`, `start --detach`, `chat` (streaming and non-streaming), `status`, `stop`, and `doctor`.
- **Token accounting:** the runtime reported 1931 prompt tokens and our pre-count matched exactly. `max_tokens` 117 was accepted and 118 rejected (2048 boundary).
- **`./mesh runtime install`, `model download`, `model import`:** a corrupt file was rejected with hash_mismatch; a re-download is a no-op.
- **Docker single node** (`deploy/compose.yaml`): healthy; real answer; `401` without a token.
- **Docker 3-node cluster:** healthy; `./mesh demo failover` passed every step (twice).
- **10-node Docker Compose generation:** `docker compose config` is valid; 10 identities and 10 runtimes. The ten real runtimes were not started.
- **No orphaned llama-server after SIGKILL of a node:** checked by hand and in the real tests.
- **Browser UI** (Chrome, against the real 3-node cluster):
  - chat streaming, attribution badge, Stop
  - recovery of an answer left "streaming" by a reload (shown as interrupted, with Retry)
  - network dashboard with the peer ring and table

  Two UI bugs found this way were fixed: a crash on the first message, and a stuck "streaming" state.
- **Tests page** (Chrome, real 3-node cluster): showing and hiding the text, choosing a node, a live timer, the result (1,408 tokens read by node1 in 3.81 s), run history, and the rendered `docs/benchmarks.md` view. Also checked: summary scoring (meaning match 40–43%, word overlap 12–15% for real runs), showing and hiding each run's summary next to the ideal, and re-scoring an older run.

## v0.2 models and effort (executed)

- All 9 catalog models were downloaded (SHA-256 verified) and run on llama.cpp b11223, with load time, RAM, speed and a thinking on/off check each (`docs/models.md`).
- `tests/integration/models.test.ts` (fake runtime):
  - catalog view
  - routing only to nodes serving the model
  - `no_workers` for unserved models
  - thinking streamed separately, with the budget enforced (512 / 256 tokens)
  - install and unhost through the admin API, persisted across restart
- **Browser, real 2-node cluster:**
  - picked Qwen3.5 0.8B from "Not running yet" → "Run on this computer" → loading progress → auto-selected
  - Balanced: live thinking, "Thought for 17 s", answer 391
  - Fast: answer 441, which is wrong
  - Models page
- **Real download through the node:** cancelled at 318 MB, resumed, byte-identical file, then served.
- **Docker 2-node cluster:** node1 installed Qwen3.5 inside its container; node2's request with thinking was served by node1 (391).

## GPU sharing (executed on an RTX 3060 12 GB)

- CUDA and Vulkan builds of llama.cpp b11223 were downloaded, verified and benchmarked (docs/gpu.md).
- `./mesh gpu on cuda` switched a running node in 2.4 s. `./mesh gpu on vulkan` with the build deleted first downloaded, verified and restarted everything in 12 s.
- Qwen3 8B: refused on the CPU (RAM check), then installed and served on the GPU (58 tok/s).
- In a real CPU + GPU pair, the CPU node sent all its requests to the GPU node.
- UI: the Models page GPU card switched GPU → CPU → GPU.
- `tests/integration/speed.test.ts`: the gateway learns the faster node from measured answers.

## Computer page and `./mesh resources` (executed, 2026-09-29)

- Readings checked against this machine (Ryzen 7 3700X, RTX 3060): CPU temperature from `k10temp Tctl` (matches the board's own `CPU Temperature` sensor within 1 °C), GPU load, memory, temperature, power and fan from `nvidia-smi`, per-process GPU memory parsed from `nvidia-smi --query-compute-apps` (5,840 MiB for the Qwen3 8B CUDA runtime; the page itself was checked with a CPU-only test node, so that column was not seen filled in the browser), NVMe and motherboard temperatures, and two fans.
- Browser (Chrome): tiles, meters and 5-minute trend lines with a hover readout, per-thread bars, the "What Werewolf uses" table (node, SmolLM2 runtime and scorer), sensors and disk.
- `tests/unit/resources.test.ts` (parsers and a live reading) and an integration check that `/admin/system` is refused to a client token (403).
- Not checked: AMD and Intel GPUs, Intel `coretemp`, macOS and Windows (only the portable readings apply there).

## Code pipeline (executed, 2026-09-29)

- `tests/unit/code.test.ts` (20 cases): reading replies (solution, tests, the person's own tests), when "auto" runs, the pass marker (an early `sys.exit(0)` is not a pass), reading failures, the loop (pass in round 1, fix in round 2 with the same conversation prefix, give up after 3, best round wins, no code, no sandbox), and every `docker run` restriction.
- `tests/integration/code.test.ts` (13 cases, real Docker, skipped without it):
  - sandbox escapes: network, DNS, Docker host and metadata address blocked; writes refused and `/tmp` not executable; no host mounts; runs as nobody; endless loop, fork bomb (stopped below 64 processes) and a 512 MB allocation stopped; output flood capped; cancel
  - the Python test harness: every test runs, both sides of a failing `==` are shown, the solution line that raised is named, the person's tests run too
  - through a node process with a scripted stand-in engine: write → failing test → fix → pass, streamed steps, the value-level failure reaching the fix round, usage over both rounds, non-streaming, operator only (403 for a client token with "on", "auto" quietly off), no `code` + `web` "on", and "auto" only for Python requests
- `./mesh code test` on this machine: all 5 checks pass; a run takes about 0.3 s.
- Real model, Qwen3 8B on the RTX 3060 (the operator's running node, reached as an external engine from a test node), the 6 tasks of `scripts/code-eval.mjs`, graded afterwards by that script's own hidden tests:

  | Task | Effort none: own tests | Effort low: own tests | Hidden tests (both) |
  |---|---|---|---|
  | ipv4 | 9/9, round 1 | 10/10, round 1 | pass |
  | intervals | 6/6, round 1 | 6/6, round 1 | pass |
  | lru | 0/6 after 3 rounds | 7/8 after 3 rounds | pass: the model's tests were wrong (`LRUCache(1).put(1, 1).get(1)`, but `put` returns None) |
  | csv | 3/6 after 3 rounds | 1/6 after 3 rounds | fail: the tests caught a real bug, which 3 rounds did not fix |
  | wordfreq | 2/5 after 3 rounds | ran, no tests | pass: at effort none the model's expected order was wrong |
  | bugfix | 6/6, round 1 | 6/6, round 1 | fail: the hidden "must not mutate the input" was never asked for |

  Rounds took 4–25 s at effort none and 12–53 s at effort low. What it shows: with this 8B model the pipeline did **not** raise the hidden pass rate (4 of 6, the same as without it). What it adds is an honest label: every broken solution was reported as failing, with the failing case. Its weak spot is the model's own tests: a wrong test makes correct code look broken (lru), which is why the note says the test may be wrong.
- A first version reported only `AssertionError`, and the model rewrote the same wrong tests three times. Running each test separately and showing both sides of `==` made the failures readable, but did not make this model fix its own tests.
- Not checked in a browser: the chat's **Code** button (the build passes). The operator's node runs the build from before this change and rejects the new `mesh.code` field, so the web UI it serves was left at that build. It needs `pnpm build` and a node restart together.

## Web research (executed, 2026-09-29)

- `tests/unit/agent.test.ts` (56 cases):
  - an SSRF matrix: 22 blocked addresses including metadata, CGNAT, IPv4-mapped, NAT64 and 6to4; decimal, octal and hex spellings; schemes, ports and credentials; a name with one private address among public ones
  - against a live local server: redirect to the metadata address refused, redirect loop stopped, size cap while streaming, non-page types, a page that never finishes
  - page extraction and passage choice; when to search, and the query rules
  - a model trying to smuggle a URL into its query is never fetched
- `tests/integration/web.test.ts` (real node process, fake model, stand-in SearXNG and pages): step and source chunks precede the answer; the PDF is not read; a metadata-address result is dropped; the model's prompt grows by the page text; "auto" only when asked; client tokens cannot search (403 for "on"); search down gives `tool_failed`, both HTTP and in-stream.
- Real SearXNG (`./mesh search start`, image 2026.9.29) on the real internet:
  - SmolLM2 135M: wolf pack size, and "tallest mountain in the Alps" (Mont Blanc, 4,806 m, from Wikipedia) in the browser
  - Qwen3 4B on the CPU: llama.cpp releases, answered with [2]/[3] citations from GitHub's release page. Reading the 2,319-token prompt took 104 s, which the fixed 30 s first-token timeout had cut off; the allowance now grows with the prompt.
- Seen in practice: some sites refuse automated readers (HTTP 403, whatever the user agent). The pipeline tries up to 4 results and falls back to search summaries.
- Not run: web research with Qwen3 8B on the GPU node (that node runs the pre-change build and was not restarted).

## Splitting a model across machines (executed, 2026-09-29)

- `tests/real/split.test.ts`: two real node processes; node2 lends CPU memory, and node1 splits Qwen3.5 0.8B half and half.
  - With temperature 0, the split answer is **token-for-token identical** to the unsplit answer, both before and after the lender is lost and returns.
  - A lender that hasn't allowed node1 refuses it, and node1 says "does not lend to this node".
  - Killing the lender mid-answer gives an interrupted answer (no `[DONE]`), and its `ggml-rpc-server` dies with it. The model then says "waiting for them", and splits again once the lender is back.
- Direct llama.cpp check: for Qwen3.5 0.8B, Qwen3 1.7B and SmolLM2, split and unsplit answers are identical at temperature 0.
- By hand, with a CUDA node and a CPU lender:
  - Qwen3 4B split answered correctly at 14.4 tokens/s.
  - Qwen3 8B at 80/50/20% on the GPU: 17 / 9 / 6.2 tokens/s, against 55 unsplit.
  - The automatic policy correctly kept the 8B model whole on the GPU because it fits.
  - The UI lend card and split control were checked in Chrome.
- Found and fixed along the way:
  - llama.cpp puts RPC devices *first* in `--tensor-split`, so our first split order was reversed.
  - A lender reports all of its RAM as free, so llama.cpp's own split gave the slow CPU most of the model.
  - A llama-server that ignores SIGTERM could outlive a killed node: the parent-death signal is now SIGKILL, and the scorer now escalates to SIGKILL and cannot start after shutdown.
- `tests/unit/split.test.ts`: the placement plan and the GGUF header reader (block counts checked against all 10 local models).
- **Not tested between two physical machines.**

## External engines (executed against a stand-in, 2026-09-29)

- `tests/integration/engines.test.ts` with `tests/standin-engine.ts`, an OpenAI-compatible server shaped like ds4-server's API:
  - operator-only access, and a wrong API key reported;
  - node2 discovers and uses a model only node1 knows, marked `runtime: external`;
  - the thinking switch and the thinking budget (stopped at 512);
  - the engine goes down, is withdrawn from the pack, and returns by itself;
  - removal.
- **Not tested against real ds4-server:** its models need 96 GB+ of memory.

## WLF rewards (executed, 2026-09-29)

- `tests/unit/rewards.test.ts` (18 cases, real Ed25519 signatures): honest pro-rata payout; exclusions (self-use, same network from either side, test runtime, short answers, duplicates); plus the attacks:
  - a ring of 6 fake nodes vouching for each other earns 0;
  - 1,000 fake accounts vouched by one person get almost no trust, while a seed approving 50 peers is not diluted;
  - one colluder can't make a farm node qualify, and gets capped;
  - two colluders are bounded by caps × trust;
  - forged receipts, receipts submitted by the wrong node, and tampered bundles are rejected;
  - 20 empty nodes change nothing, and halving starts at 16 qualified nodes;
  - fake users can't inflate the node-count pool (at most 50 WLF instead of 800);
  - trust is conserved down vouch chains;
  - settlement is deterministic.

  Same-network detection is tested on LAN, loopback, CGNAT, the same IPv6 /56, other networks and relayed connections.
- `tests/integration/rewards.test.ts` (3 real node processes, in rewards test mode): own use earns nothing; 3 answers served to 2 other nodes give 3 verified receipts; a correctly signed receipt for a job that never ran is refused ("no such job"); settlements signed by the wrong key, or tampered after signing, are refused; the right one is imported and shows in the balance; a client token gets 403.
- CLI smoke test on a 3-node test cluster: `rewards export → settle → verify → import`. `verify` reports "identical" for the real settlement, and INVALID / DIFFERENT (exit 1) for a copy with its pool edited.
- The real-model suite passes with rewards hooks active.
- Found while testing: the first design let trust multiply along vouch chains (each level passed on 4× what it received) and let fake users qualify farm nodes that inflate the node-count pool. Trust is now conserved, and the pool follows the trust of the people served.
- **Not tested:** real multi-operator use, and parameter tuning with real traffic.

## Not validated (the environment could not provide it)

| Item | Why not | How to run it |
|---|---|---|
| Two real machines, LAN and internet | Only one machine was available | [operations.md §9](operations.md#9-manual-two-machine-test-unverified-please-run-and-record) |
| Real NAT traversal via a public VPS relay | No VPS was purchased or used (as instructed) | operations.md §5 and §9 step 8 |
| Provider/geographic failure domains, real partitions | Same host only | operations.md §9 steps 6–7 (iptables) |
| HTTPS reverse proxy (Caddy) | No public DNS name | operations.md §6 |
| systemd unit | Not installed on the dev machine | operations.md §3 |
| ARM64 / macOS runtime binaries | Not available | Pinned in the manifest, marked `tested: false` |
| Native offline test with network namespaces | Ubuntu blocks unprivileged user namespaces (`apparmor_restrict_unprivileged_userns=1`); host security settings were not changed | Docker `internal` network used instead |
| Ten nodes each running the real model | Deliberately not run on one laptop | `./mesh cluster generate --nodes 10 && ./mesh cluster up …` on a host with ≥ 4 GB RAM |
| GPU acceleration | Out of scope for the CPU baseline | — |
| GPU inside Docker | Needs the NVIDIA Container Toolkit and a GPU image; not built | Run a native node for GPU sharing |
| AMD / Intel GPUs via Vulkan, macOS Metal | No such hardware here | `./mesh gpu on vulkan` |
| Qwen3 8B inside Docker | Needs `MESH_MEM` ≥ 10g; only run natively | `MESH_MEM=10g`, then install from the Models page |
