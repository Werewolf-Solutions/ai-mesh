# Werewolf AI Mesh node image.
#
# Contains the node (gateway, worker control, peer networking, UI) and the
# pinned llama.cpp server binary. The node starts one llama.cpp process per
# hosted model, bound to 127.0.0.1 inside the container with a per-start API
# key; no runtime port is ever published. Models live in a mounted volume and
# are verified by SHA-256 before every load.
ARG NODE_IMAGE=node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0

FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@10.34.5
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/node/package.json apps/node/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && pnpm --filter @werewolf-mesh/node deploy --prod --legacy /out

# Pinned llama.cpp build (models/runtime.json), verified by SHA-256.
FROM ${NODE_IMAGE} AS runtime
ARG TARGETARCH
COPY models/runtime.json /tmp/runtime.json
RUN set -eu; \
    key="linux-x64"; [ "${TARGETARCH:-amd64}" = "arm64" ] && key="linux-arm64"; \
    url=$(node -e "const r=require('/tmp/runtime.json');console.log(r.binaries['$key'].url)"); \
    sha=$(node -e "const r=require('/tmp/runtime.json');console.log(r.binaries['$key'].sha256)"); \
    dir=$(node -e "const r=require('/tmp/runtime.json');console.log(r.binaries['$key'].dir)"); \
    node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('/tmp/llama.tgz',Buffer.from(b)))" "$url"; \
    echo "$sha  /tmp/llama.tgz" | sha256sum -c -; \
    mkdir -p /opt && tar xzf /tmp/llama.tgz -C /opt && mv "/opt/$dir" /opt/llama && rm /tmp/llama.tgz

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production MESH_DATA_DIR=/data MESH_MODEL_DIR=/models MESH_RUNTIME_BINARY=/opt/llama/llama-server
WORKDIR /app
COPY --from=runtime /opt/llama /opt/llama
COPY --from=build /out /app/apps/node
COPY --from=build /src/apps/web/dist /app/apps/web/dist
COPY models/runtime.json models/scorer-manifest.json /app/models/
COPY models/catalog /app/models/catalog
COPY LICENSE NOTICE /app/
# Runs as the unprivileged "node" user by default; compose files override the
# UID/GID to match the owner of the mounted data and model directories.
USER node
EXPOSE 8080 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/apps/node/dist/cli.js"]
CMD ["start", "--data", "/data"]
