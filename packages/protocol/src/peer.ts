/**
 * Peer-to-peer message schemas (protocol version 1).
 *
 * All frames are UTF-8 JSON inside unsigned-varint length-prefixed frames of at
 * most LIMITS.maxFrameBytes. Every frame carries `v` (protocol version) and
 * `type`. Unknown versions, unknown types and unknown fields are rejected.
 */
import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION } from './constants.js';
import { ERROR_CODE_LIST } from './errors.js';

const id = z.string().min(1).max(LIMITS.maxIdChars).regex(/^[A-Za-z0-9._:-]+$/);
const peerIdStr = z.string().min(10).max(LIMITS.maxIdChars).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'base58btc peer id');
const multiaddrStr = z.string().min(1).max(LIMITS.maxAddrChars).startsWith('/');
const fingerprint = z.string().min(1).max(200);
const version = z.literal(PROTOCOL_VERSION);

export const ChatRole = z.enum(['system', 'user', 'assistant']);
export const ChatMessage = z.strictObject({
  role: ChatRole,
  content: z.string().max(LIMITS.maxMessageChars),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const GenerationSettings = z.strictObject({
  maxTokens: z.number().int().min(1).max(LIMITS.maxOutputTokens),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
  stop: z.array(z.string().min(1).max(LIMITS.maxStopChars)).max(LIMITS.maxStop).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  /**
   * Thinking (reasoning before answering), for models that support it.
   * off: answer directly. on: think first, ending thinking after `budget` tokens.
   * `maxTokens` limits the ANSWER; thinking tokens come on top, up to `budget`.
   */
  thinking: z.strictObject({ mode: z.enum(['off', 'on']), budget: z.number().int().min(0).max(LIMITS.maxThinkingTokens).optional() }).optional(),
});
export type GenerationSettings = z.infer<typeof GenerationSettings>;

// ---------------------------------------------------------------------------
// Status protocol
// ---------------------------------------------------------------------------

export const NodeState = z.enum(['starting', 'ready', 'not_ready', 'draining']);
export type NodeState = z.infer<typeof NodeState>;

/**
 * A node's self-description. Only trusted when received directly from that
 * node over an authenticated connection (peerId must equal the remote peer).
 */
export const StatusRecord = z.strictObject({
  peerId: peerIdStr,
  networkId: id,
  protocolVersion: version,
  softwareVersion: z.string().max(32),
  state: NodeState,
  inferenceReady: z.boolean(),
  models: z.array(fingerprint).max(LIMITS.maxModelFingerprints),
  activeJobs: z.number().int().min(0).max(1024),
  queueLength: z.number().int().min(0).max(1024),
  maxConcurrency: z.number().int().min(0).max(1024),
  maxQueue: z.number().int().min(0).max(1024),
  /** Per hosted model: readiness and load (the totals above are sums). */
  modelLoad: z
    .array(
      z.strictObject({
        model: fingerprint,
        ready: z.boolean(),
        active: z.number().int().min(0).max(1024),
        queued: z.number().int().min(0).max(1024),
        maxConcurrency: z.number().int().min(0).max(1024),
        maxQueue: z.number().int().min(0).max(1024),
      }),
    )
    .max(LIMITS.maxModelFingerprints),
  /** The sender's own advertised addresses (authoritative only for the sender itself). */
  addrs: z.array(multiaddrStr).max(LIMITS.maxAddrsPerPeer),
  /** Sender's clock, informational only; freshness uses the receiver's clock. */
  sentAt: z.number().int().nonnegative(),
});
export type StatusRecord = z.infer<typeof StatusRecord>;

/** Discovery hint: "I am connected to this peer at these addresses". Not a status claim. */
export const PeerHint = z.strictObject({
  peerId: peerIdStr,
  addrs: z.array(multiaddrStr).max(LIMITS.maxAddrsPerPeer),
});
export type PeerHint = z.infer<typeof PeerHint>;

export const StatusExchange = z.strictObject({
  v: version,
  type: z.literal('status'),
  status: StatusRecord,
  hints: z.array(PeerHint).max(LIMITS.maxPeerHints),
});
export type StatusExchange = z.infer<typeof StatusExchange>;

// ---------------------------------------------------------------------------
// Inference protocol
// ---------------------------------------------------------------------------

export const InferRequest = z.strictObject({
  v: version,
  type: z.literal('infer'),
  requestId: id,
  attemptId: id,
  originPeerId: peerIdStr,
  model: fingerprint,
  messages: z.array(ChatMessage).min(1).max(LIMITS.maxMessages),
  settings: GenerationSettings,
  /** Remaining time budget in ms, relative to receipt (avoids cross-host clock skew). */
  deadlineMs: z.number().int().min(100).max(15 * 60_000),
});
export type InferRequest = z.infer<typeof InferRequest>;

export const CancelFrame = z.strictObject({
  v: version,
  type: z.literal('cancel'),
  requestId: id,
  attemptId: id,
});
export type CancelFrame = z.infer<typeof CancelFrame>;

/** Frames the gateway may send after the initial request. */
export const GatewayFollowUpFrame = CancelFrame;

export const FinishReason = z.enum(['stop', 'length']);
export type FinishReason = z.infer<typeof FinishReason>;

export const Usage = z.strictObject({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
});
export type Usage = z.infer<typeof Usage>;

export const WorkerFrame = z.discriminatedUnion('type', [
  z.strictObject({
    v: version,
    type: z.literal('accepted'),
    requestId: id,
    attemptId: id,
    workerPeerId: peerIdStr,
    queuePosition: z.number().int().min(0).max(1024),
    promptTokens: z.number().int().min(0),
  }),
  z.strictObject({
    v: version,
    type: z.literal('rejected'),
    requestId: id,
    attemptId: id,
    code: z.enum(ERROR_CODE_LIST),
    message: z.string().max(LIMITS.maxErrorChars),
    retryAfterMs: z.number().int().min(0).max(600_000).optional(),
  }),
  z.strictObject({
    v: version,
    type: z.literal('token'),
    seq: z.number().int().min(0),
    text: z.string().max(LIMITS.maxTokenTextChars),
    /** 'reasoning' for thinking text, absent for the answer. */
    channel: z.literal('reasoning').optional(),
  }),
  z.strictObject({
    v: version,
    type: z.literal('completed'),
    finishReason: FinishReason,
    usage: Usage,
    timings: z
      .strictObject({ queueMs: z.number().min(0), firstTokenMs: z.number().min(0), totalMs: z.number().min(0) })
      .optional(),
  }),
  z.strictObject({
    v: version,
    type: z.literal('failed'),
    code: z.enum(ERROR_CODE_LIST),
    message: z.string().max(LIMITS.maxErrorChars),
  }),
  z.strictObject({
    v: version,
    type: z.literal('cancelled'),
  }),
]);
export type WorkerFrame = z.infer<typeof WorkerFrame>;
