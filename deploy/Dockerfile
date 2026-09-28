# Werewolf AI Mesh node image (gateway + worker control plane).
# Inference runs in a SEPARATE pinned llama.cpp container; see deploy/compose.yaml.
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

FROM ${NODE_IMAGE}
ENV NODE_ENV=production MESH_DATA_DIR=/data MESH_MODEL_DIR=/models
WORKDIR /app
COPY --from=build /out /app/apps/node
COPY --from=build /src/apps/web/dist /app/apps/web/dist
COPY models/manifest.json /app/models/manifest.json
COPY LICENSE NOTICE /app/
# Runs as the unprivileged "node" user by default; compose files override the
# UID/GID to match the owner of the mounted data directory.
USER node
EXPOSE 8080 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/apps/node/dist/cli.js"]
CMD ["start", "--data", "/data"]
