# Model provenance

Everything below is recorded in `models/manifest.json`. Nodes load a model only after its SHA-256 matches the manifest.

| | |
|---|---|
| Model | SmolLM2-135M-Instruct by Hugging Face (HuggingFaceTB) |
| Licence | Apache-2.0 (from the official model card); attribution kept in NOTICE |
| Official repository | https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct. Revision observed when pinned: `12fd25f77366fa6b3b4b768ec3050bf629380bac` |
| GGUF conversion used | `bartowski/SmolLM2-135M-Instruct-GGUF` at immutable revision `09816acd5d99df7be770d85ea30822623dab342c`, file `SmolLM2-135M-Instruct-Q4_K_M.gguf` |
| Conversion provenance | Per that model card: llama.cpp release b3991, imatrix quantisation, base_model = the official repository, licence apache-2.0. The converter did not record which upstream revision it used. |
| Size / SHA-256 | 105 454 432 bytes / `2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d` (equal to the Hugging Face LFS object ID; independently recomputed after download) |
| Quantisation | Q4_K_M |
| Chat template | ChatML (`<\|im_start\|>…<\|im_end\|>`), embedded in the GGUF, rendered by llama.cpp's Jinja engine. Default system prompt: "You are a helpful AI assistant named SmolLM, trained by Hugging Face". |
| Model identifier on the mesh | `smollm2-135m-instruct-q4_k_m` |
| Fingerprint on the wire | `smollm2-135m-instruct-q4_k_m:sha256:2e8040ce…c68c2d` |
| Runtime compatibility | llama.cpp b11223 (commit `4da633776`): image `ghcr.io/ggml-org/llama.cpp:server-b11223@sha256:8fdfad18…`; linux-x64 binary SHA-256 `9ce07ebd…`. The node checks `build_info` = `b11223-4da633776` at startup. |
| Serving limits | 2 048-token context (prompt + completion, validated with the runtime's own tokenizer), ≤ 256 output tokens |

## Optional scoring model

The Tests page scores summaries with **bge-small-en-v1.5** by BAAI (MIT licence). It uses the GGUF published by ggml-org at revision `f2068edd9b54f2a369549ccc71f70ed273a2a801`: file `bge-small-en-v1.5-q8_0.gguf`, 36 685 152 bytes, SHA-256 `f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804` (the Hugging Face LFS ID, recomputed after download). Everything is recorded in `models/scorer-manifest.json`.

- Install it with `./mesh model download --scorer`, or `import`/`verify` it the same way. A node starts the scorer only if the file matches.
- It runs as a separate llama.cpp process in embedding mode (`--pooling cls`), on loopback only.
- It is never used to answer requests. It does not change the mesh model fingerprint and is not required.
- In the Docker image there is no local llama.cpp binary, so the scorer reports "not installed" and the UI shows word overlap only.

## Getting the model

```bash
./mesh model download        # from the pinned URL; verified before the final rename
./mesh model import ~/Downloads/SmolLM2-135M-Instruct-Q4_K_M.gguf   # no network; rejected if the hash differs
./mesh model verify
```

The file is stored once in `./models` (or `$MESH_MODEL_DIR`) and mounted read-only into containers. It is never downloaded on restart, and never from peers. To copy it to another machine, see [operations.md §2](operations.md#2-build-model-runtime).

## Converting from the official weights yourself

These commands were **not executed** during development. They reproduce the *process*, not the *bytes*. imatrix and quantisation output differ between llama.cpp versions, so your SHA-256 will not match the pinned file, and your nodes will have a different fingerprint from nodes using the pinned file.

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && git checkout b11223
pip install -r requirements.txt
huggingface-cli download HuggingFaceTB/SmolLM2-135M-Instruct --revision 12fd25f77366fa6b3b4b768ec3050bf629380bac --local-dir smollm2
python convert_hf_to_gguf.py smollm2 --outtype f16 --outfile smollm2-f16.gguf
cmake -B build && cmake --build build -j --target llama-quantize
./build/bin/llama-quantize smollm2-f16.gguf SmolLM2-135M-Instruct-Q4_K_M.gguf Q4_K_M
sha256sum SmolLM2-135M-Instruct-Q4_K_M.gguf
```

To serve a self-converted file, publish a new manifest:

1. Give it a new `id`, `sha256`, `sizeBytes` and `url`/provenance.
2. Point `model.manifest` at it on **every** node of that mesh.

Nodes with different fingerprints never exchange jobs.
