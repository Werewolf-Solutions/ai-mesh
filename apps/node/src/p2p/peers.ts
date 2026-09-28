/**
 * PeerManager: this node's LOCAL, PARTIAL view of the mesh.
 *
 * - Tracks only authorised peers (bounded by authorized-peers.json).
 * - Authoritative status for peer X comes only from X itself over an
 *   authenticated connection (status protocol, both directions).
 * - Peer-exchange hints ("I am connected to X at these addrs") are used only
 *   as dial candidates, never as status.
 * - Probes every `probeIntervalMs`; after `failuresBeforeUnavailable`
 *   consecutive failures the peer is marked unavailable and disconnected.
 * - Reconnects with exponential backoff + jitter.
 * - Persists a bounded address cache so restarts do not depend on bootstrap.
 */
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { LIMITS, MeshError, STATUS_PROTOCOL, StatusExchange, type PeerHint, type PeerView, type StatusRecord } from '@werewolf-mesh/protocol';
import { join } from 'node:path';
import { z } from 'zod';
import type { Admission } from '../admission.js';
import { FILES, type NodeConfig } from '../config.js';
import type { Metrics } from '../metrics.js';
import { atomicWriteJson, readJsonIfExists } from '../util/fs.js';
import type { Logger } from '../util/log.js';
import { FrameStream } from './framing.js';

type AddrSource = 'config' | 'bootstrap' | 'cache' | 'hint';
const MAX_ADDRS_TRACKED = 16;

interface PeerEntry {
  peerId: string;
  addrs: Map<string, { source: AddrSource; at: number }>;
  status: StatusRecord | null;
  statusAt: number;
  rttMs: number | null;
  failures: number;
  lastProbeAt: number;
  probing: boolean;
  dialing: boolean;
  nextDialAt: number;
  backoffMs: number;
  lastError: string | null;
  lastConnectedAt: number;
  nextDirectAt: number;
}

const CacheSchema = z.object({
  version: z.literal(1),
  peers: z.array(z.object({ peerId: z.string(), addrs: z.array(z.string()).max(LIMITS.maxAddrsPerPeer), lastSeen: z.number() })),
});

export function peerIdOfAddr(addr: string): string | null {
  try {
    const comps = multiaddr(addr).getComponents();
    const p2p = [...comps].reverse().find((c) => c.name === 'p2p');
    return p2p?.value ?? null;
  } catch {
    return null;
  }
}

export interface PeerManagerDeps {
  libp2p: Libp2p;
  admission: Admission;
  cfg: NodeConfig;
  selfPeerId: string;
  selfStatus: () => StatusRecord;
  modelFingerprint: string;
  dataDir: string;
  log: Logger;
  metrics: Metrics;
  now?: () => number;
  random?: () => number;
}

export class PeerManager {
  private readonly peers = new Map<string, PeerEntry>();
  private timer: NodeJS.Timeout | undefined;
  private cacheDirty = false;
  private lastCacheWrite = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly d: NodeConfig['discovery'];

  constructor(private readonly deps: PeerManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.d = deps.cfg.discovery;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    const { libp2p, cfg } = this.deps;
    await libp2p.handle(STATUS_PROTOCOL, (stream, conn) => this.onInboundStatus(stream, conn), {
      maxInboundStreams: cfg.p2p.maxInboundStreamsPerProtocol,
      runOnLimitedConnection: true,
    });
    libp2p.addEventListener('peer:connect', (ev) => this.onConnect(ev.detail.toString()));
    libp2p.addEventListener('peer:disconnect', (ev) => this.onDisconnect(ev.detail.toString()));

    for (const id of this.deps.admission.list()) this.ensureEntry(id);
    for (const id of this.deps.admission.list()) {
      for (const a of this.deps.admission.configuredAddrs(id)) this.addAddr(id, a, 'config');
    }
    for (const b of cfg.p2p.bootstrap) {
      const id = peerIdOfAddr(b);
      if (!id) {
        this.deps.log.warn({ addr: b }, 'bootstrap address has no /p2p/<peerId>; ignored');
        continue;
      }
      if (!this.deps.admission.isAuthorized(id)) {
        this.deps.log.warn({ peer: id }, 'bootstrap peer is not in authorized-peers.json; ignored (discovery never grants admission)');
        continue;
      }
      this.addAddr(id, b, 'bootstrap');
    }
    await this.loadCache();
    this.tick();
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.min(this.d.probeIntervalMs, 1000)));
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.saveCache(true);
  }

  /** Called when authorized-peers.json changes. */
  onAdmissionChange(added: string[], removed: string[]): void {
    for (const id of added) {
      this.ensureEntry(id);
      for (const a of this.deps.admission.configuredAddrs(id)) this.addAddr(id, a, 'config');
    }
    for (const id of removed) {
      this.peers.delete(id);
      this.deps.log.info({ peer: id }, 'peer de-authorised; disconnecting');
      void this.deps.libp2p.hangUp(peerIdFromString(id)).catch(() => undefined);
    }
    this.cacheDirty = true;
  }

  // ---------------------------------------------------------------- state

  private ensureEntry(peerId: string): PeerEntry | null {
    if (peerId === this.deps.selfPeerId || !this.deps.admission.isAuthorized(peerId)) return null;
    let e = this.peers.get(peerId);
    if (!e) {
      e = {
        peerId,
        addrs: new Map(),
        status: null,
        statusAt: 0,
        rttMs: null,
        failures: 0,
        lastProbeAt: 0,
        probing: false,
        dialing: false,
        nextDialAt: 0,
        backoffMs: this.d.reconnectBaseMs,
        lastError: null,
        lastConnectedAt: 0,
        nextDirectAt: 0,
      };
      this.peers.set(peerId, e);
    }
    return e;
  }

  private addAddr(peerId: string, addr: string, source: AddrSource): void {
    const e = this.ensureEntry(peerId);
    if (!e || addr.length > LIMITS.maxAddrChars) return;
    let full: string;
    try {
      const ma = multiaddr(addr);
      const id = peerIdOfAddr(addr);
      if (id && id !== peerId && !addr.includes('/p2p-circuit')) return; // address belongs to someone else
      full = id === peerId ? ma.toString() : ma.encapsulate(`/p2p/${peerId}`).toString();
    } catch {
      return;
    }
    const existing = e.addrs.get(full);
    // Configured/bootstrap sources outrank cache/hint sources.
    const rank = { config: 3, bootstrap: 3, cache: 1, hint: 2 } as const;
    if (existing && rank[existing.source] > rank[source]) existing.at = this.now();
    else e.addrs.set(full, { source, at: this.now() });
    if (e.addrs.size > MAX_ADDRS_TRACKED) {
      // Evict the oldest non-configured address.
      const victim = [...e.addrs].filter(([, v]) => v.source !== 'config' && v.source !== 'bootstrap').sort((a, b) => a[1].at - b[1].at)[0];
      if (victim) e.addrs.delete(victim[0]);
    }
  }

  isConnected(peerId: string): boolean {
    try {
      return this.deps.libp2p.getConnections(peerIdFromString(peerId)).some((c) => c.status === 'open');
    } catch {
      return false;
    }
  }

  private connectionsOf(peerId: string): Connection[] {
    try {
      return this.deps.libp2p.getConnections(peerIdFromString(peerId)).filter((c) => c.status === 'open');
    } catch {
      return [];
    }
  }

  /** Fresh, authenticated, ready, compatible and within failure budget. */
  isAvailable(peerId: string): boolean {
    const e = this.peers.get(peerId);
    if (!e || !e.status) return false;
    if (!this.isConnected(peerId)) return false;
    if (this.now() - e.statusAt > this.d.statusTtlMs) return false;
    if (e.failures >= this.d.failuresBeforeUnavailable) return false;
    return e.status.state === 'ready' && e.status.inferenceReady && e.status.models.includes(this.deps.modelFingerprint);
  }

  /** Snapshot used by the router. */
  candidates(): Array<{ peerId: string; status: StatusRecord; rttMs: number }> {
    const out: Array<{ peerId: string; status: StatusRecord; rttMs: number }> = [];
    for (const e of this.peers.values()) {
      if (this.isAvailable(e.peerId)) out.push({ peerId: e.peerId, status: e.status!, rttMs: e.rttMs ?? 50 });
    }
    return out;
  }

  /** Called by the inference client when an attempt to reach a peer fails at connection level. */
  reportFailure(peerId: string, err: string): void {
    const e = this.peers.get(peerId);
    if (!e) return;
    e.failures++;
    e.lastError = err.slice(0, 200);
  }

  get trackedCount(): number {
    return this.peers.size;
  }

  view(): PeerView[] {
    const now = this.now();
    return [...this.peers.values()].map((e) => {
      const conns = this.connectionsOf(e.peerId);
      const relayed = conns.length > 0 && conns.every((c) => c.remoteAddr.toString().includes('/p2p-circuit'));
      return {
        peerId: e.peerId,
        label: this.deps.admission.label(e.peerId),
        authorized: true,
        connected: conns.length > 0,
        direct: conns.length > 0 ? !relayed : null,
        relayed,
        available: this.isAvailable(e.peerId),
        state: e.status?.state ?? null,
        inferenceReady: e.status?.inferenceReady ?? false,
        modelCompatible: e.status ? e.status.models.includes(this.deps.modelFingerprint) : false,
        activeJobs: e.status?.activeJobs ?? null,
        queueLength: e.status?.queueLength ?? null,
        rttMs: e.rttMs === null ? null : Math.round(e.rttMs * 10) / 10,
        lastStatusAgeMs: e.statusAt ? now - e.statusAt : null,
        consecutiveFailures: e.failures,
        lastError: e.lastError,
        addrs: (conns.length ? conns.map((c) => c.remoteAddr.toString()) : [...e.addrs.keys()]).slice(0, LIMITS.maxAddrsPerPeer),
      };
    });
  }

  // ---------------------------------------------------------------- loop

  private tick(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const e of this.peers.values()) {
      if (this.isConnected(e.peerId)) {
        if (!e.probing && now - e.lastProbeAt >= this.d.probeIntervalMs) void this.probe(e);
        if (!e.dialing && now >= e.nextDirectAt && this.onlyRelayed(e.peerId)) void this.upgradeDirect(e);
      } else if (!e.dialing && now >= e.nextDialAt) {
        void this.dial(e);
      }
    }
    if (this.cacheDirty && now - this.lastCacheWrite > 30_000) void this.saveCache(false);
  }

  private scheduleRedial(e: PeerEntry): void {
    // Exponential backoff with full jitter in [0.5, 1.0] x backoff.
    const jittered = e.backoffMs * (0.5 + this.random() * 0.5);
    e.nextDialAt = this.now() + jittered;
    e.backoffMs = Math.min(this.d.reconnectMaxMs, e.backoffMs * 2);
  }

  private dialTargets(e: PeerEntry): Multiaddr[] {
    return [...e.addrs.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, LIMITS.maxAddrsPerPeer)
      .flatMap(([a]) => {
        try {
          return [multiaddr(a)];
        } catch {
          return [];
        }
      });
  }

  private async dial(e: PeerEntry): Promise<void> {
    const targets = this.dialTargets(e);
    if (targets.length === 0) {
      e.nextDialAt = this.now() + this.d.reconnectMaxMs; // wait for a hint
      return;
    }
    e.dialing = true;
    try {
      // Try direct addresses first, then relayed ones.
      const direct = targets.filter((t) => !t.toString().includes('/p2p-circuit'));
      const relayed = targets.filter((t) => t.toString().includes('/p2p-circuit'));
      let lastErr: unknown;
      for (const group of [direct, relayed]) {
        if (group.length === 0) continue;
        try {
          await this.deps.libp2p.dial(group, { signal: AbortSignal.timeout(this.deps.cfg.timeouts.connectMs) });
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
      this.deps.metrics.inc('p2p_dial_ok');
    } catch (err) {
      e.lastError = `dial: ${(err as Error).message}`.slice(0, 200);
      this.deps.metrics.inc('p2p_dial_failed');
      this.scheduleRedial(e);
    } finally {
      e.dialing = false;
    }
  }

  private onlyRelayed(peerId: string): boolean {
    const conns = this.connectionsOf(peerId);
    return conns.length > 0 && conns.every((c) => c.remoteAddr.toString().includes('/p2p-circuit'));
  }

  /**
   * A peer reachable only through a relay may still be directly dialable from
   * our side (e.g. a public node that dialed us via a relay). Direct
   * connections are preferred: lower latency, no relay load, and relay
   * reservations cannot be made over relayed connections.
   */
  private async upgradeDirect(e: PeerEntry): Promise<void> {
    const direct = this.dialTargets(e).filter((t) => !t.toString().includes('/p2p-circuit'));
    if (direct.length === 0) {
      e.nextDirectAt = this.now() + this.d.reconnectMaxMs;
      return;
    }
    e.dialing = true;
    try {
      await this.deps.libp2p.dial(direct, { signal: AbortSignal.timeout(this.deps.cfg.timeouts.connectMs), force: true });
      this.deps.metrics.inc('p2p_direct_upgrade_ok');
      this.deps.log.info({ peer: e.peerId }, 'upgraded relayed peer to a direct connection');
      e.nextDirectAt = this.now() + this.d.reconnectBaseMs;
    } catch {
      // Not directly reachable (NAT); keep using the relay, retry rarely.
      e.nextDirectAt = this.now() + this.d.reconnectMaxMs * (0.5 + this.random() * 0.5);
    } finally {
      e.dialing = false;
    }
  }

  private onConnect(peerId: string): void {
    const e = this.peers.get(peerId);
    if (!e) return;
    e.backoffMs = this.d.reconnectBaseMs;
    e.failures = 0;
    e.lastConnectedAt = this.now();
    e.lastProbeAt = 0; // probe immediately
    this.cacheDirty = true;
    this.deps.log.info({ peer: peerId }, 'peer connected');
    queueMicrotask(() => this.tick());
  }

  private onDisconnect(peerId: string): void {
    const e = this.peers.get(peerId);
    if (!e) return;
    this.deps.log.info({ peer: peerId }, 'peer disconnected');
    this.scheduleRedial(e);
  }

  // ---------------------------------------------------------------- status protocol

  private buildExchange(forPeer: string): StatusExchange {
    return { v: 1, type: 'status', status: this.deps.selfStatus(), hints: this.hintsFor(forPeer) };
  }

  /** Addresses we know for connected authorised peers, from their own identify data. */
  private hintsFor(requester: string): PeerHint[] {
    const hints: PeerHint[] = [];
    for (const e of this.peers.values()) {
      if (hints.length >= LIMITS.maxPeerHints) break;
      if (e.peerId === requester || !this.isConnected(e.peerId)) continue;
      const addrs = this.knownSelfAddrs(e.peerId);
      if (addrs.length) hints.push({ peerId: e.peerId, addrs: addrs.slice(0, LIMITS.maxAddrsPerPeer) });
    }
    return hints;
  }

  /**
   * A peer's own advertised addresses, taken from its authenticated status
   * record, merged with what identify stored in the peer store.
   */
  private knownSelfAddrs(peerId: string): string[] {
    const e = this.peers.get(peerId);
    const fromStatus = e?.status?.addrs ?? [];
    return [...new Set([...fromStatus, ...(this.peerStoreAddrs.get(peerId) ?? [])])]
      .filter((a) => a.length <= LIMITS.maxAddrChars)
      .slice(0, LIMITS.maxAddrsPerPeer);
  }

  private peerStoreAddrs = new Map<string, string[]>();

  private async refreshPeerStoreAddrs(peerId: string): Promise<void> {
    try {
      const p = await this.deps.libp2p.peerStore.get(peerIdFromString(peerId));
      this.peerStoreAddrs.set(
        peerId,
        p.addresses.map((a) => a.multiaddr.toString()).slice(0, LIMITS.maxAddrsPerPeer),
      );
    } catch {
      /* unknown */
    }
  }

  private acceptStatus(fromPeer: string, ex: StatusExchange): void {
    const e = this.peers.get(fromPeer);
    if (!e) return;
    const s = ex.status;
    if (s.peerId !== fromPeer) throw new MeshError('forbidden', 'status peerId does not match authenticated peer');
    if (s.networkId !== this.deps.admission.networkId) throw new MeshError('forbidden', 'network ID mismatch');
    e.status = s;
    e.statusAt = this.now();
    void this.refreshPeerStoreAddrs(fromPeer);
    for (const h of ex.hints) this.acceptHint(fromPeer, h);
  }

  /** Hints only ever become dial candidates for peers WE have authorised. */
  private acceptHint(fromPeer: string, h: PeerHint): void {
    if (h.peerId === this.deps.selfPeerId || h.peerId === fromPeer) return;
    if (!this.deps.admission.isAuthorized(h.peerId)) {
      this.deps.metrics.inc('p2p_hints_ignored_unauthorized');
      return;
    }
    for (const a of h.addrs) this.addAddr(h.peerId, a, 'hint');
    const e = this.peers.get(h.peerId);
    if (e && !this.isConnected(h.peerId) && !e.dialing && e.nextDialAt > this.now() + 1000) {
      e.nextDialAt = this.now(); // new information: try soon
    }
  }

  private async probe(e: PeerEntry): Promise<void> {
    e.probing = true;
    e.lastProbeAt = this.now();
    const signal = AbortSignal.timeout(this.d.probeTimeoutMs);
    let stream: Stream | undefined;
    try {
      stream = await this.deps.libp2p.dialProtocol(peerIdFromString(e.peerId), STATUS_PROTOCOL, { signal, runOnLimitedConnection: true });
      const fs = new FrameStream(stream);
      const t0 = performance.now();
      await fs.write(this.buildExchange(e.peerId), signal);
      const reply = await fs.read(StatusExchange, signal);
      const rtt = performance.now() - t0;
      this.acceptStatus(e.peerId, reply);
      e.rttMs = e.rttMs === null ? rtt : e.rttMs * 0.7 + rtt * 0.3;
      e.failures = 0;
      e.lastError = null;
      await fs.close();
      this.deps.metrics.inc('p2p_probe_ok');
    } catch (err) {
      stream?.abort(new Error('probe failed'));
      e.failures++;
      e.lastError = `probe: ${(err as Error).message}`.slice(0, 200);
      this.deps.metrics.inc('p2p_probe_failed');
      if (e.failures >= this.d.failuresBeforeUnavailable) {
        this.deps.log.warn({ peer: e.peerId, failures: e.failures }, 'peer unavailable after failed probes; disconnecting');
        await this.deps.libp2p.hangUp(peerIdFromString(e.peerId)).catch(() => undefined);
      }
    } finally {
      e.probing = false;
    }
  }

  private async onInboundStatus(stream: Stream, conn: Connection): Promise<void> {
    const remote = conn.remotePeer.toString();
    if (!this.deps.admission.isAuthorized(remote)) {
      this.deps.metrics.inc('p2p_unauthorized_stream');
      stream.abort(new Error('unauthorized'));
      return;
    }
    const fs = new FrameStream(stream);
    const signal = AbortSignal.timeout(this.d.probeTimeoutMs);
    try {
      const ex = await fs.read(StatusExchange, signal);
      this.acceptStatus(remote, ex);
      await fs.write(this.buildExchange(remote), signal);
      await fs.close();
    } catch (err) {
      this.deps.metrics.inc('p2p_bad_status_stream');
      this.deps.log.debug({ peer: remote, err: (err as Error).message }, 'rejected status stream');
      fs.abort('bad status exchange');
    }
  }

  // ---------------------------------------------------------------- cache

  private async loadCache(): Promise<void> {
    try {
      const raw = await readJsonIfExists(join(this.deps.dataDir, FILES.peerCache));
      if (!raw) return;
      const c = CacheSchema.parse(raw);
      const now = this.now();
      for (const p of c.peers) {
        if (now - p.lastSeen > this.d.cacheMaxAgeMs) continue;
        if (!this.deps.admission.isAuthorized(p.peerId)) continue;
        for (const a of p.addrs) this.addAddr(p.peerId, a, 'cache');
      }
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'ignoring unreadable peer cache');
    }
  }

  async saveCache(force: boolean): Promise<void> {
    if (!force && !this.cacheDirty) return;
    this.cacheDirty = false;
    this.lastCacheWrite = this.now();
    const peers = [...this.peers.values()]
      .filter((e) => e.lastConnectedAt > 0 || e.addrs.size > 0)
      .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
      .slice(0, this.d.maxCachedPeers)
      .map((e) => ({
        peerId: e.peerId,
        addrs: [
          ...new Set([
            // Inbound connections come from ephemeral ports; only outbound remote addrs are dialable.
            ...this.connectionsOf(e.peerId).filter((c) => c.direction === 'outbound').map((c) => c.remoteAddr.toString()),
            ...this.knownSelfAddrs(e.peerId),
            ...e.addrs.keys(),
          ]),
        ]
          .filter((a) => a.length <= LIMITS.maxAddrChars)
          .slice(0, LIMITS.maxAddrsPerPeer),
        lastSeen: e.lastConnectedAt || this.now(),
      }));
    try {
      await atomicWriteJson(join(this.deps.dataDir, FILES.peerCache), { version: 1, peers });
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'could not write peer cache');
    }
  }
}
