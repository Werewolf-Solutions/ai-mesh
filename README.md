# Werewolf AI Mesh

A self-hosted, peer-to-peer network for running an openly licensed language model on computers you and people you trust control. No commercial AI API, subscription, account, blockchain or token is needed to use it. (Nodes can earn WLF reward points for serving others; they are points, not a token.)

**Version 0.2 is replicated inference with a choice of models.** You pick a model from a vetted catalog (from SmolLM2 135M up to Qwen3 8B, all Apache-2.0) and an effort level, like in ChatGPT. Every node that serves a model holds a *complete* copy of it, and the mesh sends each request to a node serving the chosen model. Running a model on your computer shares it with the whole pack. More nodes give more capacity and survive more failures. They do not make a model smarter. Separately, a model too big for one computer can be **split** across several trusted machines ([docs/split.md](docs/split.md)); that runs slower than a model on one GPU.

## What works

Each full node:

- lets you **choose a model and an effort level** ([docs/models.md](docs/models.md)):
  - Fast answers straight away; Balanced and Thorough let models with a thinking mode reason first, within a token budget the mesh enforces.
  - A model nobody runs yet can be downloaded and started on your own node with one click. It is SHA-256 verified, resumable, and checked to fit your RAM and disk, and it is then served to the whole pack.
- lets you **share a GPU**: `./mesh gpu on` (or *Models → Use the GPU*) runs your models on it (Qwen3 8B: 6 → 58 tokens/s on an RTX 3060), and other nodes send you more work because they measure that you answer faster ([docs/gpu.md](docs/gpu.md))
- answers questions with a real local model: a pinned llama.cpp runtime runs as a separate process or container, and the model file is SHA-256 verified before every load
- has its own persistent Ed25519 identity, and accepts only the peers its operator approved
- finds other approved peers through bootstrap addresses, a peer cache, and bounded peer exchange; no central coordinator is required
- routes each request to itself or to a directly connected peer, based on locally measured load and latency
- retries on up to two other workers if a worker fails **before** any text was produced; if one fails **after** text started, the answer is marked *interrupted* and never silently continued elsewhere
- reaches peers behind NAT through circuit relays run by public nodes, and keeps working if either of two relays is lost
- keeps an anonymous **pack memory**: people share how they solved a problem, every node keeps a copy, similar ideas merge, and relevant notes are shown and given to the model when a similar question comes up ([docs/pack-memory.md](docs/pack-memory.md))
- earns **WLF reward points** for answering other people's requests (never for its own use or its own network), with signed receipts, trust-weighted and settled daily ([docs/rewards.md](docs/rewards.md)). WLF are points, not a token
- can **split one model across machines**: layers run partly on this node and partly in memory lent by trusted peers, through the mesh's encrypted connections, for models too big for any one computer ([docs/split.md](docs/split.md))
- can **serve models from external engines** such as ds4-server, LM Studio or Ollama to the whole pack ([docs/engines.md](docs/engines.md))
- can **search the web** before answering (*Web* button in the chat): a local SearXNG searches, the node reads up to two pages safely, and the model answers citing them ([docs/agents.md](docs/agents.md))
- can **write Python and test it** before answering (*Code* button): the model writes the code and tests, your node runs them in an offline Docker sandbox and has the model fix failures ([docs/agents.md](docs/agents.md#tested-python-code))
- shows its operator how hard the computer is working (*Computer* page, `./mesh resources`): CPU, RAM and GPU use, temperatures, fans, and how much of it Werewolf's own processes take. These readings stay on the node.
- serves an OpenAI-compatible subset of the HTTP API and a UI with chat, a network dashboard, and a Tests page: a reading-speed test you can run against any node, with each summary scored against an ideal summary (optional `./mesh model download --scorer`), plus the published benchmarks

What each failure does, and what it does not survive, is listed in [docs/architecture.md](docs/architecture.md#failures-tolerated). The security assumptions are in [docs/security.md](docs/security.md).

## Quick start: one node on this machine

Needs Ubuntu x86-64 (the tested baseline), Node.js ≥ 22.12, and about 1 GB of disk. The pinned arm64 and macOS runtime builds are listed but untested.

```bash
scripts/setup.sh                                   # pnpm install, build, runtime install, model download, doctor
./mesh init --network my-mesh --label laptop       # creates data/node: identity, tokens, config
./mesh start                                       # foreground; Ctrl-C drains gracefully
```

Then, in another terminal:

```bash
./mesh chat "What is the capital of France?"
./mesh status
```

Open `http://127.0.0.1:8080/` for the chat UI. On this machine the node trusts loopback, so no token is needed. `./mesh ui-url` prints a URL that carries the tokens in the fragment, for browsers that need them.

To run it in the background, use `./mesh start --detach` and `./mesh stop`. Stopping never deletes data. `./mesh reset --data DIR --yes` is the only destructive command.

### With Docker instead

```bash
docker build -f deploy/Dockerfile -t werewolf-mesh/node:0.2.0 .
./mesh model download
./mesh init --docker --data data/node --network my-mesh --label laptop
cp .env.example .env        # set MESH_UID/MESH_GID to $(id -u)/$(id -g)
docker compose --env-file .env -f deploy/compose.yaml up -d
./mesh chat --url http://127.0.0.1:8080 --token "$(python3 -c 'import json;print(json.load(open("data/node/secrets.json"))["clientTokens"][0])')" "Hello"
```

The llama.cpp container sits on an internal network with no published port and no internet access.

## Three-node demonstration

```bash
scripts/local-cluster.sh 3                             # builds the image if needed, generates, starts
./mesh demo failover --dir deploy/generated/cluster-3  # remote routing, failover, interruption, bootstrap loss
./mesh cluster down --dir deploy/generated/cluster-3
```

For machines without Docker, the same cluster runs as native processes:

```bash
./mesh cluster generate --nodes 3 --mode native --out data/cluster3
./mesh cluster start --dir data/cluster3
./mesh demo failover --dir data/cluster3
./mesh cluster stop --dir data/cluster3
```

`--nodes 10` generates ten nodes. Running ten real runtimes needs roughly 10 × 350 MB of RAM.

## Adding a second machine

Admission is mutual and manual: each operator approves the other. There is no hidden membership server.

On the **new machine** (B):

```bash
scripts/setup.sh
./mesh init --network my-mesh --label machine-b \
  --bootstrap /ip4/<A-address>/tcp/4001/p2p/<A-peer-id>
./mesh join-info --out b-join.json        # public: peer ID + advertised addresses only
```

On **your first machine** (A):

```bash
./mesh join-info --out a-join.json
./mesh peers approve b-join.json          # A now accepts B (picked up within ~5 s)
```

Back on **B**: `./mesh peers approve a-join.json`, then `./mesh start`. Check with `./mesh peers status`.

Addresses matter:

- On the same LAN, `<A-address>` is A's LAN IP, and A's firewall must allow inbound TCP 4001 from B.
- Across the internet, at least one side needs a public address. Put a node on a VPS with `--announce /ip4/<public-ip>/tcp/4001 --relay-server`, allow inbound TCP 4001 there, and use it as the bootstrap and relay for home machines.
- Home machines only dial out. Two home machines behind NAT reach each other through the relay.

Full steps, including a second relay, are in [docs/operations.md](docs/operations.md).

## Commands

| Command | Purpose |
|---|---|
| `./mesh doctor` | Prerequisite checks (Node, CPU/RAM/disk, Docker, model hash, runtime build, permissions, ports) |
| `./mesh runtime install` | Download the pinned llama.cpp build (SHA-256 checked) |
| `./mesh gpu [status\|on [cuda\|vulkan]\|off]` | Run this node's models on its GPU (downloads the pinned GPU build first) or the CPU |
| `./mesh rewards [status\|export\|settle\|import\|verify]` | WLF points: receipts, settlement by the network's settler, and verification |
| `./mesh split [status\|lend on PEER…\|lend off\|model ID PEER…]` | Lend memory to trusted peers, or split a model across lenders |
| `./mesh engine [list\|add ID --url URL …\|remove ID]` | Serve a model from an OpenAI-compatible engine (ds4-server, LM Studio …) |
| `./mesh search start\|stop\|status\|test "…"` | Run the local SearXNG search engine used for web research (Docker, 127.0.0.1 only) |
| `./mesh code setup\|status\|test` | Install and check the offline Python sandbox used to test code answers (Docker) |
| `./mesh resources [--watch]` | This computer's CPU, RAM, GPU, temperatures and fans, and what Werewolf uses |
| `./mesh models [install\|unhost\|remove] ID` | List the model catalog; download and serve, stop, or delete a model |
| `./mesh model download` / `import <file>` / `verify` `[--model ID]` | Get, import or re-verify a catalog model's GGUF |
| `./mesh init` | Create config, identity and HTTP tokens (never overwrites) |
| `./mesh join-info` | Export public join info |
| `./mesh peers approve\|revoke\|list\|status` | Manage and inspect authorised peers |
| `./mesh start [--detach]` / `stop` / `status` | Run and inspect one node |
| `./mesh chat "…"` | Send a request from the terminal (`--target`, `--prefer`, `--no-stream`) |
| `./mesh ui-url` | UI link with credentials in the URL fragment |
| `./mesh cluster generate\|up\|down\|ps\|logs\|start\|stop` | Local 2–10 node clusters (Docker or native) |
| `./mesh demo failover --dir DIR` | Scripted failure demonstration |
| `./mesh reset --data DIR --yes` | Delete a node's identity and state |

## Tests

```bash
pnpm test:unit          # pure logic
pnpm test:integration   # multi-process meshes with a deterministic FAKE runtime (fault injection only)
pnpm test:real          # real llama.cpp + verified model
```

What was run, and what could not be, is recorded in [docs/testing.md](docs/testing.md). Measured numbers are in [docs/benchmarks.md](docs/benchmarks.md).

## Documentation

- [Architecture and failure behaviour](docs/architecture.md)
- [Peer protocol](docs/protocol.md) and [HTTP API](docs/api.md)
- [Ubuntu operations guide](docs/operations.md)
- [Security assumptions](docs/security.md)
- [Models, effort and sharing compute](docs/models.md)
- [Sharing a GPU](docs/gpu.md)
- [WLF rewards and their threat model](docs/rewards.md)
- [Splitting a model across machines](docs/split.md) · [External engines](docs/engines.md)
- [Web research and tested code](docs/agents.md) · [Tools and agents: design](docs/agents-design.md)
- [Pack memory](docs/pack-memory.md)
- [Model provenance](docs/model.md)
- [Benchmarks](docs/benchmarks.md) · [Testing](docs/testing.md) · [Roadmap](docs/roadmap.md) · [Progress checklist](PROGRESS.md)

Running a node costs its operator electricity, hosting and bandwidth. "Free to use" means nobody charges you, not that it costs nothing.

## Licence

Project code: Apache-2.0 ([LICENSE](LICENSE)). The model (Apache-2.0, Hugging Face) and llama.cpp (MIT) keep their own licences; see [NOTICE](NOTICE).
