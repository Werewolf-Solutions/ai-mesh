/**
 * MeshNode: one full node = inference worker + gateway + peer networking + HTTP API.
 *
 * Startup order: HTTP (liveness) -> model verification -> runtime load (async)
 * -> libp2p + peer manager. Readiness reflects the model, not the process.
 *
 * Shutdown (SIGTERM/SIGINT): stop admitting, advertise `draining`, wait up to
 * `shutdown.graceMs` for active jobs, cancel the rest, persist the peer cache,
 * stop libp2p and the runtime. Identity is never regenerated.
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
import { loadManifest, modelFingerprint, modelPath, verifyModel, type Manifest } from './model.js';
import { buildGater, createHost, installRelayRecovery } from './p2p/host.js';
import { InferClient, InferHandler } from './p2p/infer.js';
import { PeerManager } from './p2p/peers.js';
import type { InferenceAdapter } from './runtime/adapter.js';
import { FakeAdapter, FAKE_FINGERPRINT } from './runtime/fake.js';
import { LlamaCppAdapter } from './runtime/llamacpp.js';
import { Scorer } from './scoring/scorer.js';
import { loadSecrets, TokenChecker } from './secrets.js';
import { createLogger, type Logger } from './util/log.js';
import { SOFTWARE_VERSION } from './version.js';
import { WorkerPool } from './worker/pool.js';
import { WorkerService } from './worker/service.js';

export class MeshNode {
  cfg!: NodeConfig;
  log!: Logger;
  identity!: Identity;
  manifest!: Manifest;
  fingerprint!: string;
  admission!: Admission;
  adapter!: InferenceAdapter;
  pool!: WorkerPool;
  worker!: WorkerService;
  libp2p!: Libp2p;
  peers!: PeerManager;
  gateway!: Gateway;
  http!: FastifyInstance;
  scorer!: Scorer;
  readonly metrics = new Metrics();
  private startedAt = Date.now();
  private state: 'starting' | 'ready' | 'not_ready' | 'draining' = 'starting';
  private modelState: ReadyBody['model'] = 'unverified';
  private modelVerified = false;
  private stopping: Promise<void> | undefined;

  constructor(readonly dataDir: string) {}

  async start(): Promise<void> {
    this.cfg = await loadConfig(this.dataDir);
    this.log = createLogger({ nodeLabel: this.cfg.label });
    this.identity = await loadIdentity(this.dataDir);
    this.manifest = await loadManifest(this.cfg.model.manifest);
    const fake = this.cfg.runtime.kind === 'fake';
    this.fingerprint = fake ? FAKE_FINGERPRINT : modelFingerprint(this.manifest);
    if (fake) this.log.warn('USING THE FAKE TEST RUNTIME: responses are placeholder tokens, not model output');
    const contextTokens = Math.min(this.cfg.runtime.contextTokens, LIMITS.contextTokens);

    this.admission = new Admission(this.dataDir, this.cfg.networkId, this.identity.peerId, (a, r) => this.peers?.onAdmissionChange(a, r));
    await this.admission.load();

    this.adapter = fake
      ? new FakeAdapter(this.cfg.runtime.fakeTokenDelayMs)
      : new LlamaCppAdapter({
          mode: this.cfg.runtime.mode,
          binary: this.cfg.runtime.binary,
          url: this.cfg.runtime.url,
          apiKeyFile: this.cfg.runtime.apiKeyFile,
          modelPath: modelPath(this.manifest, this.cfg.model.dir),
          expectedBuildInfo: this.manifest.runtime.buildInfo,
          threads: this.cfg.runtime.threads,
          batchThreads: this.cfg.runtime.batchThreads,
          contextTokens,
          parallel: this.cfg.worker.maxConcurrency,
          maxOutputTokens: LIMITS.maxOutputTokens,
          mlock: this.cfg.runtime.mlock,
          mmap: this.cfg.runtime.mmap,
          startupTimeoutMs: this.cfg.runtime.startupTimeoutMs,
          dataDir: this.dataDir,
          log: this.log.child({ component: 'runtime' }),
        });
    this.pool = new WorkerPool(this.cfg.worker.maxConcurrency, this.cfg.worker.maxQueue);
    this.worker = new WorkerService(
      this.adapter,
      this.pool,
      { contextTokens, queueTimeoutMs: this.cfg.worker.queueTimeoutMs, firstTokenMs: this.cfg.timeouts.firstTokenMs, streamIdleMs: this.cfg.timeouts.streamIdleMs },
      this.metrics,
      { ttlMs: this.cfg.worker.dedupTtlMs, maxEntries: this.cfg.worker.dedupMaxEntries },
    );

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
      modelFingerprint: this.fingerprint,
      dataDir: this.dataDir,
      log: this.log.child({ component: 'peers' }),
      metrics: this.metrics,
    });
    const client = new InferClient({ libp2p: this.libp2p, selfPeerId: this.identity.peerId, fingerprint: this.fingerprint, cfg: this.cfg, metrics: this.metrics });
    this.gateway = new Gateway({
      selfPeerId: this.identity.peerId,
      worker: this.worker,
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

    // ---- HTTP first, so liveness works while the model loads.
    const secrets = await loadSecrets(this.dataDir);
    this.http = await buildHttpServer({
      cfg: this.cfg,
      log: this.log,
      tokens: new TokenChecker(secrets),
      gateway: this.gateway,
      selfPeerId: this.identity.peerId,
      modelId: fake ? 'fake-test-model' : this.manifest.id,
      fingerprint: this.fingerprint,
      runtimeKind: this.adapter.kind,
      ready: () => this.readyBody(),
      status: () => this.statusView(),
      peers: () => this.peers.view(),
      metrics: () => this.metricsView(),
      modelInfo: () => this.modelInfo(),
      reloadAdmission: () => this.admission.load(),
      score: (reference, candidates) => this.scorer.score(reference, candidates),
      scorerStatus: () => this.scorer.status(),
    });
    await this.http.listen({ host: this.cfg.http.host, port: this.cfg.http.port });

    // ---- peer networking
    await this.libp2p.start();
    await new InferHandler({
      admission: this.admission,
      worker: this.worker,
      fingerprint: this.fingerprint,
      selfPeerId: this.identity.peerId,
      cfg: this.cfg,
      metrics: this.metrics,
      log: this.log.child({ component: 'infer' }),
    }).register(this.libp2p);
    await this.peers.start();
    this.admission.watch(this.cfg.discovery.admissionReloadMs, (err) => this.log.error({ err: (err as Error).message }, 'admission reload failed; keeping previous list'));

    this.log.info(
      {
        peerId: this.identity.peerId,
        networkId: this.cfg.networkId,
        http: `http://${this.cfg.http.host}:${this.cfg.http.port}`,
        listen: this.libp2p.getMultiaddrs().map((m) => m.toString()),
        authorizedPeers: this.admission.list().length,
      },
      'node started',
    );

    // ---- model (after networking, so the node can gateway to peers while loading)
    void this.loadModel(fake).then(() => this.scorer.start());
  }

  private async loadModel(fake: boolean): Promise<void> {
    try {
      if (!fake) {
        this.modelState = 'unverified';
        const t0 = Date.now();
        const v = await verifyModel(this.manifest, this.cfg.model.dir);
        if (!v.ok) {
          this.modelState = v.reason === 'absent' ? 'absent' : 'failed';
          this.state = 'not_ready';
          this.log.error({ reason: v.reason, detail: v.detail }, 'model verification failed; NOT loading. Run: ./mesh model download (or import)');
          return;
        }
        this.modelVerified = true;
        this.log.info({ sha256: v.sha256, ms: v.ms }, 'model verified against manifest');
        this.metrics.sample('model_verify_ms', Date.now() - t0);
      } else {
        this.modelVerified = true;
      }
      this.modelState = 'loading';
      const t1 = Date.now();
      await this.adapter.start();
      const loadMs = Date.now() - t1;
      this.metrics.sample('runtime_start_ms', loadMs);
      this.modelState = 'ready';
      if (this.state === 'starting' || this.state === 'not_ready') this.state = 'ready';
      this.log.info({ ms: loadMs, startupMs: Date.now() - this.startedAt, runtime: this.adapter.kind }, 'local model ready');
    } catch (err) {
      this.modelState = 'failed';
      this.state = 'not_ready';
      this.log.error({ err: (err as Error).message }, 'runtime failed to start');
    }
  }

  private localReady(): boolean {
    return this.adapter.status().ready && this.state !== 'draining';
  }

  statusRecord(): StatusRecord {
    const ready = this.localReady();
    return {
      peerId: this.identity.peerId,
      networkId: this.cfg.networkId,
      protocolVersion: PROTOCOL_VERSION,
      softwareVersion: SOFTWARE_VERSION,
      state: this.state === 'ready' && !ready ? 'not_ready' : this.state,
      inferenceReady: ready,
      models: this.modelVerified ? [this.fingerprint] : [],
      activeJobs: this.pool.activeCount,
      queueLength: this.pool.queuedCount,
      maxConcurrency: this.pool.maxConcurrency,
      maxQueue: this.pool.maxQueue,
      addrs: this.libp2p
        .getMultiaddrs()
        .map((m) => m.toString())
        .filter((a) => a.length <= LIMITS.maxAddrChars)
        .slice(0, LIMITS.maxAddrsPerPeer),
      sentAt: Date.now(),
    };
  }

  readyBody(): ReadyBody {
    const rt = this.adapter.status();
    const model: ReadyBody['model'] = rt.ready ? 'ready' : rt.state === 'failed' ? 'failed' : this.modelState;
    return {
      ready: rt.ready && this.state !== 'draining',
      model,
      serving: this.state === 'draining' ? 'draining' : this.state === 'starting' ? 'starting' : 'accepting',
      canServe: this.state !== 'draining' && this.gateway.canServe(),
    };
  }

  statusView(): NodeStatusView {
    const rt = this.adapter.status();
    const all = this.libp2p.getMultiaddrs().map((m) => m.toString());
    return {
      peerId: this.identity.peerId,
      networkId: this.cfg.networkId,
      softwareVersion: SOFTWARE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Date.now() - this.startedAt,
      state: this.state,
      runtime: { kind: this.adapter.kind, ready: rt.ready, detail: rt.detail },
      model: { id: this.adapter.kind === 'fake' ? 'fake-test-model' : this.manifest.id, fingerprint: this.fingerprint, verified: this.modelVerified },
      worker: { active: this.pool.activeCount, queued: this.pool.queuedCount, maxConcurrency: this.pool.maxConcurrency, maxQueue: this.pool.maxQueue },
      gateway: { inFlight: this.gateway.inFlight, maxInFlight: this.cfg.http.maxInFlight },
      listenAddrs: this.cfg.p2p.listen,
      advertisedAddrs: all,
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
      dedupEntries: this.worker.dedup.size,
    };
  }

  modelInfo(): unknown {
    const m = this.manifest;
    return {
      id: m.id,
      displayName: m.displayName,
      fingerprint: this.fingerprint,
      runtime: this.adapter.kind,
      verified: this.modelVerified,
      license: m.source.license,
      attribution: m.source.attribution,
      artifact: { filename: m.artifact.filename, sha256: m.artifact.sha256, quantization: m.artifact.quantization, repo: m.artifact.repo, revision: m.artifact.revision },
      runtimeBuild: m.runtime.buildInfo,
      execution: 'Replicated inference: every full node holds a complete copy of this model. Adding nodes adds capacity and availability, not model size or pooled memory.',
    };
  }

  /** Graceful shutdown. Safe to call more than once. */
  stop(reason = 'shutdown'): Promise<void> {
    this.stopping ??= (async () => {
      this.log?.info({ reason }, 'draining: no longer admitting jobs');
      this.state = 'draining';
      if (this.pool && this.gateway && this.cfg) {
        this.pool.draining = true;
        const graceEnd = Date.now() + this.cfg.shutdown.graceMs;
        while (Date.now() < graceEnd && (this.pool.activeCount > 0 || this.pool.queuedCount > 0 || this.gateway.inFlight > 0)) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (this.pool.activeCount > 0 || this.gateway.inFlight > 0) {
          this.log.warn('grace period over; cancelling remaining work');
          this.gateway.abortAll(new MeshError('draining', 'node shut down before the job finished'));
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      this.admission?.stop();
      await this.peers?.stop().catch(() => undefined);
      await this.http?.close().catch(() => undefined);
      await Promise.resolve(this.libp2p?.stop()).catch(() => undefined);
      await this.adapter?.stop().catch(() => undefined);
      await this.scorer?.stop().catch(() => undefined);
      this.log?.info('stopped');
    })();
    return this.stopping;
  }
}
