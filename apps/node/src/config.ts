/**
 * Node configuration (non-secret). Stored as <dataDir>/node.json, mode 0600.
 * Secrets (identity key, API tokens) live in separate files; see identity.ts
 * and secrets.ts.
 */
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteJson, readJsonIfExists } from './util/fs.js';
import { REPO_ROOT } from './version.js';

const ms = (def: number, min = 1) => z.number().int().min(min).max(3_600_000).default(def);

/** python:3.12-slim (3.12.14, 2026-09-19), multi-arch index digest. The code pipeline's sandbox (agent/sandbox.ts). */
export const PYTHON_SANDBOX_IMAGE = 'python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f';

export const NodeConfigSchema = z.strictObject({
  configVersion: z.literal(1).default(1),
  /** Shared by all members; NOT an authentication mechanism. */
  networkId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  label: z.string().max(64).default('node'),
  p2p: z
    .strictObject({
      /** Local socket addresses to bind. */
      listen: z.array(z.string()).max(16).default(['/ip4/0.0.0.0/tcp/4001']),
      /** Addresses other peers should dial. Empty = let libp2p derive them from listen addresses. */
      announce: z.array(z.string()).max(16).default([]),
      /** Introduction points (multiaddrs ending in /p2p/<peerId>). The peer ID must be authorised. */
      bootstrap: z.array(z.string()).max(16).default([]),
      /** Offer circuit-relay v2 service to authorised peers (public nodes only). */
      relayServer: z.boolean().default(false),
      /** Reserve slots on authorised relay nodes so peers can reach us through them (home nodes behind NAT). */
      useRelays: z.boolean().default(true),
      /** How many relay reservations to hold when useRelays is on. */
      relayReservations: z.number().int().min(0).max(4).default(2),
      /** Keep private/LAN/loopback addresses out of what we advertise to peers. */
      advertisePrivateAddrs: z.boolean().default(true),
      /**
       * The WebSocket listener sits behind a reverse proxy (e.g. nginx on 443): WebSocket peers
       * arriving from loopback are remote users, not this machine (docs/operations.md).
       */
      websocketBehindProxy: z.boolean().default(false),
      maxConnections: z.number().int().min(4).max(1024).default(64),
      maxInboundStreamsPerProtocol: z.number().int().min(1).max(256).default(32),
    })
    .prefault({}),
  http: z
    .strictObject({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(0).max(65535).default(8080),
      /** Extra browser origins allowed to call this API (exact match, e.g. https://chat.example.org). */
      allowedOrigins: z.array(z.string().url()).max(32).default([]),
      /** Extra Host header values accepted (DNS-rebinding protection). */
      allowedHosts: z.array(z.string()).max(32).default([]),
      /** Allow unauthenticated client/admin access from loopback sockets. Disable behind a reverse proxy or in containers. */
      trustLoopback: z.boolean().default(true),
      maxInFlight: z.number().int().min(1).max(1024).default(16),
      maxBodyBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
      serveUi: z.boolean().default(true),
    })
    .prefault({}),
  runtime: z
    .strictObject({
      kind: z.enum(['llama.cpp', 'fake']).default('llama.cpp'),
      /** spawn: start llama-server as a child process on loopback. external: connect to a runtime on a private network. */
      mode: z.enum(['spawn', 'external']).default('spawn'),
      binary: z.string().default(join(REPO_ROOT, '.cache/runtime/llama-b11223/llama-server')),
      url: z.string().url().optional(),
      /** File containing the runtime API key (external mode). Spawn mode generates its own. */
      apiKeyFile: z.string().optional(),
      threads: z.number().int().min(1).max(256).default(2),
      batchThreads: z.number().int().min(1).max(256).default(2),
      contextTokens: z.number().int().min(256).max(32768).default(2048),
      mlock: z.boolean().default(false),
      mmap: z.boolean().default(true),
      startupTimeoutMs: ms(120_000),
      /**
       * GPU acceleration: 'none' (CPU), 'cuda' (NVIDIA) or 'vulkan' (any vendor). The operator can
       * change it from the UI/CLI (saved in models-state.json). Uses the pinned GPU build of llama.cpp.
       */
      gpu: z.enum(['none', 'cuda', 'vulkan']).default('none'),
      /** Model layers to put on the GPU (99 = all). Lower it to fit bigger models in less VRAM. */
      gpuLayers: z.number().int().min(0).max(999).default(99),
      /** Fake runtime only: per-token delay. */
      fakeTokenDelayMs: z.number().int().min(0).max(10_000).default(20),
      /** Fake runtime only: the fake model IDs this node hosts (IDs ending in "-think" support thinking). */
      fakeModels: z.array(z.string().regex(/^[a-z0-9._-]+$/)).max(8).default(['fake-test-model']),
    })
    .prefault({}),
  model: z
    .strictObject({
      /** Where model files live (shared between nodes on one machine is fine). */
      dir: z.string().default(join(REPO_ROOT, 'models')),
      /** The vetted model catalog: one pinned manifest per model. */
      catalog: z.string().default(join(REPO_ROOT, 'models/catalog')),
      /** The pinned llama.cpp build all catalog models are tested with. */
      runtimePin: z.string().default(join(REPO_ROOT, 'models/runtime.json')),
      /** Catalog IDs this node hosts at start (until changed from the UI/CLI, see models-state.json). */
      host: z.array(z.string().regex(/^[a-z0-9._-]+$/)).max(16).default(['smollm2-135m-instruct-q4_k_m']),
      /** Allow the node's operator (admin token / loopback) to download and host catalog models from the UI. */
      allowInstall: z.boolean().default(true),
      /** @deprecated v0.1 single-model manifest path; ignored. */
      manifest: z.string().optional(),
    })
    .prefault({}),
  worker: z
    .strictObject({
      maxConcurrency: z.number().int().min(1).max(64).default(1),
      maxQueue: z.number().int().min(0).max(256).default(8),
      queueTimeoutMs: ms(30_000),
      dedupTtlMs: ms(10 * 60_000),
      dedupMaxEntries: z.number().int().min(16).max(100_000).default(2048),
    })
    .prefault({}),
  timeouts: z
    .strictObject({
      /** Dial + stream open + accepted/rejected reply. */
      connectMs: ms(5_000),
      /** After a worker accepts: time until the first token (on top of worker queue wait). */
      firstTokenMs: ms(30_000),
      /** Maximum silence between tokens once streaming. */
      streamIdleMs: ms(20_000),
      /** Default total deadline for a request. */
      defaultDeadlineMs: ms(120_000),
      maxDeadlineMs: ms(300_000),
    })
    .prefault({}),
  discovery: z
    .strictObject({
      probeIntervalMs: ms(5_000, 10),
      probeTimeoutMs: ms(4_000, 10),
      failuresBeforeUnavailable: z.number().int().min(1).max(100).default(3),
      /** A status record older than this (receiver clock) is ignored. */
      statusTtlMs: ms(20_000, 10),
      reconnectBaseMs: ms(1_000, 10),
      reconnectMaxMs: ms(60_000, 10),
      maxCachedPeers: z.number().int().min(0).max(1024).default(64),
      /** Cached peer addresses older than this are dropped (default 7 days). */
      cacheMaxAgeMs: z.number().int().min(0).max(90 * 24 * 3_600_000).default(7 * 24 * 3_600_000),
      /** Re-read authorized-peers.json when it changes (poll interval). */
      admissionReloadMs: ms(5_000, 100),
    })
    .prefault({}),
  routing: z
    .strictObject({
      /** Total attempts per request: 1 original + at most 2 alternate-worker retries. */
      maxAttempts: z.number().int().min(1).max(3).default(3),
      /** Added to remote candidates' score so an idle local node wins ties. */
      remotePenalty: z.number().min(0).max(100).default(0.5),
    })
    .prefault({}),
  shutdown: z.strictObject({ graceMs: ms(15_000, 0) }).prefault({}),
  /**
   * Optional summary scorer for the UI's reading test: a small embedding model
   * run by llama.cpp on loopback. Starts only if its model file is installed.
   */
  scorer: z
    .strictObject({
      enabled: z.boolean().default(true),
      manifest: z.string().default(join(REPO_ROOT, 'models/scorer-manifest.json')),
      threads: z.number().int().min(1).max(64).default(1),
    })
    .prefault({}),
  /**
   * Pack memory: anonymous shared problem → solution notes, replicated to every
   * node by pull-based sync. Retrieval needs the scorer's embedding model.
   */
  pack: z
    .strictObject({
      enabled: z.boolean().default(true),
      syncIntervalMs: ms(30_000, 50),
      /** A note created here becomes pullable after a random delay in this range (hides which node published it). */
      publishDelayMinMs: z.number().int().min(0).max(3_600_000).default(30_000),
      publishDelayMaxMs: z.number().int().min(0).max(3_600_000).default(300_000),
      /** Cosine similarity at or above which two notes count as the same problem. */
      groupSimilarity: z.number().min(0).max(1).default(0.9),
      retrieval: z
        .strictObject({
          enabled: z.boolean().default(true),
          maxNotes: z.number().int().min(0).max(5).default(2),
          minSimilarity: z.number().min(0).max(1).default(0.72),
          maxNoteChars: z.number().int().min(100).max(2000).default(600),
        })
        .prefault({}),
    })
    .prefault({}),
  /**
   * Tools that run on this node for the person using it (docs/agents.md).
   * Web research: search through a self-hosted SearXNG, then read pages with
   * SSRF protection. Queries and page requests leave from this computer.
   */
  /** WLF reward points for serving other people's requests (docs/rewards.md). */
  rewards: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Peer ID whose signed settlements this node accepts (default: none; set it to the network's settler). */
      settler: z.string().max(128).optional(),
      /** TESTS ONLY (needs the fake runtime and MESH_ALLOW_FAKE_RUNTIME=1): fake output and loopback peers earn receipts. */
      unsafeTestMode: z.boolean().default(false),
    })
    .prefault({}),
  agent: z
    .strictObject({
      web: z
        .strictObject({
          enabled: z.boolean().default(true),
          searxUrl: z.string().url().default('http://127.0.0.1:8888'),
          /** Let people using this node with a client token (not its operator) search from this node's connection. */
          allowClients: z.boolean().default(false),
          maxPages: z.number().int().min(0).max(4).default(2),
          maxPageBytes: z.number().int().min(10_000).max(10 * 2 ** 20).default(2 * 2 ** 20),
          fetchTimeoutMs: ms(10_000, 1000),
          /** TESTS ONLY (needs MESH_ALLOW_FAKE_RUNTIME=1): let fetch_url reach 127.0.0.1 on any port. Other private addresses stay blocked. */
          unsafeAllowLoopback: z.boolean().default(false),
        })
        .prefault({}),
      code: z
        .strictObject({
          enabled: z.boolean().default(true),
          /** Let people using this node with a client token (not its operator) run code in this node's sandbox. */
          allowClients: z.boolean().default(false),
          /** Pinned by digest; `./mesh code setup` pulls it. Update deliberately, like deploy/searxng/image.json. */
          image: z.string().min(1).default(PYTHON_SANDBOX_IMAGE),
          maxRounds: z.number().int().min(1).max(5).default(3),
          timeoutMs: ms(10_000, 1000),
          memoryMb: z.number().int().min(64).max(2048).default(256),
          cpus: z.number().min(0.1).max(4).default(1),
          /** Answer length per round: a solution, its tests and an explanation. */
          maxTokens: z.number().int().min(256).max(8192).default(1536),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type NodeConfig = z.infer<typeof NodeConfigSchema>;
export type NodeConfigInput = z.input<typeof NodeConfigSchema>;

export const FILES = {
  config: 'node.json',
  identity: 'identity.key',
  authorized: 'authorized-peers.json',
  secrets: 'secrets.json',
  peerCache: 'peers-cache.json',
  runtimeKey: 'runtime.key',
} as const;

export function resolveDataDir(dir?: string): string {
  return resolve(dir ?? process.env.MESH_DATA_DIR ?? join(REPO_ROOT, 'data', 'node'));
}

/**
 * Environment overrides, applied after reading node.json. Used by containers
 * so one image can run with a mounted config.
 */
function applyEnv(raw: Record<string, any>): Record<string, any> {
  const env = process.env;
  const set = (path: string[], v: unknown) => {
    let o = raw;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path[path.length - 1]!] = v;
  };
  if (env.MESH_HTTP_HOST) set(['http', 'host'], env.MESH_HTTP_HOST);
  if (env.MESH_HTTP_PORT) set(['http', 'port'], Number(env.MESH_HTTP_PORT));
  if (env.MESH_TRUST_LOOPBACK) set(['http', 'trustLoopback'], env.MESH_TRUST_LOOPBACK === 'true');
  if (env.MESH_RUNTIME_MODE) set(['runtime', 'mode'], env.MESH_RUNTIME_MODE);
  if (env.MESH_RUNTIME_URL) set(['runtime', 'url'], env.MESH_RUNTIME_URL);
  if (env.MESH_RUNTIME_API_KEY_FILE) set(['runtime', 'apiKeyFile'], env.MESH_RUNTIME_API_KEY_FILE);
  if (env.MESH_RUNTIME_BINARY) set(['runtime', 'binary'], env.MESH_RUNTIME_BINARY);
  if (env.MESH_THREADS) set(['runtime', 'threads'], Number(env.MESH_THREADS));
  if (env.MESH_GPU) set(['runtime', 'gpu'], env.MESH_GPU);
  if (env.MESH_MODEL_DIR) set(['model', 'dir'], env.MESH_MODEL_DIR);
  if (env.MESH_MODEL_CATALOG) set(['model', 'catalog'], env.MESH_MODEL_CATALOG);
  return raw;
}

export async function loadConfig(dataDir: string): Promise<NodeConfig> {
  const raw = await readJsonIfExists(join(dataDir, FILES.config));
  if (raw === undefined) {
    throw new Error(`No node configuration at ${join(dataDir, FILES.config)}. Run: ./mesh init --data ${dataDir}`);
  }
  const parsed = NodeConfigSchema.safeParse(applyEnv(raw as Record<string, any>));
  if (!parsed.success) {
    throw new Error(`Invalid ${FILES.config}: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.rewards.unsafeTestMode && (parsed.data.runtime.kind !== 'fake' || process.env.MESH_ALLOW_FAKE_RUNTIME !== '1')) {
    throw new Error('rewards.unsafeTestMode is for tests only: it needs runtime.kind "fake" and MESH_ALLOW_FAKE_RUNTIME=1.');
  }
  if (parsed.data.agent.web.unsafeAllowLoopback && (parsed.data.runtime.kind !== 'fake' || process.env.MESH_ALLOW_FAKE_RUNTIME !== '1')) {
    throw new Error('agent.web.unsafeAllowLoopback is for tests only: it needs runtime.kind "fake" and MESH_ALLOW_FAKE_RUNTIME=1.');
  }
  if (parsed.data.runtime.kind === 'fake' && process.env.MESH_ALLOW_FAKE_RUNTIME !== '1') {
    throw new Error('runtime.kind "fake" is a test-only deterministic adapter; set MESH_ALLOW_FAKE_RUNTIME=1 to use it explicitly.');
  }
  return parsed.data;
}

export async function writeConfig(dataDir: string, cfg: NodeConfigInput): Promise<NodeConfig> {
  const parsed = NodeConfigSchema.parse(cfg);
  await atomicWriteJson(join(dataDir, FILES.config), cfg);
  return parsed;
}
