/**
 * WLF rewards ledger (docs/rewards.md).
 *
 * As REQUESTER: after another node completed one of our requests, sign a
 * receipt and deliver it to that worker (/werewolf-mesh/receipt/1.0.0).
 * As WORKER: accept a receipt only if it matches a job this node actually
 * ran for that same peer (same request, model and token count), is signed by
 * the peer that sent it, and is new. Store it for settlement.
 *
 * Self-use never produces a receipt (local route). Work between nodes on the
 * same network is recorded but marked, and never credited at settlement.
 */
import type { Connection, Libp2p, PrivateKey, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  canonicalJson,
  epochOf,
  Receipt,
  RECEIPT_PROTOCOL,
  ReceiptFrame,
  REWARDS_VERSION,
  RewardsBundle,
  signingBytes,
  StoredReceipt,
  type Usage,
} from '@werewolf-mesh/protocol';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Multiaddr } from '@multiformats/multiaddr';
import { FrameStream } from '../p2p/framing.js';
import type { Logger } from '../util/log.js';
import { isBlockedAddress } from '../agent/fetch.js';
import type { SettlementBody } from './settle.js';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export async function signBody(key: PrivateKey, domain: 'receipt' | 'bundle' | 'settlement', body: unknown): Promise<string> {
  return b64(await key.sign(signingBytes(domain, body)));
}

export async function verifyBody(peer: string, domain: 'receipt' | 'bundle' | 'settlement', body: unknown, sig: string): Promise<boolean> {
  try {
    const pk = peerIdFromString(peer).publicKey;
    if (!pk) return false;
    return await pk.verify(signingBytes(domain, body), unb64(sig));
  } catch {
    return false;
  }
}

/** IP (without port) of a multiaddr, or null for relayed/other addresses. */
function ipOf(ma: Multiaddr): { ip: string; v: 4 | 6 } | null {
  const s = ma.toString();
  if (s.includes('/p2p-circuit')) return null;
  const m = /^\/ip([46])\/([^/]+)/.exec(s);
  return m ? { ip: m[2]!, v: m[1] === '4' ? 4 : 6 } : null;
}

const v6Prefix56 = (ip: string) => {
  // Expand and keep the first 56 bits (a typical home delegation).
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((x) => x.padStart(4, '0'));
  return full.slice(0, 3).join(':') + ':' + full[3]!.slice(0, 2);
};

/**
 * Is `remote` on this node's own network? Private, loopback and link-local
 * addresses mean the same LAN or machine; a public address equal to one of
 * this node's own (IPv4) or in the same /56 (IPv6) means the same connection.
 * Relayed connections count as a different network.
 */
export function sameNetwork(remote: Multiaddr[], own: Multiaddr[], opts: { wsBehindProxy?: boolean } = {}): boolean {
  // Behind a reverse proxy every WebSocket peer seems to come from loopback: that says nothing about where it really is.
  if (opts.wsBehindProxy) remote = remote.filter((ma) => !(/\/wss?(\/|$)/.test(ma.toString()) && isBlockedAddress(ipOf(ma)?.ip ?? '')));
  const ownIps = own.map(ipOf).filter((x): x is { ip: string; v: 4 | 6 } => !!x && !isBlockedAddress(x.ip));
  for (const ma of remote) {
    const r = ipOf(ma);
    if (!r) continue;
    if (isBlockedAddress(r.ip)) return true; // loopback, LAN, link-local, CGNAT …
    if (r.v === 4 && ownIps.some((o) => o.v === 4 && o.ip === r.ip)) return true;
    if (r.v === 6 && ownIps.some((o) => o.v === 6 && v6Prefix56(o.ip) === v6Prefix56(r.ip))) return true;
  }
  return false;
}

interface ServedJob {
  origin: string;
  model: string;
  usage: Usage;
  at: number;
  sameNetwork: boolean;
}

export interface RewardsStatus {
  enabled: boolean;
  epochs: Array<{
    epoch: string;
    received: number;
    creditableTokens: number;
    sameNetwork: number;
    requesters: number;
  }>;
  sent: { today: number };
  rejected: Record<string, number>;
}

export class RewardsLedger {
  private readonly served = new Map<string, ServedJob>();
  private readonly seen = new Set<string>();
  private readonly rejected: Record<string, number> = {};
  private sentToday = { epoch: '', n: 0 };
  private readonly dir: string;
  readonly settlements: SettlementStore;

  constructor(
    private readonly deps: {
      dataDir: string;
      libp2p: Libp2p;
      privateKey: PrivateKey;
      selfPeerId: string;
      /** False on fake-runtime nodes unless test mode: placeholder output earns nothing. */
      enabled: boolean;
      /** TESTS ONLY: treat loopback peers as different networks. */
      testLoopbackIsRemote: boolean;
      /** p2p.websocketBehindProxy */
      wsBehindProxy: boolean;
      approvedPeers: () => string[];
      settler: () => string | undefined;
      log: Logger;
    },
  ) {
    this.dir = join(deps.dataDir, 'rewards');
    this.settlements = new SettlementStore(this.dir, deps.selfPeerId, deps.settler);
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Remember receipts already stored (duplicates are refused across restarts too).
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      if (!/^receipts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      for (const line of (await readFile(join(this.dir, f), 'utf8')).split('\n')) {
        if (!line) continue;
        try {
          this.seen.add((JSON.parse(line) as { receipt: { id: string } }).receipt.id);
        } catch {
          /* skip a torn line */
        }
      }
    }
    await this.deps.libp2p.handle(RECEIPT_PROTOCOL, (s, c) => void this.onReceipt(s, c), { maxInboundStreams: 16, runOnLimitedConnection: true });
  }

  private isSameNetwork(peer: string): boolean {
    if (this.deps.testLoopbackIsRemote) return false;
    const remote = this.deps.libp2p.getConnections(peerIdFromString(peer)).map((c) => c.remoteAddr);
    return sameNetwork(remote, this.deps.libp2p.getMultiaddrs(), { wsBehindProxy: this.deps.wsBehindProxy });
  }

  /** WORKER: this node finished a job for another node (called by the infer handler). */
  noteServed(origin: string, id: string, model: string, usage: Usage): void {
    if (!this.deps.enabled || origin === this.deps.selfPeerId) return;
    const now = Date.now();
    for (const [k, v] of this.served) if (now - v.at > 10 * 60_000) this.served.delete(k);
    if (this.served.size > 10_000) return;
    this.served.set(id, { origin, model, usage, at: now, sameNetwork: this.isSameNetwork(origin) });
  }

  /** REQUESTER: another node completed our request; sign a receipt and deliver it. */
  async noteCompleted(worker: string, id: string, model: string, usage: Usage): Promise<void> {
    if (!this.deps.enabled || worker === this.deps.selfPeerId) return;
    const receipt: Receipt = {
      v: REWARDS_VERSION,
      id,
      epoch: epochOf(Date.now()),
      requester: this.deps.selfPeerId,
      worker,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      completedAt: Date.now(),
      sameNetwork: this.isSameNetwork(worker),
    };
    const sig = await signBody(this.deps.privateKey, 'receipt', receipt);
    let stream: Stream | undefined;
    try {
      stream = await this.deps.libp2p.dialProtocol(peerIdFromString(worker), RECEIPT_PROTOCOL, { runOnLimitedConnection: true, signal: AbortSignal.timeout(5000) });
      const fs = new FrameStream(stream, 16 * 1024, REWARDS_VERSION);
      await fs.write({ v: REWARDS_VERSION, type: 'receipt', signed: { receipt, sig } });
      await stream.close();
      const ep = receipt.epoch;
      this.sentToday = this.sentToday.epoch === ep ? { epoch: ep, n: this.sentToday.n + 1 } : { epoch: ep, n: 1 };
    } catch (err) {
      stream?.abort(err as Error);
      this.deps.log.debug({ worker, err: (err as Error).message }, 'could not deliver a receipt');
    }
  }

  private reject(reason: string, stream: Stream): void {
    this.rejected[reason] = (this.rejected[reason] ?? 0) + 1;
    stream.abort(new Error(`receipt refused: ${reason}`));
  }

  private async onReceipt(stream: Stream, conn: Connection): Promise<void> {
    const from = conn.remotePeer.toString();
    let frame;
    try {
      frame = await new FrameStream(stream, 16 * 1024, REWARDS_VERSION).read(ReceiptFrame, AbortSignal.timeout(5000));
    } catch {
      return this.reject('malformed', stream);
    }
    const { receipt: r, sig } = frame.signed;
    if (r.requester !== from) return this.reject('not from its requester', stream);
    if (r.worker !== this.deps.selfPeerId) return this.reject('not for this node', stream);
    if (this.seen.has(r.id)) return this.reject('duplicate', stream);
    const job = this.served.get(r.id);
    // Only a job this node ran, for this peer, with this model and (almost) this many tokens.
    if (!job || job.origin !== from) return this.reject('no such job', stream);
    if (job.model !== r.model) return this.reject('model mismatch', stream);
    if (Math.abs(job.usage.completionTokens - r.completionTokens) > 2 || Math.abs(job.usage.promptTokens - r.promptTokens) > 8) return this.reject('token counts disagree', stream);
    if (!(await verifyBody(from, 'receipt', r, sig))) return this.reject('bad signature', stream);
    this.served.delete(r.id);
    this.seen.add(r.id);
    const stored: StoredReceipt = { receipt: r, sig, workerSameNetwork: job.sameNetwork, workerCompletionTokens: job.usage.completionTokens };
    await appendFile(join(this.dir, `receipts-${r.epoch}.jsonl`), JSON.stringify(stored) + '\n', { mode: 0o600 });
    await stream.close().catch(() => undefined);
  }

  private async load(epoch: string): Promise<StoredReceipt[]> {
    const raw = await readFile(join(this.dir, `receipts-${epoch}.jsonl`), 'utf8').catch(() => '');
    const out: StoredReceipt[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const p = StoredReceipt.safeParse(JSON.parse(line));
      if (p.success) out.push(p.data);
    }
    return out;
  }

  async epochs(): Promise<string[]> {
    return (await readdir(this.dir).catch(() => [] as string[]))
      .map((f) => /^receipts-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1])
      .filter((x): x is string => !!x)
      .sort();
  }

  async status(): Promise<RewardsStatus> {
    const epochs = [];
    for (const epoch of (await this.epochs()).slice(-14).reverse()) {
      const rs = await this.load(epoch);
      const ok = rs.filter((x) => !x.receipt.sameNetwork && !x.workerSameNetwork);
      epochs.push({
        epoch,
        received: rs.length,
        creditableTokens: ok.reduce((n, x) => n + x.receipt.completionTokens, 0),
        sameNetwork: rs.length - ok.length,
        requesters: new Set(ok.map((x) => x.receipt.requester)).size,
      });
    }
    const today = epochOf(Date.now());
    return { enabled: this.deps.enabled, epochs, sent: { today: this.sentToday.epoch === today ? this.sentToday.n : 0 }, rejected: { ...this.rejected } };
  }

  /** Everything this node submits for settlement, signed by it. */
  async bundle(epochs?: string[]): Promise<RewardsBundle> {
    const eps = epochs ?? (await this.epochs());
    const receipts = (await Promise.all(eps.map((e) => this.load(e)))).flat();
    const vouches = { v: REWARDS_VERSION, peer: this.deps.selfPeerId, approved: this.deps.approvedPeers().sort(), at: Date.now() };
    const body = { v: REWARDS_VERSION, peer: this.deps.selfPeerId, epochs: eps, receipts, vouches };
    return { ...body, sig: await signBody(this.deps.privateKey, 'bundle', body) } as RewardsBundle;
  }
}

export interface SignedSettlement {
  body: SettlementBody;
  settler: string;
  sig: string;
}

/** Imported settlements (signed by the configured settler) and this node's balance from them. */
export class SettlementStore {
  constructor(
    private readonly dir: string,
    private readonly self: string,
    private readonly settler: () => string | undefined,
  ) {}

  async import(s: SignedSettlement): Promise<{ epoch: string; wlf: number }> {
    const settler = this.settler();
    if (!settler) throw new Error('no settler configured (rewards.settler in node.json)');
    if (s.settler !== settler) throw new Error(`signed by ${s.settler.slice(-8)}, but this node accepts settlements from ${settler.slice(-8)} only`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.body?.epoch ?? '')) throw new Error('not a settlement');
    if (!(await verifyBody(s.settler, 'settlement', s.body, s.sig))) throw new Error('bad settlement signature');
    await mkdir(join(this.dir, 'settlements'), { recursive: true, mode: 0o700 });
    const { atomicWriteJson } = await import('../util/fs.js');
    await atomicWriteJson(join(this.dir, 'settlements', `${s.body.epoch}.json`), s);
    return { epoch: s.body.epoch, wlf: s.body.allocations.find((a) => a.peer === this.self)?.wlf ?? 0 };
  }

  async balance(): Promise<{ total: number; epochs: Array<{ epoch: string; wlf: number; pool: number; qualifiedNodes: number; halvings: number }> }> {
    const files = (await readdir(join(this.dir, 'settlements')).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
    const epochs = [];
    for (const f of files) {
      const s = JSON.parse(await readFile(join(this.dir, 'settlements', f), 'utf8')) as SignedSettlement;
      epochs.push({ epoch: s.body.epoch, wlf: s.body.allocations.find((a) => a.peer === this.self)?.wlf ?? 0, pool: s.body.pool, qualifiedNodes: s.body.qualifiedNodes, halvings: s.body.halvings });
    }
    return { total: Math.round(epochs.reduce((n, e) => n + e.wlf, 0) * 1e6) / 1e6, epochs };
  }
}

export { canonicalJson };
