/**
 * MeshNode: one full node = inference workers (one per hosted model) + gateway
 * + peer networking + pack memory + HTTP API.
 *
 * Startup order: HTTP (liveness) -> libp2p + peer manager -> hosted models are
 * verified and loaded one by one (async). Readiness reflects loaded models, not
 * the process.
 *
 * Shutdown (SIGTERM/SIGINT): stop admitting, advertise `draining`, wait up to
 * `shutdown.graceMs` for active jobs, cancel the rest, persist the peer cache,
 * stop libp2p and the runtimes. Identity is never regenerated.
 */
import type { Libp2p } from '@libp2p/interface';
import type { MetricsView, NodeStatusView, ReadyBody, StatusRecord } from '@werewolf-mesh/protocol';
import { LIMITS, MeshError, PROTOCOL_VERSION } from '@werewolf-mesh/protocol';
import type { FastifyInstance } from 'fastify';
import { Admission } from './admission.js';
import { loadConfig, type NodeConfig } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { buildHttpServer } from './http/server.js';
import { loadIdentity, type Identity } from './identity.js';
import { Metrics } from './metrics.js';
import { loadRuntimePin } from './model.js';
import { ModelManager } from './models/manager.js';
import { buildGater, createHost, installRelayRecovery } from './p2p/host.js';
import { InferClient, InferHandler } from './p2p/infer.js';
import { PeerManager } from './p2p/peers.js';
import { PackMemory } from './pack/memory.js';
import { Scorer } from './scoring/scorer.js';
import { loadSecrets, TokenChecker } from './secrets.js';
import { createLogger, type Logger } from './util/log.js';
import { SOFTWARE_VERSION } from './version.js';

export class MeshNode {
  cfg!: NodeConfig;
  log!: Logger;
  identity!: Identity;
  admission!: Admission;
  models!: ModelManager;
  libp2p!: Libp2p;
  peers!: PeerManager;
  gateway!: Gateway;
  http!: FastifyInstance;
  scorer!: Scorer;
  pack!: PackMemory;
  readonly metrics = new Metrics();
  private startedAt = Date.now();
  private draining = false;
  private started = false;
  private stopping: Promise<void> | undefined;

  constructor(readonly dataDir: string) {}

  async start(): Promise<void> {
    this.cfg = await loadConfig(this.dataDir);
    this.log = createLogger({ nodeLabel: this.cfg.label });
    this.identity = await loadIdentity(this.dataDir);
    const fake = this.cfg.runtime.kind === 'fake';
    if (fake) this.log.warn('USING THE FAKE TEST RUNTIME: responses are placeholder tokens, not model output');

    this.models = new ModelManager({
      cfg: this.cfg,
      dataDir: this.dataDir,
      runtimePin: await loadRuntimePin(this.cfg.model.runtimePin),
      metrics: this.metrics,
      log: this.log.child({ component: 'models' }),
    });
    await this.models.init();

    this.admission = new Admission(this.dataDir, this.cfg.networkId, this.identity.peerId, (a, r) => this.peers?.onAdmissionChange(a, r));
    await this.admission.load();

    // ---- libp2p
    const gater = buildGater(
      (id) => this.admission.isAuthorized(id),
      (id, where) => {
        this.metrics.inc('p2p_denied_unauthorized');
        this.log.debug({ peer: id, where }, 'denied unauthorised peer');
      },
    );
    this.libp2p = await createHost({ cfg: this.cfg, privateKey: this.identity.privateKey, gater });
    if (this.cfg.p2p.useRelays) {
      installRelayRecovery(this.libp2p, {
        wanted: this.cfg.p2p.relayReservations,
        isAuthorized: (id) => this.admission.isAuthorized(id),
        log: this.log.child({ component: 'relay' }),
      });
    }
    this.peers = new PeerManager({
      libp2p: this.libp2p,
      admission: this.admission,
      cfg: this.cfg,
      selfPeerId: this.identity.peerId,
      selfStatus: () => this.statusRecord(),
      modelName: (fp) => this.models.resolve(fp)?.id ?? null,
      dataDir: this.dataDir,
      log: this.log.child({ component: 'peers' }),
      metrics: this.metrics,
    });
    const client = new InferClient({ libp2p: this.libp2p, selfPeerId: this.identity.peerId, cfg: this.cfg, metrics: this.metrics });
    this.gateway = new Gateway({
      selfPeerId: this.identity.peerId,
      models: this.models,
      peers: this.peers,
      client,
      maxInFlight: this.cfg.http.maxInFlight,
      maxAttempts: this.cfg.routing.maxAttempts,
      remotePenalty: this.cfg.routing.remotePenalty,
      timeouts: { firstTokenMs: this.cfg.timeouts.firstTokenMs, streamIdleMs: this.cfg.timeouts.streamIdleMs, queueTimeoutMs: this.cfg.worker.queueTimeoutMs },
      metrics: this.metrics,
      log: this.log.child({ component: 'gateway' }),
    });

    this.scorer = new Scorer({
      enabled: this.cfg.scorer.enabled,
      binary: this.cfg.runtime.binary,
      manifestPath: this.cfg.scorer.manifest,
      modelDir: this.cfg.model.dir,
      dataDir: this.dataDir,
      threads: this.cfg.scorer.threads,
      log: this.log.child({ component: 'scorer' }),
    });

    this.pack = new PackMemory({
      cfg: this.cfg.pack,
      dataDir: this.dataDir,
      libp2p: this.libp2p,
      admission: this.admission,
      peers: this.peers,
      scorer: this.scorer,
      metrics: this.metrics,
      log: this.log.child({ component: 'pack' }),
    });

    // ---- HTTP first, so liveness works while models load.
    const secrets = await loadSecrets(this.dataDir);
    this.http = await buildHttpServer({
      cfg: this.cfg,
      log: this.log,
      tokens: new TokenChecker(secrets),
      gateway: this.gateway,
      selfPeerId: this.identity.peerId,
      runtimeKind: fake ? 'fake' : 'llama.cpp',
      models: this.models,
      servedBy: (fp) => this.peers.countServing(fp),
      ready: () => this.readyBody(),
      status: () => this.statusView(),
      peers: () => this.peers.view(),
      metrics: () => this.metricsView(),
      modelInfo: () => this.modelInfo(),
      reloadAdmission: () => this.admission.load(),
      score: (reference, candidates) => this.scorer.score(reference, candidates),
      scorerStatus: () => this.scorer.status(),
      pack: this.cfg.pack.enabled ? this.pack : null,
    });
    await this.http.listen({ host: this.cfg.http.host, port: this.cfg.http.port });

    // ---- peer networking
    await this.libp2p.start();
    await new InferHandler({
      admission: this.admission,
      models: this.models,
      selfPeerId: this.identity.peerId,
      cfg: this.cfg,
      metrics: this.metrics,
      log: this.log.child({ component: 'infer' }),
    }).register(this.libp2p);
    await this.peers.start();
    if (this.cfg.pack.enabled) await this.pack.start();
    this.admission.watch(this.cfg.discovery.admissionReloadMs, (err) => this.log.error({ err: (err as Error).message }, 'admission reload failed; keeping previous list'));
    this.started = true;

    this.log.info(
      {
        peerId: this.identity.peerId,
        networkId: this.cfg.networkId,
        http: `http://${this.cfg.http.host}:${this.cfg.http.port}`,
        listen: this.libp2p.getMultiaddrs().map((m) => m.toString()),
        authorizedPeers: this.admission.list().length,
        hosting: [...this.models.catalog.keys()].filter((id) => this.models.hosts.has(id) || this.cfg.model.host.includes(id)),
      },
      'node started',
    );

    // ---- models (after networking, so the node can gateway to peers while loading)
    void this.models
      .startHosted()
      .then(() => this.log.info({ startupMs: Date.now() - this.startedAt, ready: this.models.readyHosts().map((h) => h.entry.id) }, 'hosted models loaded'))
      .then(() => this.scorer.start())
      .then(() => this.pack.reindex());
  }

  private totals() {
    let active = 0;
    let queued = 0;
    let maxConcurrency = 0;
    let maxQueue = 0;
    for (const h of this.models.hosts.values()) {
      active += h.pool.activeCount;
      queued += h.pool.queuedCount;
      maxConcurrency += h.pool.maxConcurrency;
      maxQueue += h.pool.maxQueue;
    }
    return { active, queued, maxConcurrency, maxQueue };
  }

  private anyReady(): boolean {
    return !this.draining && this.models.readyHosts().length > 0;
  }

  private nodeState(): StatusRecord['state'] {
    if (this.draining) return 'draining';
    if (this.anyReady()) return 'ready';
    return [...this.models.hosts.values()].some((h) => h.state === 'verifying' || h.state === 'starting') || !this.started ? 'starting' : 'not_ready';
  }

  statusRecord(): StatusRecord {
    const t = this.totals();
    const hosts = [...this.models.hosts.values()];
    return {
      peerId: this.identity.peerId,
      networkId: this.cfg.networkId,
      protocolVersion: PROTOCOL_VERSION,
      softwareVersion: SOFTWARE_VERSION,
      state: this.nodeState(),
      inferenceReady: this.anyReady(),
      models: this.draining ? [] : this.models.readyHosts().map((h) => h.fingerprint).slice(0, LIMITS.maxModelFingerprints),
      modelLoad: hosts.slice(0, LIMITS.maxModelFingerprints).map((h) => ({
        model: h.fingerprint,
        ready: !this.draining && h.state === 'serving' && h.adapter.status().ready && !h.pool.draining,
        active: h.pool.activeCount,
        queued: h.pool.queuedCount,
        maxConcurrency: h.pool.maxConcurrency,
        maxQueue: h.pool.maxQueue,
      })),
      activeJobs: t.active,
      queueLength: t.queued,
      maxConcurrency: t.maxConcurrency,
      maxQueue: t.maxQueue,
      addrs: this.libp2p
        .getMultiaddrs()
        .map((m) => m.toString())
        .filter((a) => a.length <= LIMITS.maxAddrChars)
        .slice(0, LIMITS.maxAddrsPerPeer),
      sentAt: Date.now(),
    };
  }

  readyBody(): ReadyBody {
    const hosts = [...this.models.hosts.values()];
    const model: ReadyBody['model'] = this.anyReady()
      ? 'ready'
      : hosts.some((h) => h.state === 'verifying' || h.state === 'starting')
        ? 'loading'
        : hosts.some((h) => h.state === 'failed')
          ? 'failed'
          : 'absent';
    return {
      ready: this.anyReady(),
      model,
      serving: this.draining ? 'draining' : this.started ? 'accepting' : 'starting',
      canServe: !this.draining && this.gateway.canServe(),
    };
  }

  statusView(): NodeStatusView {
    const hosts = [...this.models.hosts.values()];
    const first = this.models.readyHosts()[0] ?? hosts[0];
    const t = this.totals();
    return {
      peerId: this.identity.peerId,
      networkId: this.cfg.networkId,
      softwareVersion: SOFTWARE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Date.now() - this.startedAt,
      state: this.nodeState(),
      runtime: {
        kind: this.models.fake ? 'fake' : 'llama.cpp',
        ready: this.anyReady(),
        detail: this.models.readyHosts().map((h) => h.adapter.status().detail).join('; ') || first?.detail || 'no model hosted',
      },
      model: { id: first?.entry.id ?? '', fingerprint: first?.fingerprint ?? '', verified: !!first && first.state !== 'failed' && first.state !== 'verifying' },
      models: hosts.map((h) => ({ id: h.entry.id, fingerprint: h.fingerprint, state: h.state, detail: h.detail, active: h.pool.activeCount, queued: h.pool.queuedCount })),
      worker: { active: t.active, queued: t.queued, maxConcurrency: t.maxConcurrency, maxQueue: t.maxQueue },
      gateway: { inFlight: this.gateway.inFlight, maxInFlight: this.cfg.http.maxInFlight },
      listenAddrs: this.cfg.p2p.listen,
      advertisedAddrs: this.libp2p.getMultiaddrs().map((m) => m.toString()),
      relayServer: this.cfg.p2p.relayServer,
      observation: 'local-partial',
    };
  }

  metricsView(): MetricsView {
    const snap = this.metrics.snapshot();
    const mem = process.memoryUsage();
    return {
      counters: snap.counters,
      recent: { ttftMs: snap.windows.ttft_ms ?? [], tokensPerSecond: snap.windows.tokens_per_s ?? [], failoverMs: snap.windows.failover_ms ?? [] },
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      connections: this.libp2p.getConnections().length,
      trackedPeers: this.peers.trackedCount,
      dedupEntries: [...this.models.hosts.values()].reduce((n, h) => n + h.worker.dedup.size, 0),
    };
  }

  modelInfo(): unknown {
    return {
      hosted: [...this.models.hosts.values()].map((h) => ({
        id: h.entry.id,
        displayName: h.entry.displayName,
        fingerprint: h.fingerprint,
        state: h.state,
        license: h.entry.source.license,
        attribution: h.entry.source.attribution,
        artifact: { filename: h.entry.artifact.filename, sha256: h.entry.artifact.sha256, quantization: h.entry.artifact.quantization },
      })),
      execution: 'Replicated inference: every node serving a model holds a complete copy of it. Adding nodes adds capacity and availability, not model size or pooled memory.',
    };
  }

  /** Graceful shutdown. Safe to call more than once. */
  stop(reason = 'shutdown'): Promise<void> {
    this.stopping ??= (async () => {
      this.log?.info({ reason }, 'draining: no longer admitting jobs');
      this.draining = true;
      if (this.models && this.gateway && this.cfg) {
        for (const h of this.models.hosts.values()) h.pool.draining = true;
        const busy = () => this.totals().active > 0 || this.totals().queued > 0 || this.gateway.inFlight > 0;
        const graceEnd = Date.now() + this.cfg.shutdown.graceMs;
        while (Date.now() < graceEnd && busy()) await new Promise((r) => setTimeout(r, 100));
        if (busy()) {
          this.log.warn('grace period over; cancelling remaining work');
          this.gateway.abortAll(new MeshError('draining', 'node shut down before the job finished'));
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      this.admission?.stop();
      await this.pack?.stop().catch(() => undefined);
      await this.peers?.stop().catch(() => undefined);
      await this.http?.close().catch(() => undefined);
      await Promise.resolve(this.libp2p?.stop()).catch(() => undefined);
      await this.models?.stopAll().catch(() => undefined);
      await this.scorer?.stop().catch(() => undefined);
      this.log?.info('stopped');
    })();
    return this.stopping;
  }
}
