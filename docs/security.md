# Security assumptions and limits

v0.1 is for a **small group of operators who know and approve each other**. It is not a public, permissionless network, and it is not safe against hostile participants.

## What is protected

- **Peer transport:**
  - Noise-encrypted and mutually authenticated. A connection's peer ID is bound to the remote key.
  - The connection gater refuses unapproved peers before any application data, and the protocol handlers re-check them.
  - Relays only serve approved peers.
- **Admission:**
  - Each node's own `authorized-peers.json`.
  - Discovery (bootstrap, hints, cache) never grants admission.
  - The network ID is a label, not a password.
- **Remote capabilities:** peers can only exchange status and submit bounded inference jobs for the exact model fingerprint. They cannot run commands, read or write files, install models, change settings, fetch URLs, or make a worker forward jobs.
- **Runtime isolation:**
  - llama.cpp listens on loopback with a random per-start API key (native), or on an internal Docker network with no published port and no internet route.
  - The web UI, tools, `/props` changes and slot saving are disabled.
  - Containers run as non-root with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, CPU/memory limits, and no Docker socket.
- **Secrets:**
  - The private key and tokens are files with mode 600, never logged, and never in join files, the UI build, or `.env`.
  - Logs redact authorization headers, prompts and outputs by default.
  - Client and admin tokens are separate from peer membership.
- **Input bounds:** frame, body, message, token-budget, queue, connection and hint limits are listed in [architecture.md](architecture.md#failure-policy). Malformed input is dropped without execution; this is covered by tests.
- **Model integrity:** SHA-256 is checked against the pinned manifest before every load. The model is never downloaded from peers.

## What is NOT protected

- **Operators see prompts.** Both the gateway and the worker handle plaintext prompts and answers. Transport encryption hides them from the network, not from the operators of those nodes. Do not send anything you would not show them.
- **Malicious approved peers** can return wrong or harmful text, lie in status records (which affects routing only), waste your gateway's retries, or read the prompts routed to them. Answers are not verified or scored.
- **Sybil / permissionless membership** is not implemented. Approving a peer is a trust decision.
- **DDoS:** quotas, bounded queues and connection limits keep a node stable under load, but they are not DDoS protection. Put public gateways behind a proxy with rate limiting.
- **Plain HTTP** is fine on localhost only. Serve remote users over HTTPS (see [operations.md](operations.md#6-https-for-remote-users-unverified-example)).
- **Loopback trust:** native nodes grant admin to token-less loopback requests (Host and Origin checks block browser-based DNS-rebinding and cross-site use). Anyone with a shell on the machine is trusted. Set `http.trustLoopback: false` on shared machines or behind a local reverse proxy.
- The **model itself** is tiny and unreliable: expect confident, wrong answers.

## Reporting

Please report vulnerabilities privately to the maintainers before public disclosure. llama.cpp's own policy is at https://github.com/ggml-org/llama.cpp/blob/master/SECURITY.md. It advises against exposing llama-server to untrusted networks, which is why it is never exposed here.
