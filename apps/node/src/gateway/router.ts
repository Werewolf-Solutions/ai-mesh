/**
 * Routing strategy (deliberately simple, documented in docs/architecture.md):
 *
 *   score = (activeJobs + queueLength + outstanding_from_this_gateway) / maxConcurrency
 *         + (remote ? remotePenalty + rttMs / 1000 : 0)
 *
 * Lowest score wins; ties break on peer ID for determinism. Local values are
 * exact; remote values come from the peer's last authenticated status record
 * (a hint, possibly up to one probe interval stale) plus what this gateway has
 * itself sent there. Workers enforce their own limits regardless.
 */
import type { StatusRecord } from '@werewolf-mesh/protocol';

export interface Candidate {
  peerId: string;
  route: 'local' | 'remote';
  score: number;
  rttMs: number;
}

export interface LocalLoad {
  ready: boolean;
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
}

export function rankCandidates(opts: {
  selfPeerId: string;
  local: LocalLoad;
  remotes: Array<{ peerId: string; status: StatusRecord; rttMs: number }>;
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
      score: (local.active + local.queued) / Math.max(1, local.maxConcurrency) + (full ? 1000 : 0),
      rttMs: 0,
    });
  }
  for (const r of opts.remotes) {
    if (opts.exclude.has(r.peerId)) continue;
    const s = r.status;
    const pending = s.activeJobs + s.queueLength + (opts.outstanding.get(r.peerId) ?? 0);
    const full = s.queueLength >= s.maxQueue && s.activeJobs >= s.maxConcurrency;
    out.push({
      peerId: r.peerId,
      route: 'remote',
      score: pending / Math.max(1, s.maxConcurrency) + opts.remotePenalty + r.rttMs / 1000 + (full ? 1000 : 0),
      rttMs: r.rttMs,
    });
  }
  return out.sort((a, b) => a.score - b.score || (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
}
