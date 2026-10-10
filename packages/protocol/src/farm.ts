/** Execution is opt-in and versioned independently of inference. */
import { z } from 'zod';

export const FARM_PROTOCOL = '/werewolf-mesh/farm/1.0.0';
export const FARM_VERSION = 1 as const;
export const FARM_LIMITS = {
  sourceBytes: 4 * 1024 * 1024, transferBytes: 8 * 1024 * 1024,
  chunkBytes: 64 * 1024, files: 512, fileBytes: 1024 * 1024,
  outputBytes: 128 * 1024, records: 128, leaseMs: 30_000,
  artifactBytes: 1024 * 1024,
} as const;
const id = z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/);
const peer = z.string().min(10).max(128).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
export const FarmDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const FarmImage = z.string().max(256).regex(/^[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/);
export const FarmPath = z.string().min(1).max(240).refine((s) =>
  !s.includes('\\') && !/[\u0000-\u001f\u007f]/.test(s) &&
  !s.startsWith('/') && s.split('/').every((p) => p !== '' && p !== '.' && p !== '..') &&
  !/^[a-zA-Z]:/.test(s), 'expected a relative file path without traversal');
const b64 = (max: number) => z.string().max(Math.ceil(max / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const FarmFile = z.strictObject({ path: FarmPath, data: b64(FARM_LIMITS.fileBytes), sha256: FarmDigest });
export const FarmSource = z.strictObject({ files: z.array(FarmFile).max(FARM_LIMITS.files) });
export type FarmSource = z.infer<typeof FarmSource>;
export const FarmPolicy = z.strictObject({
  enabled: z.boolean().default(false), requesters: z.array(peer).max(128).default([]),
  images: z.array(FarmImage).max(16).default([]),
  cpus: z.number().min(0.1).max(16).default(1), memoryMb: z.number().int().min(64).max(16384).default(512),
  diskMb: z.number().int().min(8).max(1024).default(64),
  timeoutMs: z.number().int().min(100).max(3600000).default(600000),
  retentionMs: z.number().int().min(60000).max(7 * 86400000).default(86400000),
}).prefault({});
export type FarmPolicy = z.infer<typeof FarmPolicy>;
export const FarmSpec = z.strictObject({
  v: z.literal(FARM_VERSION), kind: z.literal('routine'),
  jobId: id, attemptId: id, fence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  requesterPeerId: peer, targetPeerId: peer,
  projectId: id, workspaceId: id,
  plan: z.strictObject({ id, revision: z.number().int().positive(), stepId: id }).optional(),
  title: z.string().min(1).max(200),
  source: z.strictObject({ baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), digest: FarmDigest, overlayDigest: FarmDigest.optional() }),
  image: FarmImage, architecture: z.enum(['x64', 'arm64']),
  steps: z.array(z.strictObject({ name: z.string().min(1).max(100), command: z.string().min(1).max(8192).refine((s) => !s.includes('\0')) })).min(1).max(20),
  outputs: z.array(FarmPath).max(16).default([]),
  network: z.literal('none'), retry: z.enum(['never', 'isolated']),
  limits: z.strictObject({
    cpus: z.number().min(0.1).max(16).default(1), memoryMb: z.number().int().min(64).max(16384).default(512),
    diskMb: z.number().int().min(8).max(1024).default(64), timeoutMs: z.number().int().min(100).max(3600000).default(600000),
    outputBytes: z.number().int().min(1024).max(FARM_LIMITS.outputBytes).default(65536),
  }).prefault({}),
});
export type FarmSpec = z.infer<typeof FarmSpec>;
export const FarmPackage = z.strictObject({ spec: FarmSpec, source: FarmSource });
export type FarmPackage = z.infer<typeof FarmPackage>;
export const FarmRef = z.strictObject({ jobId: id, attemptId: id, fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export type FarmRef = z.infer<typeof FarmRef>;
export const FarmState = z.enum(['accepted', 'preparing', 'running', 'collecting', 'completed', 'failed', 'cancelled', 'interrupted']);
export const FarmStatus = z.strictObject({
  ...FarmRef.shape, requesterPeerId: peer, targetPeerId: peer, sourceDigest: FarmDigest,
  state: FarmState, createdAt: z.number(), updatedAt: z.number(),
  cleanup: z.enum(['pending', 'done', 'failed']), detail: z.string().max(500),
  acknowledged: z.boolean(),
  resultAvailable: z.boolean().default(false),
});
export type FarmStatus = z.infer<typeof FarmStatus>;
export const FarmResult = z.strictObject({
  ...FarmRef.shape, sourceDigest: FarmDigest, image: FarmImage,
  steps: z.array(z.strictObject({ name: z.string().max(100), exitCode: z.number().int().nullable(), stdout: z.string().max(FARM_LIMITS.outputBytes), stderr: z.string().max(FARM_LIMITS.outputBytes) })).max(20),
  truncated: z.boolean(), timedOut: z.boolean(), durationMs: z.number().nonnegative(),
  artifacts: z.array(FarmFile).max(16).default([]),
});
export type FarmResult = z.infer<typeof FarmResult>;
export const FarmKey = z.strictObject({ peerId: peer, publicKey: b64(128), signature: b64(128) });
export type FarmKey = z.infer<typeof FarmKey>;
export const FarmEnvelope = z.strictObject({
  v: z.literal(FARM_VERSION), recipient: peer, context: z.string().min(1).max(512),
  ephemeralKey: b64(128), wrappedKey: b64(80), nonce: b64(12), tag: b64(16), data: b64(FARM_LIMITS.transferBytes),
});
export type FarmEnvelope = z.infer<typeof FarmEnvelope>;
export const FarmCapabilities = z.strictObject({
  v: z.literal(FARM_VERSION), key: FarmKey, enabled: z.boolean(), permitted: z.boolean(),
  architecture: z.string().max(32), images: z.array(FarmImage).max(16), active: z.boolean(),
  limits: FarmPolicy,
});
export type FarmCapabilities = z.infer<typeof FarmCapabilities>;
export const FarmRequest = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('discover') }),
  z.strictObject({ op: z.literal('submit'), envelope: FarmEnvelope, resultKey: FarmKey }),
  ...(['status', 'heartbeat', 'result', 'cancel', 'ack'] as const).map((op) => z.strictObject({ op: z.literal(op), ref: FarmRef })),
]);
export type FarmRequest = z.infer<typeof FarmRequest>;
export const FarmReply = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('capabilities'), value: FarmCapabilities }),
  z.strictObject({ type: z.literal('status'), value: FarmStatus }),
  z.strictObject({ type: z.literal('result'), value: FarmEnvelope }),
  z.strictObject({ type: z.literal('error'), code: z.enum(['forbidden', 'bad_request', 'busy', 'not_found', 'conflict', 'unavailable']), message: z.string().max(500) }),
]);
export type FarmReply = z.infer<typeof FarmReply>;
/** Chunked control messages use dedicated streams, never inference frames. */
export const FarmTransferHeader = z.strictObject({ v: z.literal(FARM_VERSION), type: z.literal('farm-transfer'), bytes: z.number().int().min(1).max(FARM_LIMITS.transferBytes) });
export const FarmTransferChunk = z.strictObject({ v: z.literal(FARM_VERSION), type: z.literal('farm-chunk'), seq: z.number().int().nonnegative(), data: b64(FARM_LIMITS.chunkBytes) });

export const FarmSubmit = z.strictObject({ targetPeerId: peer, package: FarmPackage });
export type FarmSubmit = z.infer<typeof FarmSubmit>;
