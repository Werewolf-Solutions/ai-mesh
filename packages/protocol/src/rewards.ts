/**
 * WLF rewards: signed usage receipts and settlement records (docs/rewards.md).
 *
 * WLF are reward points for serving other people's requests. They are NOT a
 * token and have no promised value; a later redemption on Ethereum is a plan,
 * not a feature.
 *
 * A receipt is written and signed by the REQUESTER's node after a worker on
 * another node completed its request, and delivered to that worker. It holds
 * no prompt or answer text and no IP address.
 */
import { z } from 'zod';

export const RECEIPT_PROTOCOL = '/werewolf-mesh/receipt/1.0.0';
export const REWARDS_VERSION = 1 as const;

const peerId = z.string().min(10).max(128);
/** UTC day, e.g. "2026-09-29": one settlement epoch. */
export const Epoch = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const epochOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const Receipt = z.strictObject({
  v: z.literal(REWARDS_VERSION),
  /** requestId/attemptId of the answer (unique per attempt). */
  id: z.string().min(8).max(128),
  epoch: Epoch,
  requester: peerId,
  worker: peerId,
  model: z.string().min(1).max(200),
  promptTokens: z.number().int().min(0).max(1_000_000),
  completionTokens: z.number().int().min(0).max(1_000_000),
  completedAt: z.number().int().nonnegative(),
  /** The requester's view: did the worker's connection come from its own network (LAN, loopback, same public IP)? */
  sameNetwork: z.boolean(),
});
export type Receipt = z.infer<typeof Receipt>;

export const SignedReceipt = z.strictObject({ receipt: Receipt, sig: z.string().min(16).max(512) });
export type SignedReceipt = z.infer<typeof SignedReceipt>;

/** Frame on RECEIPT_PROTOCOL (one per stream). */
export const ReceiptFrame = z.strictObject({ v: z.literal(REWARDS_VERSION), type: z.literal('receipt'), signed: SignedReceipt });

/** What a worker stored, with its own view of the requester's connection. */
export const StoredReceipt = SignedReceipt.extend({
  workerSameNetwork: z.boolean(),
  /** The worker's measured completion tokens for this job (must agree with the receipt). */
  workerCompletionTokens: z.number().int().min(0),
});
export type StoredReceipt = z.infer<typeof StoredReceipt>;

/** Signed "I approved these peers": the trust graph used to weight requesters. */
export const Vouches = z.strictObject({ v: z.literal(REWARDS_VERSION), peer: peerId, approved: z.array(peerId).max(4096), at: z.number().int().nonnegative() });
export type Vouches = z.infer<typeof Vouches>;

/** What a node submits for settlement: its receipts as a worker, and its vouches, signed together. */
export const RewardsBundle = z.strictObject({
  v: z.literal(REWARDS_VERSION),
  peer: peerId,
  epochs: z.array(Epoch).max(366),
  receipts: z.array(StoredReceipt).max(500_000),
  vouches: Vouches,
  sig: z.string().min(16).max(512),
});
export type RewardsBundle = z.infer<typeof RewardsBundle>;

/** Deterministic JSON (sorted keys) for signing. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`;
  if (x && typeof x === 'object') {
    return `{${Object.keys(x as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(x);
}

/** Bytes signed for a receipt, a bundle, or a settlement: domain-separated so a signature cannot be reused across kinds. */
export const signingBytes = (domain: 'receipt' | 'bundle' | 'settlement', body: unknown) => new TextEncoder().encode(`werewolf-mesh/wlf/${domain}/v1\n${canonicalJson(body)}`);
