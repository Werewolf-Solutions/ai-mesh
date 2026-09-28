/**
 * Wire-level constants for Werewolf AI Mesh protocol version 1.
 *
 * Every limit here is enforced on receipt; a peer that exceeds one is treated
 * as misbehaving for that stream and the stream is closed.
 */

export const PROTOCOL_VERSION = 1 as const;

/** libp2p protocol IDs. The trailing semver is bumped on incompatible changes. */
export const STATUS_PROTOCOL = '/werewolf-mesh/status/1.0.0';
export const INFER_PROTOCOL = '/werewolf-mesh/infer/1.0.0';

export const LIMITS = {
  /** Maximum size of one length-prefixed frame on any mesh protocol. */
  maxFrameBytes: 256 * 1024,
  /** Maximum chat messages per request. */
  maxMessages: 64,
  /** Maximum characters in one message's content. */
  maxMessageChars: 32_000,
  /** Maximum characters across all message contents (cheap pre-check before tokenising). */
  maxTotalChars: 48_000,
  /** Hard ceiling on output tokens for v0.1. */
  maxOutputTokens: 256,
  /** Total token budget (prompt + completion). */
  contextTokens: 2048,
  /** Maximum stop sequences and their length. */
  maxStop: 4,
  maxStopChars: 64,
  /** Peer-exchange bounds. */
  maxPeerHints: 32,
  maxAddrsPerPeer: 8,
  maxAddrChars: 512,
  maxModelFingerprints: 4,
  /** Maximum size of a single token text chunk. */
  maxTokenTextChars: 4096,
  /** Maximum length of IDs and free-form error messages on the wire. */
  maxIdChars: 128,
  maxErrorChars: 512,
} as const;
