# Splitting a model across machines

A model too big for one computer can be split: some of its layers run on this computer, and the rest run in the memory of other computers in your pack. It uses llama.cpp's RPC backend, from the same pinned build (b11223). The mesh carries that traffic through its encrypted, operator-approved connections.

**This is distributed execution of one model.** It is different from the rest of the mesh, where every node runs a complete copy. A split model is served to the pack like any other model; only its host node needs the model file.

## When to use it

A split runs at about the speed of its slowest part, plus the network in between. Measured on one machine (Ryzen 7 3700X + RTX 3060), Qwen3 8B, two nodes talking through the mesh on loopback:

| Where the layers are | Tokens/s |
|---|---|
| All on the GPU (no split) | 55 |
| 80% GPU, 20% on the lender's CPU | 17 |
| 50 / 50 | 9 |
| 20% GPU, 80% lender CPU | 6.2 |
| All on a CPU (no split) | 6 |

So split a model only when it **does not fit** on any one of your computers. For example, a 14B or 30B-A3B model spread over a GPU node and a big-RAM node. By default the mesh does exactly that:

- this node's GPU (or RAM) is filled first, and the lenders get only what doesn't fit;
- if the model fits here, it isn't split at all.

Between real machines, the network adds a round trip per token. Use a fast LAN with a direct connection: the mesh refuses to split over relayed connections.

## Setting it up

On the computer that **lends** memory (B):

```bash
./mesh split lend on <peer ID of A>            # lend RAM; add --gpu to lend GPU memory (needs ./mesh gpu on)
./mesh split lend off                          # stop lending
```

or *Models → Lend this computer's memory*. B then runs `ggml-rpc-server` on its own loopback (127.0.0.1) and announces that it lends.

On the computer that **runs** the model (A), which needs the model file (`./mesh models install ID`):

```bash
./mesh split status                            # which peers lend, and to whom
./mesh split model qwen3-8b-q4_k_m <peer ID of B>        # automatic: fill A first
./mesh split model qwen3-8b-q4_k_m <B> --local-share 0.6 # or keep 60% on A
./mesh split model qwen3-8b-q4_k_m --off                 # run it on A only
```

or *Models → the model → Split across other computers…*. The model restarts, and its status line shows the placement, e.g. "split: 18 of 36 layers here, 18 on 1 other node". Answers in progress on that model are interrupted by the restart.

## What happens when a lender goes away

- llama.cpp stops with "Remote RPC server crashed" as soon as a lender disappears. An answer in progress ends as **interrupted**, never as a silently shortened answer.
- The model restarts with the lenders still reachable. If none are, it waits ("waiting for them") instead of trying to load everything locally.
- When a lender comes back, or is newly allowed, the model is split again automatically: on the lender's identify message, or within 30 s.

## Security: lend only to computers you trust fully

llama.cpp's RPC protocol has **no security of its own**. Whoever connects can make the lender allocate memory and run tensor operations, and bugs in that code could let a malicious client take over the lender. The mesh limits who can connect:

- `ggml-rpc-server` listens on 127.0.0.1 only; nothing on the network can reach it directly;
- tunnels (`/werewolf-mesh/rpc/1.0.0`) are accepted only from **approved peers the lender's operator listed for lending**, over direct (not relayed) connections; everyone else is refused and counted;
- lending is off by default; the protocol is only announced while lending is on.

That keeps strangers out. It does **not** protect a lender from a peer on its list. Treat "lend to X" like giving X a login on that computer. Also, anything running on the lender itself can reach its loopback RPC port, just as local programs can reach the node's own API.

What the lender sees: the model's weights (they are sent to it) and the intermediate numbers of the layers it runs, not the prompt text directly. A determined lender could still infer something about the prompts from those numbers. Prompts are only as private as the peers you split with.

## Limits

- Tested on one machine: two node processes, llama.cpp CPU and CUDA builds. **Not yet tested between two physical machines.**
- The tensor cache on the lender (`-c`, in `<data>/rpc-cache`) makes reloading faster but uses disk.
- A lender's memory is not reserved: if it runs its own models too, both compete for its RAM or VRAM.
- At most 8 lenders per model. The layers placed on lenders are spread evenly between them.
