/**
 * WLF settlement for one epoch (one UTC day). Deterministic: anyone with the
 * same bundles, seeds and parameters gets the same result. See docs/rewards.md
 * for the threat model behind each rule.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, type RewardsBundle, type StoredReceipt } from '@werewolf-mesh/protocol';

export const DEFAULT_PARAMS = {
  /** WLF each qualified node brings to the daily pool before halvings. */
  allowanceWLF: 100,
  /** Halvings: none below this many qualified nodes, then one more at each doubling (16, 32, 64 …). */
  halvingStartNodes: 16,
  /** Answers shorter than this earn nothing. */
  minCompletionTokens: 16,
  /** Prompt tokens count this much of an answer token (reading is cheaper than writing). */
  promptWeight: 0.25,
  /** Most work one requester can credit per day, over all workers (in work units; a busy person writes ~20–50k tokens a day). */
  requesterDailyCap: 50_000,
  /** A node counts toward the pool only with this much credited work … */
  qualifyMinCredit: 1_000,
  /** … from at least this many different trusted requesters. */
  qualifyMinRequesters: 2,
  /** Share of a voucher's trust passed on (split among everyone it vouches for, except for seeds). */
  trustDecay: 0.5,
  trustMaxDepth: 4,
  /** Requesters below this trust credit nothing. */
  minTrust: 0.02,
  /** A node's weight in the pool: 2 × the trust of the people it served (by share of their use), at most 1. */
  nodeWeightFactor: 2,
  /** TEST ONLY: credit work between nodes on the same network (a home test). Recorded in the signed settlement. */
  countSameNetwork: false,
};
export type SettleParams = typeof DEFAULT_PARAMS;

export interface SettleInput {
  epoch: string;
  bundles: RewardsBundle[];
  /** Peer IDs trusted by definition (the settler's own nodes, the project's founders …). */
  seeds: string[];
  params?: Partial<SettleParams>;
  /** Signature checks (injected so this stays pure and testable). */
  verifyBundle: (b: RewardsBundle) => Promise<boolean>;
  verifyReceipt: (r: StoredReceipt) => Promise<boolean>;
  /** Relative cost of a model per token (e.g. its size in GB); null = excluded (test runtimes). */
  modelWeight: (fingerprint: string) => number | null;
}

export interface Allocation {
  peer: string;
  wlf: number;
  credit: number;
  receipts: number;
  requesters: number;
}

export interface SettlementBody {
  v: 1;
  epoch: string;
  params: SettleParams;
  seeds: string[];
  qualifiedNodes: number;
  halvings: number;
  pool: number;
  allocations: Allocation[];
  excluded: Record<string, number>;
  /** SHA-256 of each accepted bundle, so the inputs can be checked. */
  inputs: string[];
  /** Merkle root (SHA-256) over "peer:wlf" leaves, sorted: for a later on-chain claim. */
  merkleRoot: string;
}

/** Trust from the seeds through signed vouches. A ring of peers vouching for each other, unreachable from a seed, gets 0. */
export function computeTrust(seeds: string[], vouches: Map<string, string[]>, p: SettleParams): Map<string, number> {
  const trust = new Map<string, number>(seeds.map((s) => [s, 1]));
  let frontier = [...seeds];
  for (let depth = 0; depth < p.trustMaxDepth && frontier.length; depth++) {
    const add = new Map<string, number>();
    for (const v of frontier) {
      const out = (vouches.get(v) ?? []).filter((x) => x !== v);
      if (!out.length) continue;
      // Trust is conserved: a peer splits half of its trust among everyone it vouches for, so all
      // the accounts downstream of one person together never hold more trust than that person.
      // Seeds are exempt: they are trusted by definition, and the network's founding or bootstrap
      // node legitimately approves many peers.
      const each = ((trust.get(v) ?? 0) * p.trustDecay) / (seeds.includes(v) ? 1 : out.length);
      for (const x of out) if (!seeds.includes(x)) add.set(x, (add.get(x) ?? 0) + each);
    }
    const next: string[] = [];
    for (const [x, t] of add) {
      const before = trust.get(x) ?? 0;
      const after = Math.min(1, before + t);
      if (after > before) {
        trust.set(x, after);
        if (before === 0) next.push(x);
      }
    }
    frontier = next;
  }
  return trust;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) return sha('');
  let level = leaves.map((l) => sha(l)).sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(level[i]! + (level[i + 1] ?? level[i]!)));
    level = next;
  }
  return level[0]!;
}

export async function settle(input: SettleInput): Promise<SettlementBody> {
  const p: SettleParams = { ...DEFAULT_PARAMS, ...input.params };
  const excluded: Record<string, number> = {};
  const skip = (why: string, n = 1) => (excluded[why] = (excluded[why] ?? 0) + n);

  // 1. Bundles: signed by their worker; one per peer (the latest counts).
  const byPeer = new Map<string, RewardsBundle>();
  for (const b of input.bundles) {
    if (!(await input.verifyBundle(b))) {
      skip('bundle with a bad signature');
      continue;
    }
    const prev = byPeer.get(b.peer);
    if (!prev || b.vouches.at > prev.vouches.at) byPeer.set(b.peer, b);
  }
  const vouches = new Map<string, string[]>();
  for (const b of byPeer.values()) vouches.set(b.peer, b.vouches.approved);
  const trust = computeTrust(input.seeds, vouches, p);

  // 2. Receipts for this epoch that pass every rule.
  const seen = new Set<string>();
  const perRequester = new Map<string, Array<{ worker: string; work: number }>>();
  for (const b of byPeer.values()) {
    for (const s of b.receipts) {
      const r = s.receipt;
      if (r.epoch !== input.epoch) continue;
      if (r.worker !== b.peer) {
        skip('receipt submitted by a node that did not do the work');
        continue;
      }
      if (seen.has(r.id)) {
        skip('duplicate receipt');
        continue;
      }
      seen.add(r.id);
      if (r.requester === r.worker) {
        skip('self-use');
        continue;
      }
      if (r.sameNetwork || s.workerSameNetwork) {
        if (!p.countSameNetwork) {
          skip('same network or machine');
          continue;
        }
        skip('note: same network or machine COUNTED (test settlement)');
      }
      if (r.completionTokens < p.minCompletionTokens) {
        skip('answer too short');
        continue;
      }
      const w = input.modelWeight(r.model);
      if (w === null) {
        skip('test runtime / unknown model');
        continue;
      }
      if ((trust.get(r.requester) ?? 0) < p.minTrust) {
        skip('requester not trusted');
        continue;
      }
      if (!(await input.verifyReceipt(s))) {
        skip('receipt with a bad signature');
        continue;
      }
      const work = (r.completionTokens + p.promptWeight * r.promptTokens) * w;
      const list = perRequester.get(r.requester) ?? [];
      list.push({ worker: r.worker, work });
      perRequester.set(r.requester, list);
    }
  }

  // 3. Credit = work × requester trust, each requester capped per day.
  //    A node's weight in the pool = the trust of the people it served, by their share of use.
  const credit = new Map<string, number>();
  const weight = new Map<string, number>();
  const receipts = new Map<string, number>();
  const requesters = new Map<string, Set<string>>();
  for (const [req, list] of perRequester) {
    const total = list.reduce((n, x) => n + x.work, 0);
    const scale = total > p.requesterDailyCap ? p.requesterDailyCap / total : 1;
    if (scale < 1) skip('work above a requester’s daily cap (scaled down)', list.length);
    const t = trust.get(req) ?? 0;
    for (const x of list) {
      credit.set(x.worker, (credit.get(x.worker) ?? 0) + x.work * scale * t);
      weight.set(x.worker, (weight.get(x.worker) ?? 0) + (t * x.work) / total);
      receipts.set(x.worker, (receipts.get(x.worker) ?? 0) + 1);
      requesters.set(x.worker, (requesters.get(x.worker) ?? new Set()).add(req));
    }
  }

  // 4. Qualified nodes: real credited work for several trusted requesters. Empty or self-serving nodes don't count.
  const qualified = [...credit.keys()].filter((w) => (credit.get(w) ?? 0) >= p.qualifyMinCredit && (requesters.get(w)?.size ?? 0) >= p.qualifyMinRequesters).sort();
  for (const w of credit.keys()) if (!qualified.includes(w)) skip('worker not qualified (too little work or too few requesters)');
  const Q = qualified.length;
  const halvings = Q < p.halvingStartNodes ? 0 : Math.floor(Math.log2(Q / (p.halvingStartNodes / 2)));
  // Each qualified node adds its allowance × its weight: fake users cannot inflate the pool past the trust they hold.
  const nodeWeight = (w: string) => Math.min(1, p.nodeWeightFactor * (weight.get(w) ?? 0));
  const round = (x: number) => Math.floor(x * 1e6) / 1e6;
  const pool = round(qualified.reduce((n, w) => n + nodeWeight(w), 0) * (p.allowanceWLF / 2 ** halvings));

  // 5. Pool shared pro-rata by credit among qualified nodes.
  const totalCredit = qualified.reduce((n, w) => n + (credit.get(w) ?? 0), 0);
  const allocations: Allocation[] = qualified.map((w) => ({
    peer: w,
    wlf: totalCredit > 0 ? round((pool * (credit.get(w) ?? 0)) / totalCredit) : 0,
    credit: round(credit.get(w) ?? 0),
    receipts: receipts.get(w) ?? 0,
    requesters: requesters.get(w)?.size ?? 0,
  }));

  return {
    v: 1,
    epoch: input.epoch,
    params: p,
    seeds: [...input.seeds].sort(),
    qualifiedNodes: Q,
    halvings,
    pool,
    allocations,
    excluded,
    inputs: [...byPeer.values()].map((b) => sha(canonicalJson(b))).sort(),
    merkleRoot: merkleRoot(allocations.map((a) => `${a.peer}:${a.wlf}`)),
  };
}
