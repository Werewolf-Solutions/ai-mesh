/**
 * Routing strategy (documented in docs/architecture.md):
 *
 *   expected seconds = (jobs ahead + 1) × TYPICAL_JOB_TOKENS / speed
 *                      + (remote ? remotePenalty + rttMs/1000 : 0)
 *
 * `jobs ahead` = that model's active + queued (+ what this gateway already has
 * outstanding there) divided by its concurrency. `speed` is the decode speed
 * THIS gateway measured from that node's previous answers for that model; until
 * there is a measurement, a prior from the node's hardware hint is used
 * (CPU ≈ 8 tok/s, GPU ≈ 40 tok/s). A node cannot make itself look faster than
 * it really answers. Lowest expected time wins; ties break on peer ID.
 */
import type { ModelLoad } from '../p2p/peers.js';

export interface Candidate {
  peerId: string;
  route: 'local' | 'remote';
  score: number;
  rttMs: number;
}

export const TYPICAL_JOB_TOKENS = 256;
export const PRIOR_TOK_PER_S: Record<string, number> = { cpu: 8, cuda: 40, vulkan: 30, metal: 30 };

export interface LocalLoad {
  /** Decode speed measured (or prior) for this model on this node. */
  speed: number;
  ready: boolean;
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
}

export function rankCandidates(opts: {
  selfPeerId: string;
  local: LocalLoad;
  remotes: Array<{ peerId: string; load: ModelLoad; rttMs: number; speed: number }>;
  outstanding: Map<string, number>;
  exclude: Set<string>;
  remotePenalty: number;
}): Candidate[] {
  const out: Candidate[] = [];
  const { local } = opts;
  if (local.ready && !opts.exclude.has(opts.selfPeerId)) {
    const full = local.queued >= local.maxQueue && local.active >= local.maxConcurrency;
    out.push({
      peerId: opts.selfPeerId,
      route: 'local',
      score: ((local.active + local.queued) / Math.max(1, local.maxConcurrency) + 1) * (TYPICAL_JOB_TOKENS / Math.max(0.1, local.speed)) + (full ? 1e6 : 0),
      rttMs: 0,
    });
  }
  for (const r of opts.remotes) {
    if (opts.exclude.has(r.peerId)) continue;
    const s = r.load;
    const pending = s.active + s.queued + (opts.outstanding.get(r.peerId) ?? 0);
    const full = s.queued >= s.maxQueue && s.active >= s.maxConcurrency;
    out.push({
      peerId: r.peerId,
      route: 'remote',
      score: (pending / Math.max(1, s.maxConcurrency) + 1) * (TYPICAL_JOB_TOKENS / Math.max(0.1, r.speed)) + opts.remotePenalty + r.rttMs / 1000 + (full ? 1e6 : 0),
      rttMs: r.rttMs,
    });
  }
  return out.sort((a, b) => a.score - b.score || (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
}
