/**
 * HTTP API schemas: a documented subset of the OpenAI Chat Completions API plus
 * mesh-specific extensions. Unsupported functionality is rejected, not ignored.
 */
import { z } from 'zod';
import { LIMITS } from './constants.js';
import { ChatMessage } from './peer.js';

/** OpenAI fields that are accepted but have no effect. */
export const IGNORED_OPENAI_FIELDS = ['user', 'store', 'metadata', 'service_tier'] as const;

/** OpenAI fields that request functionality v0.1 does not provide. Rejected with 400. */
export const UNSUPPORTED_OPENAI_FIELDS = [
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'response_format',
  'audio',
  'modalities',
  'prediction',
  'reasoning_effort',
  'web_search_options',
] as const;

export const MeshTarget = z.union([z.literal('auto'), z.literal('local'), z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{10,128}$/)]);

export const ChatCompletionRequest = z.strictObject({
  model: z.string().max(200).optional(),
  messages: z.array(ChatMessage).min(1).max(LIMITS.maxMessages),
  stream: z.boolean().optional(),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
  stop: z.union([z.string().min(1).max(LIMITS.maxStopChars), z.array(z.string().min(1).max(LIMITS.maxStopChars)).max(LIMITS.maxStop)]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  n: z.literal(1).optional(),
  user: z.string().max(256).optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  service_tier: z.string().max(32).optional(),
  /** Mesh extension: pin execution to "local", a specific authorised peer ID, or "auto". */
  mesh: z
    .strictObject({
      target: MeshTarget.optional(),
      /** Total time budget in ms (default and cap come from gateway config). */
      timeout_ms: z.number().int().min(1000).max(15 * 60_000).optional(),
      /** Use pack-memory notes as context (default true when the gateway has pack memory). */
      pack: z.boolean().optional(),
    })
    .optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

/** Attribution attached to every response. */
export interface MeshAttribution {
  gatewayPeerId: string;
  workerPeerId: string | null;
  /** 'local' when the gateway executed the request itself. */
  route: 'local' | 'remote' | null;
  attempts: Array<{ workerPeerId: string; route: 'local' | 'remote'; outcome: string }>;
  runtime: 'llama.cpp' | 'fake';
  timings?: { queueMs: number; firstTokenMs: number; totalMs: number };
}

export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
    retry_after_ms?: number;
    mesh?: Partial<MeshAttribution>;
  };
}

/** GET /health/ready body (intentionally minimal; no peer or prompt data). */
export interface ReadyBody {
  ready: boolean;
  model: 'ready' | 'loading' | 'unverified' | 'failed' | 'absent';
  serving: 'accepting' | 'draining' | 'starting';
  /** True when this gateway can route to at least one ready worker (itself or a peer). */
  canServe: boolean;
}

/** Admin: one peer as observed locally by this node. */
export interface PeerView {
  peerId: string;
  label: string | null;
  authorized: boolean;
  connected: boolean;
  direct: boolean | null;
  relayed: boolean;
  available: boolean;
  state: string | null;
  inferenceReady: boolean;
  modelCompatible: boolean;
  activeJobs: number | null;
  queueLength: number | null;
  rttMs: number | null;
  lastStatusAgeMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Addresses of open connections (connected) or known dial candidates (not connected). */
  addrs: string[];
}

export interface NodeStatusView {
  peerId: string;
  networkId: string;
  softwareVersion: string;
  protocolVersion: number;
  uptimeMs: number;
  state: string;
  runtime: { kind: 'llama.cpp' | 'fake'; ready: boolean; detail: string };
  model: { id: string; fingerprint: string; verified: boolean };
  worker: { active: number; queued: number; maxConcurrency: number; maxQueue: number };
  gateway: { inFlight: number; maxInFlight: number };
  listenAddrs: string[];
  advertisedAddrs: string[];
  relayServer: boolean;
  observation: 'local-partial';
}

export interface MetricsView {
  counters: Record<string, number>;
  recent: {
    ttftMs: number[];
    tokensPerSecond: number[];
    failoverMs: number[];
  };
  memory: { rssBytes: number; heapUsedBytes: number };
  connections: number;
  trackedPeers: number;
  dedupEntries: number;
}
