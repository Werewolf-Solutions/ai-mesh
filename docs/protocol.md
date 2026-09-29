# Peer protocol (version 1)

The schemas are the source of truth: `packages/protocol/src/peer.ts`.

## Transport

- **libp2p 3.3** over TCP. Noise XX encryption authenticates each side's Ed25519 key, so the remote peer ID is cryptographically bound to the connection.
- Yamux stream multiplexing.
- identify and identify-push (address changes, e.g. new relay reservations).
- ping.
- circuit relay v2: client on all nodes, server only where `p2p.relayServer` is set.

**Admission (connection gater).** Inbound and outbound encrypted connections, dials, relay reservations and relayed circuits are all denied unless every peer involved is in the local `authorized-peers.json`. Each protocol handler checks again (defence in depth). The network ID is compared in status records, but it is **not** an authentication mechanism.

## Framing

Every message is one frame:

```
unsigned-varint length || UTF-8 JSON object
```

- Frames larger than **256 KiB** are refused as soon as the length prefix is read.
- Invalid UTF-8, invalid JSON, `v != 1`, unknown `type`, unknown fields, or any schema violation close the stream without executing anything.
- TCP segment boundaries are irrelevant; the length-prefixed decoder reassembles frames. This is tested with 7-byte writes.

Every frame has `"v": 1` and `"type"`.

## `/werewolf-mesh/status/1.0.0`

The dialer writes one `status` frame, the responder replies with one `status` frame, and the stream closes. Both directions carry:

```jsonc
{
  "v": 1, "type": "status",
  "status": {
    "peerId": "12D3Koo…",          // MUST equal the authenticated remote peer, else rejected
    "networkId": "my-mesh",         // MUST equal ours
    "protocolVersion": 2, "softwareVersion": "0.2.0",   // v0.2 also sends modelLoad: [{model, ready, active, queued, maxConcurrency, maxQueue}]
    "state": "ready" | "starting" | "not_ready" | "draining",
    "inferenceReady": true,
    "models": ["smollm2-135m-instruct-q4_k_m:sha256:2e80…"],   // ≤ 4
    "activeJobs": 0, "queueLength": 0, "maxConcurrency": 1, "maxQueue": 8,
    "addrs": ["/ip4/…/tcp/4001/p2p/…", "…/p2p-circuit/p2p/…"], // sender's own, ≤ 8
    "sentAt": 1790000000000          // informational; freshness uses the receiver's clock
  },
  "hints": [ { "peerId": "12D3Koo…", "addrs": ["…"] } ]           // ≤ 32 peers × ≤ 8 addrs
}
```

- Status is authoritative **only** for the sender itself.
- Hints are dial candidates and are used only for peers the receiver has authorised.
- Probe timeout is 4 s. Three consecutive failures mark the peer unavailable.

## `/werewolf-mesh/infer/1.0.0`

```
gateway                                   worker
  infer ───────────────────────────────▶
        ◀──────────────── accepted | rejected
        ◀──────────────── token (seq 0,1,2,…)*
  cancel ──────────────────────────────▶ (optional, any time)
        ◀──────── completed | failed | cancelled
```

**`infer` request:**

| Field | Type / limit |
|---|---|
| `requestId`, `attemptId` | `[A-Za-z0-9._:-]{1,128}` |
| `originPeerId` | must equal the connecting peer; workers never forward |
| `model` | exact fingerprint `<id>:sha256:<file hash>`; mismatch → `rejected{code:"model_mismatch"}` |
| `messages` | 1–64 of `{role: system\|user\|assistant, content ≤ 32 000 chars}` |
| `settings` | `{maxTokens 1–256, temperature?, topP?, seed?, stop? (≤4), presencePenalty?, frequencyPenalty?}` |
| `deadlineMs` | 100 ms – 15 min remaining budget, relative to receipt |

**Replies:**

- **`accepted`**: `{requestId, attemptId, workerPeerId, queuePosition, promptTokens}`. It is sent only after admission (atomic slot or queue reservation), the dedup check, and a token-budget check using the runtime's own chat template and tokenizer (prompt + max tokens ≤ 2048).
- **`rejected`**: `{code, message, retryAfterMs?}`. The codes are:
  - `busy`, `draining`, `not_ready`, `duplicate`
  - `context_exceeded`, `model_mismatch`, `forbidden`
  - `runtime_error`, `internal`
- **`token`**: `{seq, text}`. `seq` must be contiguous from 0; a gap is a protocol error.
- **`completed`**: `{finishReason: stop|length, usage{promptTokens, completionTokens}, timings?}`.
- **`failed`**: `{code, message}`.
- **`cancelled`**: `{}`.

The gateway keeps its write side open for the whole job. A worker that sees EOF or reset treats it as cancellation and stops generating.

## `/werewolf-mesh/rpc/1.0.0` (splitting a model)

A raw byte tunnel for llama.cpp's RPC backend ([split.md](split.md)); not framed JSON.

- Registered only while the node lends memory. Peers learn it from identify, which is how a borrower knows who lends.
- Accepted only from approved peers on the lender's list, over direct connections (`runOnLimitedConnection: false`); anything else is reset.
- An accepted tunnel starts with one byte `0x57` from the lender, then carries bytes both ways between the borrower's llama-server and the lender's `ggml-rpc-server` on 127.0.0.1. The borrower checks that byte, so it can report "does not lend to this node" before starting llama-server.
- Each TCP connection llama-server opens becomes one stream. At most 32 inbound streams per connection.

## `/werewolf-mesh/receipt/1.0.0` (WLF receipts)

One framed JSON message per stream (frame version 1): `{"v":1,"type":"receipt","signed":{"receipt":{…},"sig":"…"}}`, sent by the requester's node to the worker after a remote answer completes. The worker checks that the sender is the receipt's requester, that it is the receipt's worker, that it recently ran that exact job for that peer (same `requestId/attemptId`, model, and token counts within ±2), the Ed25519 signature over `werewolf-mesh/wlf/receipt/v1\n<canonical JSON>`, and that it's new. Otherwise it resets the stream. See [rewards.md](rewards.md).

## Versioning

Protocol IDs carry a semantic version. An incompatible change gets a new ID (e.g. `/werewolf-mesh/infer/2.0.0`), and nodes may serve both during a transition. A frame with `v` other than 1 is rejected.
