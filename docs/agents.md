# Web research

Your node can search the web and read pages before the model answers, then cite what it read. This is the first agent tool; the design and its safety rules are in [agents-design.md](agents-design.md).

## Setup (once)

Searches go through **SearXNG**, a free search engine that runs on your own computer and asks Google, Bing, DuckDuckGo and others for you. It needs Docker.

```bash
./mesh search start                 # runs SearXNG in Docker on 127.0.0.1:8888 (only this computer can reach it)
./mesh search test "wolf packs"     # check the results
./mesh search status | stop
```

- The image is pinned by digest in `deploy/searxng/image.json`, and its settings are in `deploy/searxng/settings.yml`.
- The container restarts with Docker, runs without extra capabilities, and is limited to 512 MB.
- The node reads its address from `agent.web.searxUrl` (default `http://127.0.0.1:8888`).

## Using it

- In the chat, press **Web** next to the message box. While it is on, every question is searched first.
- With it off, the node still searches when you ask for it: "search the web for …", "look up …", "latest news about …", or a message with a link, which is read directly.
- You see each step as it happens: searching, the pages read and any that failed, then writing the answer. Afterwards the steps fold into one line, the answer's `[1]`, `[2]` link to their sources, and the sources are listed under the answer.

From the API: `"mesh": {"web": "on" | "auto"}` on `POST /v1/chat/completions` (see [api.md](api.md#web-research)).

## What happens

1. **Query.** A first question is searched as you wrote it, without request phrases like "please search the web for". A follow-up ("and in winter?") is rewritten into a query by the model. That query is checked, and your question is used instead if the query looks wrong.
2. **Search.** SearXNG returns up to 8 results. Results that point into private networks are dropped.
3. **Read.** Up to 4 results are fetched in parallel, and the first 2 that work are kept. PDFs and other documents are not read; their search summaries are used instead.
4. **Select.** The main text of each page is extracted, and the passages most relevant to the question (BM25) are kept, up to about 8,000 characters in total.
5. **Answer.** The model gets the passages and up to 3 more search summaries, marked as untrusted, and is told to cite them.

## Safety

- **The model never chooses a URL.** Pages come only from search results or from your own message. A web page (or a peer's model) that tries to make your node visit `https://attacker.example/?data=…` gets nowhere: the node never opens a URL that appears only in model output.
- **SSRF protection**, so reading a page cannot reach your own network:
  - only `http`/`https`, on ports 80/443, without credentials in the URL
  - the host is resolved once, every address must be public, and the connection goes to that exact address
  - loopback, private, link-local (including cloud metadata `169.254.169.254`), CGNAT, multicast, reserved and IPv4-mapped IPv6 addresses are refused; odd spellings like `http://2130706433/` are parsed, not string-matched
  - at most 3 redirects, each checked again
  - 2 MB (after decompression) and 10 s per page; no cookies, no credentials
- **Operator only by default.** Searches leave from your computer's internet connection, so someone using your node with a client token cannot trigger them (`agent.web.allowClients: false`).
- **Privacy:** your search queries go to SearXNG and on to the search engines it uses, from your IP address, and the pages you read see a request from your IP. The model that writes the answer may run on another node in your pack, which then sees the question and the page excerpts, as with any chat message.
- **Pages can be wrong or hostile.** The model is told to treat them as information only, but a small model can still be misled. Check the sources.

## Speed

Web answers send the model a long prompt: about 2,000–3,000 tokens of page text.

- On a **GPU** node the model reads it in a few seconds.
- On a **CPU** it takes minutes: Qwen3 4B read 2,319 tokens in 104 s on a Ryzen 7 3700X.

The mesh allows for this: the time allowed before the first word grows with the prompt length (at least 12.5 tokens/s is assumed), and web answers get the longest deadline, 5 minutes. The speed-aware router already prefers GPU nodes.

## Settings (`node.json` → `agent.web`)

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Allow web research on this node |
| `searxUrl` | `http://127.0.0.1:8888` | Your SearXNG |
| `allowClients` | `false` | Let client-token users search from your connection |
| `maxPages` | `2` | Pages read per answer (0–4) |
| `maxPageBytes` | 2 MB | Size limit per page |
| `fetchTimeoutMs` | 10000 | Time limit per page |

## Not built yet

- Free tool choice by the model (it decides when to search and what to open). This fixed pipeline comes first, as the design says.
- The code tool (`run_python` with the write → test → fix loop).
- Per-domain approvals, and a "local model only" setting.
