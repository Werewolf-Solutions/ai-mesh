# Agent tools

Your node can do two things for you before the model answers. Both are fixed pipelines: the node decides every action, and the model only writes text. The design and its safety rules are in [agents-design.md](agents-design.md).

- **[Web research](#web-research):** search the web, read pages, answer with sources.
- **[Tested Python code](#tested-python-code):** write the code and its tests, run them in an offline sandbox, and fix the code until the tests pass.

Both run only on the node you asked, and only for its operator unless the operator allows client tokens.

## Web research

Your node can search the web and read pages before the model answers, then cite what it read.

### Setup (once)

Searches go through **SearXNG**, a free search engine that runs on your own computer and asks Google, Bing, DuckDuckGo and others for you. It needs Docker.

```bash
./mesh search start                 # runs SearXNG in Docker on 127.0.0.1:8888 (only this computer can reach it)
./mesh search test "wolf packs"     # check the results
./mesh search status | stop
```

- The image is pinned by digest in `deploy/searxng/image.json`, and its settings are in `deploy/searxng/settings.yml`.
- The container restarts with Docker, runs without extra capabilities, and is limited to 512 MB.
- The node reads its address from `agent.web.searxUrl` (default `http://127.0.0.1:8888`).

### Using it

- In the chat, press **Web** next to the message box. While it is on, every question is searched first.
- With it off, the node still searches when you ask for it: "search the web for …", "look up …", "latest news about …", or a message with a link, which is read directly.
- You see each step as it happens: searching, the pages read and any that failed, then writing the answer. Afterwards the steps fold into one line, the answer's `[1]`, `[2]` link to their sources, and the sources are listed under the answer.

From the API: `"mesh": {"web": "on" | "auto"}` on `POST /v1/chat/completions` (see [api.md](api.md#web-research)).

### What happens

1. **Query.** A first question is searched as you wrote it, without request phrases like "please search the web for". A follow-up ("and in winter?") is rewritten into a query by the model. That query is checked, and your question is used instead if the query looks wrong.
2. **Search.** SearXNG returns up to 8 results. Results that point into private networks are dropped.
3. **Read.** Up to 4 results are fetched in parallel, and the first 2 that work are kept. PDFs and other documents are not read; their search summaries are used instead.
4. **Select.** The main text of each page is extracted, and the passages most relevant to the question (BM25) are kept, up to about 8,000 characters in total.
5. **Answer.** The model gets the passages and up to 3 more search summaries, marked as untrusted, and is told to cite them.

### Safety

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

### Speed

Web answers send the model a long prompt: about 2,000–3,000 tokens of page text.

- On a **GPU** node the model reads it in a few seconds.
- On a **CPU** it takes minutes: Qwen3 4B read 2,319 tokens in 104 s on a Ryzen 7 3700X.

The mesh allows for this: the time allowed before the first word grows with the prompt length (at least 12.5 tokens/s is assumed), and web answers get the longest deadline, 5 minutes. The speed-aware router already prefers GPU nodes.

### Settings (`node.json` → `agent.web`)

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Allow web research on this node |
| `searxUrl` | `http://127.0.0.1:8888` | Your SearXNG |
| `allowClients` | `false` | Let client-token users search from your connection |
| `maxPages` | `2` | Pages read per answer (0–4) |
| `maxPageBytes` | 2 MB | Size limit per page |
| `fetchTimeoutMs` | 10000 | Time limit per page |

## Tested Python code

The model writes Python, and your node runs it with tests in a sandbox before you see it. When the tests fail, the error goes back to the model to fix, up to 3 rounds.

### Setup (once)

The sandbox is a Docker container from a pinned `python:3.12-slim` image. It needs Docker.

```bash
./mesh code setup     # pulls the pinned image
./mesh code test      # checks the sandbox: runs Python, no network, no writes, runs as nobody, stops endless loops
./mesh code status
```

### Using it

- In the chat, press **Code** next to the message box. While it is on, every message is answered this way. Web and Code are not on at the same time.
- With it off, the node still does this when you ask for Python code: "write a Python function…", "fix this Python code".
- Include your own tests as a ```` ```python ```` block of `assert` lines, and they run every round, unchanged.
- You see each step: writing, running the tests, the failure, fixing. Under the answer the node adds one line that says whether the tests passed.

From the API: `"mesh": {"code": "on" | "auto"}` on `POST /v1/chat/completions` (see [api.md](api.md#tested-python-code)).

### What happens

1. **Write.** The model is asked for the solution in one code block, then tests as plain `assert` lines, then a short explanation. It uses the effort you chose, and gets at least 1,536 tokens for the reply.
2. **Test.** The node runs the solution, then the model's tests and your own tests **one by one**, so one failing test doesn't hide the others. For a failing `assert a == b` it records both values, and for an error, the solution line that raised it. After the tests the program prints a random marker. It passes only if it exits normally **and** printed the marker, so code that calls `sys.exit(0)` by mistake doesn't count as a pass. (This catches accidents, not hostile code, which could find the marker. Keeping your computer safe is the sandbox's job.)
3. **Fix.** On failure, the model gets each failing test with the value it got and the value expected, and is asked which side is wrong: the solution or its own test. Your tests must pass unchanged.
4. **Answer.** The best round's reply is the answer (a "fix" that makes things worse is not used), with the node's note: all tests passed, ran without tests, how many tests still fail and the first failure, or not tested (for example, no sandbox).

Later rounds go back to the same worker, which still holds the conversation in its cache, so they don't re-read the whole prompt.

### The sandbox

The model's code is untrusted, wherever the model runs: a peer's model, or a prompt that tricks an honest one, could write anything. The sandbox's limits are what keep your computer safe:

- **No network** (`--network none`): no internet, no LAN, no Docker host, no DNS.
- **Nothing from your computer:** the program arrives on stdin; no folder is mounted.
- **Read-only filesystem**, apart from a 16 MB `/tmp` where nothing can be executed.
- **Runs as `nobody`**, with every Linux capability dropped and no way to gain privileges.
- **Limits:** 10 s, 256 MB of memory (no swap), 1 CPU, 64 processes, 64 open files, 64 KB of output kept.
- **Never pulls:** the image is pinned by digest and runs with `--pull never`; only `./mesh code setup` downloads it.

Checked by `tests/integration/code.test.ts`: network, DNS and the metadata address blocked; writes and execution from `/tmp` refused; no host mounts; endless loop, fork bomb and a 512 MB allocation stopped; output flood capped; cancel.

What the sandbox does not protect against: a flaw in Docker or the Linux kernel that lets a program out of its container. Keep Docker updated.

### Settings (`node.json` → `agent.code`)

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Allow the code pipeline on this node |
| `allowClients` | `false` | Let client-token users run code in your sandbox |
| `image` | pinned `python:3.12-slim` | Sandbox image, by digest |
| `maxRounds` | `3` | Write + fix rounds (1–5) |
| `timeoutMs` | 10000 | Time limit per run |
| `memoryMb` | 256 | Memory limit per run |
| `cpus` | 1 | CPU limit per run |
| `maxTokens` | 1536 | Reply length per round |

### Limits

- Python only, standard library only (no `pip install`: there is no network).
- The model writes its own tests, and a small model's tests can be wrong or too easy. "All tests passed" means the code does what its tests check, not that it is right, and a wrong test can make correct code look broken. Adding your own tests is the best check.
- With Qwen3 8B on six benchmark tasks, testing did not make more answers correct; it made the broken ones visible. See [testing.md](testing.md#code-pipeline-executed-2026-09-29).
- No files, no `input()`, no GUI, no long-running programs.

## Not built yet

- Free tool choice by the model (it decides when to search, what to open, when to run code). The fixed pipelines come first, as the design says.
- Per-domain approvals, and a "local model only" setting.
