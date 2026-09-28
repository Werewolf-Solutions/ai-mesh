# Architecture

## Replicated inference, stated plainly

In v0.1 every full node loads the *entire* model and can answer any request by itself. The mesh decides **which** node answers. Adding a node adds:

- serving capacity (one more concurrent generation, plus eight queued, per node by default)
- availability (another place a request can go when a node fails)

Adding a node does **not** add model quality, context length, pooled RAM/VRAM, or faster single-request generation. No part of a model is executed across machines. Splitting large models across machines is roadmap work.

## Components

```
 browser / HTTP client ──HTTPS/HTTP + SSE──▶ gateway (any full node)
                                              │
     ┌────────────────────────────────────────┴───────────────────────────┐
     │ Full node (one process: apps/node)                                  │
     │  Fastify HTTP API ── Gateway (routing, retries) ── WorkerService    │
     │        │                    │                          │            │
     │   auth, CORS,         InferClient ◀─libp2p─▶ InferHandler   WorkerPool (1 running, 8 queued)
     │   Host checks              │                          │            │
     │                     PeerManager (status, probes,  InferenceAdapter  │
     │                     hints, backoff, cache)          │  (llama.cpp)  │
     │                            │                        ▼            │
     │                     libp2p host: TCP · Noise · Yamux · identify ·   │
     │                     ping · circuit relay v2 (client; server opt-in) │
     └──────────────────────────────────────────────────────────┬────────┘
                                                                 │ loopback / internal network only
                                          one llama-server process per hosted model (loopback only)
```

| Path | Responsibility |
|---|---|
| `packages/protocol` | Versioned Zod schemas for peer frames and HTTP bodies, error codes, the SSE parser |
| `packages/client` | HTTP/SSE client: gateway failover before output, interruption detection after it |
| `apps/node/src/runtime` | `InferenceAdapter`, the llama.cpp adapter (spawn / external), and the fake test adapter |
| `apps/node/src/worker` | Atomic admission, bounded queue, dedup cache, execution timeouts |
| `apps/node/src/p2p` | libp2p host and gater, framing, status/peer manager, inference protocol |
| `apps/node/src/gateway` | Candidate ranking and bounded retry policy |
| `apps/node/src/http` | HTTP API, authentication, SSE streaming, static UI |
| `apps/web` | React chat UI and network dashboard |

### State on disk (per node, `data/<node>/`)

| File | Contents | Mode |
|---|---|---|
| `node.json` | Configuration (no secrets) | 600 |
| `identity.key` | Ed25519 private key (libp2p protobuf) | 600 |
| `secrets.json` | HTTP client and admin tokens | 600 |
| `authorized-peers.json` | Operator-approved peer IDs (+ optional addresses) | 600 |
| `peers-cache.json` | Up to 64 recently seen authorised peers' addresses, 7-day expiry | 600 |
| `runtime.key`, `runtime.pid` | Per-start key for the loopback runtime API; child PID for cleanup | 600 |

All writes are atomic (temp file + fsync + rename). No database is used. Chats live only in the browser.

## Discovery and connectivity

1. On start, a node dials its configured **bootstrap** addresses. They must end in `/p2p/<id>`, and that ID must be authorised; otherwise the address is ignored. It also dials addresses listed in `authorized-peers.json` and in its **peer cache**.
2. Every `probeIntervalMs` (5 s) the node runs the **status protocol** with each connected authorised peer. Both sides exchange a `StatusRecord` about **themselves**: readiness, model fingerprint, active jobs, queue length, and their own advertised addresses. A record is accepted only if its `peerId` equals the authenticated remote peer and its `networkId` matches. RTT is measured locally.
3. The reply also carries up to 32 **hints**: "I am connected to peer X at these addresses". Hints for peers we have not authorised are dropped. Hints never set status; they only add dial candidates.
4. Three consecutive failed probes mark a peer unavailable and close the connection. Status older than `statusTtlMs` (20 s) is ignored. Reconnects use exponential backoff with jitter (1 s → 60 s).
5. **Relays.**
   - Nodes with `p2p.relayServer: true` (public VPS nodes) offer circuit-relay v2 reservations to authorised peers only, without the default 2 min / 128 KiB circuit limit.
   - Other nodes hold `relayReservations` (default 2) reservations on connected relays and advertise `/p2p-circuit` addresses.
   - Two NAT-only nodes reach each other through a relay. A node reached only via a relay periodically tries a direct dial and upgrades if one works.
   - Hole punching (DCUtR) is not enabled.
6. **Bootstrap is not a leader.** Once peers know each other (directly, from hints, or from the cache), bootstrap nodes can disappear.
   - An isolated **new** node still needs at least one reachable known peer to join.
   - After a restart, a node with no reachable bootstrap relies on its cache. That works only if cached peers are reachable, i.e. a peer with a public or LAN address, or a relay.

**Listen vs advertised addresses.**
- `p2p.listen` is what the socket binds, e.g. `/ip4/0.0.0.0/tcp/4001`.
- `p2p.announce` is what peers are told to dial, e.g. `/ip4/203.0.113.7/tcp/4001` or `/dns4/node.example.org/tcp/4001`.

Docker-network names, `127.0.0.1`, and LAN addresses are **not** internet-routable. Set `announce` on public nodes, and `advertisePrivateAddrs: false` if you do not want LAN addresses shared.

## Routing (gateway)

Candidates are:

- the gateway itself, if it serves the **requested model**, that model is ready, and it is not draining
- directly connected authorised peers that are *available* (fresh status, under the failure threshold) and whose status record lists the requested model as ready in `modelLoad`

```
score = (that model's active + queued + requests this gateway already has outstanding there) / maxConcurrency
        + (remote ? 0.5 + rttMs/1000 : 0)
```

The lowest score wins, and ties break by peer ID. An idle local node therefore wins, a busy local node spills to an idle peer, and remote load (a status hint up to 5 s old) is corrected by what this gateway itself has in flight. Workers still enforce their own limits atomically.

Overrides:

- `mesh.target` in the body: `"local"` or a peer ID. Pinned; there is no failover.
- `X-Mesh-Prefer: <peerId>` header: try that worker first, with normal failover afterwards.

**Remote workers never forward.** The inference handler only executes locally, and it rejects a request whose `originPeerId` is not the connecting peer.

## Failure policy

| Timeout | Default | Meaning |
|---|---|---|
| `timeouts.connectMs` | 5 s | Dial + open stream + `accepted`/`rejected` reply |
| `worker.queueTimeoutMs` | 30 s | Maximum wait in a worker's queue |
| `timeouts.firstTokenMs` | 30 s | From slot start (or acceptance at the gateway, plus queue timeout) to the first token |
| `timeouts.streamIdleMs` | 20 s | Maximum silence between tokens |
| `timeouts.defaultDeadlineMs` / `maxDeadlineMs` | 120 s / 300 s | Total request budget; sent to workers as *remaining ms* (not a wall-clock time, to avoid clock skew) |

- **Before the first token:** a retryable failure gets an **alternate** worker, never the same one twice, with at most 3 attempts in total within the original deadline. Retryable failures are busy, draining, not ready, unreachable, connect/queue/first-token timeout, runtime error, worker lost, and protocol error.
- **After the first token:** the request ends with an `interrupted` error event, and the stream never gets `[DONE]`. The client keeps the partial text and offers *Retry as a new answer*. Nothing from another worker is appended.
- **Duplicates:** each worker keeps a bounded (2048 entries), expiring (10 min) cache of `(origin, requestId)` and rejects repeats. A gateway can still time out on worker A and move to B while A is briefly still running (it has been sent a cancel). **Exactly-once execution is not provided.**
- **Cancellation:**
  - Client disconnect or Stop aborts the gateway request. A remote attempt then sends a `cancel` frame and closes the stream; the worker treats close/reset as cancel too.
  - The worker aborts its HTTP stream to llama-server, which stops generating.
  - Queued jobs are removed from the queue.
- **Bounds:** 1 running + 8 queued per worker; 16 in-flight requests per gateway; frames ≤ 256 KiB; request bodies ≤ 256 KiB; ≤ 64 messages; ≤ 32 hints of ≤ 8 addresses; ≤ 64 connections. A full queue answers `429 busy` with `Retry-After`.
- **Graceful shutdown (SIGTERM):**
  1. Stop admitting work and advertise `draining`.
  2. Wait up to `shutdown.graceMs` (15 s) for active jobs.
  3. Cancel the rest with an explicit error.
  4. Save the peer cache, then stop libp2p and the runtime. Identity is never regenerated.
- **Runtime crash:** the llama.cpp child is restarted with backoff, at most 5 times per 10 minutes. On Linux it is spawned with a parent-death signal, so a killed node never leaves an orphaned runtime.

## Failures tolerated

"Tolerated" means requests keep working without operator action. Each case below was exercised by an automated test or the demo; see [testing.md](testing.md).

| Failure | Behaviour |
|---|---|
| Worker process killed or frozen before output | Gateway fails over to another worker (≤ 2 retries) |
| Worker killed during output | Answer marked interrupted; partial text kept; user retries |
| Gateway killed during output | Client sees a stream without `[DONE]` and marks it interrupted |
| Gateway unreachable before output | Client tries the next configured gateway (≤ 3) |
| One or both bootstrap nodes stopped, after peers met | Surviving peers keep routing to each other |
| One of two relays lost | NAT-only peers continue through the other relay; the reservation is restored when it returns |
| Node restart | Same identity; reconnects from its peer cache |
| Worker saturated | Predictable `429 busy`, or the gateway spills to a less-loaded peer |
| Model-download services unreachable | No effect after installation (verified on an internet-less Docker network) |

**Not tolerated or not claimed:**

- a brand-new node with no reachable known peer
- all relays down for two NAT-only nodes
- network partitions: each side keeps serving, but only for its own members; there is no global state to reconcile
- an operator removing you from their authorised list
- hostile or Sybil participants
- DDoS
- geographic or provider-level failure domains (a Compose cluster on one host only tests separate processes)
- **exactly-once** execution

The network can be shut down: by all operators stopping their nodes, by blocking TCP between them, or by losing every reachable public relay/bootstrap for NAT-only members.
