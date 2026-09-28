# Werewolf AI Mesh

A self-hosted, peer-to-peer network for running an openly licensed language model on computers you and people you trust control. No commercial AI API, subscription, account, blockchain or token is needed to use it.

**Version 0.1 is replicated inference.** Every full node holds a *complete* copy of the same small model (SmolLM2-135M-Instruct, 4-bit GGUF) and the mesh spreads requests across nodes. More nodes give more serving capacity and survive more failures. They do **not** make the model smarter, pool memory, or split a model across machines; that is future work ([roadmap](docs/roadmap.md)).

## What works in v0.1

Each full node:

- answers questions with a real local model: a pinned llama.cpp runtime runs as a separate process or container, and the model file is SHA-256 verified before every load
- has its own persistent Ed25519 identity, and accepts only the peers its operator approved
- finds other approved peers through bootstrap addresses, a peer cache, and bounded peer exchange; no central coordinator is required
- routes each request to itself or to a directly connected peer, based on locally measured load and latency
- retries on up to two other workers if a worker fails **before** any text was produced; if one fails **after** text started, the answer is marked *interrupted* and never silently continued elsewhere
- reaches peers behind NAT through circuit relays run by public nodes, and keeps working if either of two relays is lost
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
docker build -f deploy/Dockerfile -t werewolf-mesh/node:0.1.0 .
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
| `./mesh model download` / `import <file>` / `verify` | Get, import or re-verify the pinned GGUF |
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
- [Model provenance](docs/model.md)
- [Benchmarks](docs/benchmarks.md) · [Testing](docs/testing.md) · [Roadmap](docs/roadmap.md) · [Progress checklist](PROGRESS.md)

Running a node costs its operator electricity, hosting and bandwidth. "Free to use" means nobody charges you, not that it costs nothing.

## Licence

Project code: Apache-2.0 ([LICENSE](LICENSE)). The model (Apache-2.0, Hugging Face) and llama.cpp (MIT) keep their own licences; see [NOTICE](NOTICE).
