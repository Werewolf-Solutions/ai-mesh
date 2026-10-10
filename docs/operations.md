# Operating nodes on Ubuntu

Tested on Ubuntu 24.04 x86-64 with Docker 29.8 / Compose 5.5 and Node.js 22.17. Commands that were **not** executed during development (real second machine, VPS, NAT, reverse proxy) are marked *unverified*.

## 1. Prerequisites and sizing

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
# Docker Engine (official repository): https://docs.docker.com/engine/install/ubuntu/
# Node.js >= 22.12 (for the CLI and native mode): https://nodejs.org or nvm
nproc; free -h; df -h .          # CPU, RAM, disk
./mesh doctor                     # after cloning and building
```

The initial sizing target per node is **2 vCPU / 2 GB RAM / 2 GB disk**. That is a target to measure against, not a guarantee. Measured on the development machine ([benchmarks.md](benchmarks.md)): about 150 MB RSS for the node process, about 200 MB for llama-server, and a model file of 105 MB.

## 2. Build, model, runtime

```bash
git clone <repo> werewolf-ai-mesh && cd werewolf-ai-mesh
pnpm install --frozen-lockfile && pnpm build
./mesh model download            # once; SHA-256 verified; kept in ./models
./mesh runtime install           # native mode only; the Docker image already contains it
docker build -f deploy/Dockerfile -t werewolf-mesh/node:0.2.0 .      # Docker mode (includes the pinned llama.cpp)
docker pull ghcr.io/ggml-org/llama.cpp:server-b11223@sha256:8fdfad183be053cdb72d4b6a5930c3a2475730f932855ee9260193422c2564ed
```

**No internet after setup.** To install on a machine without internet access, copy the model file:

```bash
scp models/SmolLM2-135M-Instruct-Q4_K_M.gguf other-host:~/werewolf-ai-mesh/models/
ssh other-host 'cd werewolf-ai-mesh && ./mesh model verify'         # or: ./mesh model import <path>
```

Move the images with `docker save werewolf-mesh/node:0.2.0 | ssh other-host docker load`.

## 3. Launch one node

Native:

```bash
./mesh init --network my-mesh --label home
./mesh start --detach && ./mesh status
tail -f data/node/node.log                                   # logs (JSON, prompts never logged)
curl -s 127.0.0.1:8080/health/ready                          # readiness = model loaded
```

With Docker:

```bash
./mesh init --docker --data data/node --network my-mesh --label home
cp .env.example .env && sed -i "s/^MESH_UID=.*/MESH_UID=$(id -u)/; s/^MESH_GID=.*/MESH_GID=$(id -g)/" .env
docker compose --env-file .env -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml logs -f node
docker compose -f deploy/compose.yaml ps                     # node shows (healthy)
```

**Restart policy.** The containers use `restart: unless-stopped`. For native mode, a systemd unit is simplest (*unverified*):

```ini
# /etc/systemd/system/werewolf-mesh.service
[Service]
User=mesh
WorkingDirectory=/home/mesh/werewolf-ai-mesh
ExecStart=/usr/bin/node apps/node/dist/main.js --data /home/mesh/werewolf-ai-mesh/data/node
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

Stopping is always non-destructive. Only `./mesh reset --data DIR --yes` deletes an identity.

## 4. Addresses and ports

| What | Default | Direction |
|---|---|---|
| libp2p TCP | 4001 | **Inbound** needed only on public / bootstrap / relay nodes (and LAN peers). Home nodes need outbound only. |
| HTTP API/UI | 8080 | Local by default. For remote users, expose it through an HTTPS reverse proxy (443 inbound), never plain HTTP. |
| llama.cpp | none published | One process per hosted model on 127.0.0.1 (natively or inside the node container). Never expose it. |

- **Listen** (`p2p.listen`) is where the socket binds.
- **Announce** (`p2p.announce`, `--announce`) is what you tell others to dial.
- `127.0.0.1`, `10.x/172.16–31.x/192.168.x`, and Docker names like `/dns4/node1/…` are **not** reachable from the internet. On a VPS, announce `/ip4/<public-ip>/tcp/4001` or `/dns4/<hostname>/tcp/4001`.

**Opening ports** (do this yourself; nothing here changes your firewall). On a public node:

```bash
sudo ufw allow 4001/tcp comment 'werewolf mesh p2p'
sudo ufw allow 443/tcp  comment 'https gateway (only if serving remote users)'
```

Docker-published ports bypass ufw on many setups. Keep `MESH_P2P_BIND=127.0.0.1` on home machines; set `0.0.0.0` only on nodes that must accept peers, and prefer your cloud provider's firewall too.

## 5. A realistic layout: two public relays plus home machines

```
            VPS-A (public, relay+bootstrap)         VPS-B (public, relay+bootstrap)
                 ▲          ▲                             ▲          ▲
   outbound only │          │   direct TCP between VPSs   │          │ outbound only
            home-1 ─────────┴────────── (via relay) ──────┴───────── home-2
```

On each VPS (*unverified*: no VPS was used during development):

```bash
./mesh init --docker --data data/node --network my-mesh --label vps-a \
  --announce /ip4/<VPS-A-IP>/tcp/4001 --relay-server --no-relays \
  --bootstrap /ip4/<VPS-B-IP>/tcp/4001/p2p/<VPS-B-ID>
# .env: MESH_P2P_BIND=0.0.0.0 ; open 4001/tcp
```

On each home machine:

```bash
./mesh init --network my-mesh --label home-1 \
  --bootstrap /ip4/<VPS-A-IP>/tcp/4001/p2p/<VPS-A-ID> \
  --bootstrap /ip4/<VPS-B-IP>/tcp/4001/p2p/<VPS-B-ID>
```

Every operator approves every other node:

```bash
./mesh peers approve <their-join.json>
```

Home nodes reserve slots on both relays (`p2p.relayReservations: 2`) and advertise `/p2p-circuit` addresses. The relay gives relayed peers no data or duration cap, but serves authorised peers only.

**Joining an existing mesh:**

1. Run `init` with at least one bootstrap.
2. Export `join-info` and send the **public** JSON to the other operators; it contains no private key and no tokens.
3. Approve their join files locally.
4. Wait for them to approve yours. Nodes reload `authorized-peers.json` within 5 s, or immediately on `kill -HUP <pid>`, or via `POST /admin/reload-admission`.

## 6. HTTPS for remote users (*unverified example*)

Caddy obtains certificates automatically:

```
# /etc/caddy/Caddyfile
mesh.example.org {
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1          # do not buffer SSE
    }
}
```

On that node, set these in `node.json`:

- `"http": {"allowedHosts": ["mesh.example.org"], "trustLoopback": false}`, because the proxy connects from loopback.
- Optionally `"allowedOrigins": ["https://other-ui.example.org"]` for UIs served elsewhere.

Give users a **client** token, never the admin token. A browser can fail over only to gateways it already has configured (Gateways tab). A fresh visit to a dead URL cannot load, so publish two or more gateway URLs, or let people run the UI from their own node.

## 7. Backups and upgrades

- **Back up** `data/<node>/` (identity, tokens, authorised list, config), e.g. `tar czf node-backup.tgz -C data node`. It contains secrets: store it encrypted. The model can always be re-downloaded and verified.
- **Upgrade:**
  1. `git pull && pnpm install --frozen-lockfile && pnpm build`
  2. Rebuild the image.
  3. `docker compose up -d`.

  Identity and state persist across upgrades. A change of model or runtime version changes the fingerprint in `models/manifest.json`; nodes with different fingerprints do not exchange jobs, so upgrade all members together.
- **Rotate tokens:** edit `secrets.json` (replace or add entries) and restart.
- **Revoke a peer:** `./mesh peers revoke <id>`. Open connections to it are closed on reload.

## 8. Demonstrating failures

With a local cluster (Docker or native):

```bash
./mesh demo failover --dir deploy/generated/cluster-3
```

**Loss of either public bootstrap/relay:** `tests/integration/relay.test.ts` runs two relays and two NAT-only nodes (no listening socket). It stops relay 1 and then relay 2 in turn, and shows the NAT-only nodes still serving each other through the survivor. Run it with:

```bash
pnpm test:integration relay
```

By hand on a Docker cluster:

```bash
docker compose -f deploy/generated/cluster-3/compose.yaml stop node1
./mesh chat --data deploy/generated/cluster-3/node3 --target <node2-peer-id> "still there?"
docker compose -f deploy/generated/cluster-3/compose.yaml start node1
```

**No internet:** in v0.1 this was checked with `deploy/compose.offline.yaml` (a `mesh` network without a default route). v0.2 generated clusters use the same `mesh` network name, so the overlay still applies. Models must already be downloaded; installing new ones needs internet.

## 9. Manual two-machine test (*unverified; please run and record*)

1. **Machine A** (LAN IP `A`): `./mesh init --network t --label a`, then `./mesh join-info --out a.json`. Allow inbound 4001/tcp from B.
2. **Machine B:** `./mesh init --network t --label b --bootstrap /ip4/A/tcp/4001/p2p/<A-id>`, then `./mesh join-info --out b.json`.
3. Copy the files across. Run `./mesh peers approve b.json` on A and `./mesh peers approve a.json` on B. Start both.
4. On B, run `./mesh peers status`: A should be `direct available`.
5. Run `./mesh chat --target <A-id> "hi"`: the output names A as the worker.
6. **Provider loss:** stop A mid-answer, and the answer is marked `[INTERRUPTED …]`. A new request is served by B locally.
7. **Partition:** `sudo iptables -I INPUT -s A -j DROP` on B. Within about 15 s, B shows A unavailable and serves locally. Remove the rule, and they reconnect with backoff (≤ 60 s).
8. **NAT/relay:** repeat with B behind home NAT and A on a VPS with `--relay-server`. Add a second home machine C. On C, `./mesh peers status` should show B as `relayed`.
## Trusted coding farm

See [farm setup and operations](farm.md) for manual farm mode, prepared pinned
images, source/command review, submission, cancellation, encrypted storage and
recovery. This release supports native Linux workers with Docker. The standard
node container has no Docker CLI/socket and cannot execute farm routines; do not
add a Docker socket to ordinary node containers to enable it.
