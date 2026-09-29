# Roadmap

v0.1 proves the network layer: authenticated membership, discovery, routing, failover and relays around one small, fully replicated model. None of the items below exist yet.

## 1. Splitting large models across machines, with redundant copies

The goal is to serve models too big for any single community machine.

**Done (first step):** one node can split a model across memory lent by trusted peers, using llama.cpp's RPC backend behind the authenticated mesh transport ([split.md](split.md)). Still missing, from the list below: stages served by several workers each (redundancy), routing across chains, and replica recovery. Today, losing a lender interrupts the model until that lender returns.

- **Layer sharding.** A model's transformer blocks are split into contiguous ranges ("stages"). Each worker serves one or more stages, and a request flows through a *pipeline* of workers, passing activations between them. Petals (bigscience-workshop/petals) is the main reference design. llama.cpp's RPC backend is a possible building block, but it must never be exposed to untrusted networks, so it would sit behind the authenticated mesh transport.
- **Redundancy per stage.** Every stage is held by at least *k* workers, typically 2–3. A routing layer picks a chain of workers (one per stage) using measured latency and load, like today's router extended to paths.
- **Replica recovery.** When a stage loses holders, spare-capacity nodes fetch and load the missing stage's weights (see §5) until the replication target is met again. Mid-generation, losing a stage holder needs a KV-cache strategy: either re-run the prompt on a replacement chain (visible as a restart, consistent with today's "interrupted, retry" rule), or keep shadow caches on a second chain (more expensive).
- **Honest limits.** Pipelines add network round trips per token, so a WAN pipeline will be much slower per request than a local GPU. Throughput comes from many concurrent requests.

## 2. Runtime and model compatibility

- A manifest *family* per model: several quantisations and runtimes declared compatible, with fingerprints per artifact and a compatibility matrix instead of the single exact-match fingerprint used today.
- Versioned protocol negotiation, so mixed-version meshes can upgrade gradually. Peers would advertise `infer/1` and `infer/2`.
- Chat-template and tokenizer checks folded into the fingerprint for multi-model meshes.
- Verified ARM64 and macOS builds.

## 3. Faster GPU workers

- CUDA/ROCm/Vulkan llama.cpp images with pinned digests, and advertised capability classes (context, tokens/s measured locally by the gateway, never self-reported).
- Router weighting by measured throughput; separate queues per capability class.
- Larger context budgets on nodes that can afford them, validated by the worker, as today.

## 4. Admission and governance for independent operators

- **Signed membership records:**
  - An operator signs "I vouch for peer X".
  - Nodes accept peers vouched for by *n* operators they trust. This replaces hand-editing every list, but keeps it opt-in and local; there is still no central server.
- **Revocation lists** propagated by the same mechanism.
- **Per-operator policies:** which peers may use my compute, and rate limits per peer and per API token.
- **Public, permissionless membership and Sybil resistance** are research topics, not v0.x features. Any design must be explicit about who can deny service and who can read prompts.

## 5. Model distribution

- Peer-to-peer transfer of model files, content-addressed by the manifest's SHA-256 and verified before use. The source is irrelevant because the hash is pinned.
- Chunked transfer with resumption. Operators opt in to seeding, with bandwidth caps.
- Manifest signing by the mesh's maintainers, so new members can verify which model a mesh runs.

## 6. Optional contribution accounting

- Local, non-transferable counters of work served to and received from each peer, for fairness in routing ("serve those who serve").
- Explicitly **no** tokens, blockchain, staking or payments. Any shared accounting must survive operators lying about their own numbers, so it would rely on the counterpart's measurements.

## 7. Pack memory, next steps

Shipped in v0.1: anonymous notes, pull replication, merging, local reinforcement, retrieval. See [pack-memory.md](pack-memory.md). Next:

- Pack-wide (not only local) reinforcement that cannot be gamed or used to track people, e.g. aggregated with differential-privacy noise.
- Moderation that works despite anonymity: operator-signed "hide" recommendations that other operators may choose to follow.
- Better distillation of an answer into a how-to, once a larger model is available.
- Stronger origin hiding (mixing / cover traffic) for meshes that need it.

## 8. Smaller items

- DCUtR hole punching for direct home-to-home connections.
- Prometheus-format metrics export.
- Hot reload of TLS for a built-in HTTPS listener.
- Per-token-budget request quotas per client token.
- Answer quality checks are out of scope unless the operators explicitly want them.
