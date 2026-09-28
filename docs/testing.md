# Testing: what ran and what did not

Environment: Ubuntu 24.04 x86-64, Ryzen 7 3700X, 16 GB RAM, Docker 29.8.1 / Compose 5.5.1, Node.js 22.17.0, pnpm 10.34.5. Last full run: 2026-09-28.

## Test tiers

| Command | Runtime | Result |
|---|---|---|
| `pnpm test:unit` | none | **16/16 passed** |
| `pnpm test:integration` | **FAKE deterministic adapter**, real separate OS processes, real libp2p | **40/40 passed**, two consecutive runs |
| `pnpm test:real` | **real llama.cpp b11223 + verified model** | **8/8 passed** (the one "skipped" entry is the placeholder that only runs when the model is missing) |

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
- **Tests page** (Chrome, real 3-node cluster): showing and hiding the text, choosing a node, a live timer, the result (1,408 tokens read by node1 in 3.81 s), run history, and the rendered `docs/benchmarks.md` view.

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
