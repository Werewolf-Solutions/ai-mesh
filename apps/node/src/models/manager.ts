/**
 * ModelManager: which catalog models this node hosts, and their runtimes.
 *
 * Each hosted model gets its own llama.cpp process (loopback only), worker
 * queue and admission limits. The operator can install more models from the
 * vetted catalog: download (resumable, SHA-256 verified) → verify → start →
 * advertise to the mesh. Nothing outside models/catalog can be installed, and
 * peers can never trigger an install: only this node's admin API/CLI can.
 */
import { MeshError, type CatalogModelView } from '@werewolf-mesh/protocol';
import { statfs, unlink } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { NodeConfig } from '../config.js';
import type { Metrics } from '../metrics.js';
import { DEFAULT_MODEL_ID, downloadVerified, loadCatalog, modelFingerprint, modelPath, verifyModel, type CatalogEntry, type RuntimePin } from '../model.js';
import type { InferenceAdapter } from '../runtime/adapter.js';
import { FakeAdapter, fakeFingerprint } from '../runtime/fake.js';
import { LlamaCppAdapter } from '../runtime/llamacpp.js';
import { atomicWriteJson, exists, readJsonIfExists } from '../util/fs.js';
import type { Logger } from '../util/log.js';
import { WorkerPool } from '../worker/pool.js';
import { WorkerService } from '../worker/service.js';
import { detectGpus, estimateVramMB, gpuBinaryPath, gpuBuildInstalled, installGpuBuild, type Accel, type GpuBackend, type GpuInfo } from './gpu.js';

export interface HostedModel {
  entry: CatalogEntry;
  fingerprint: string;
  adapter: InferenceAdapter;
  pool: WorkerPool;
  worker: WorkerService;
  state: 'verifying' | 'starting' | 'serving' | 'failed' | 'stopping';
  detail: string;
}

interface Job {
  phase: 'downloading' | 'verifying' | 'starting';
  done: number;
  total: number;
  ctl: AbortController;
}

const StateFile = z.object({ version: z.literal(1), hosted: z.array(z.string()).max(16), accel: z.enum(['cpu', 'cuda', 'vulkan']).optional() });

/** Synthetic catalog entries for the fake test runtime. */
function fakeEntry(id: string, order: number): CatalogEntry {
  return {
    manifestVersion: 1,
    id,
    displayName: `FAKE ${id}`,
    family: 'fake',
    params: '0',
    order,
    description: 'Deterministic test runtime (not a model).',
    source: { repo: 'none', license: 'none', attribution: 'test only' },
    artifact: { filename: `${id}.gguf`, url: 'https://invalid.example/none', sizeBytes: 1, sha256: '0'.repeat(64), quantization: 'none' },
    chatTemplate: { format: 'none' },
    // Fake models whose ID ends in "-think" support thinking (for effort tests); others do not.
    capabilities: { thinking: id.endsWith('-think') ? 'toggle' : 'none' },
    serving: { contextTokens: 2048, maxOutputTokens: 1024 },
    resources: { ramMB: 1, tested: true },
  };
}

export class ModelManager {
  readonly catalog = new Map<string, CatalogEntry>();
  readonly hosts = new Map<string, HostedModel>();
  private readonly jobs = new Map<string, Job>();
  private readonly failures = new Map<string, string>();
  private hosted: string[] = [];
  /** CPU or GPU backend for this node's runtimes. */
  accel: Accel = 'cpu';
  private runtimeJob: { backend: Accel; phase: 'downloading' | 'restarting'; done: number; total: number; error?: string } | null = null;
  private gpus: GpuInfo[] = [];
  private readonly stateFile: string;
  readonly fake: boolean;

  constructor(
    private readonly deps: {
      cfg: NodeConfig;
      dataDir: string;
      runtimePin: RuntimePin;
      metrics: Metrics;
      log: Logger;
    },
  ) {
    this.fake = deps.cfg.runtime.kind === 'fake';
    this.stateFile = join(deps.dataDir, 'models-state.json');
  }

  async init(): Promise<void> {
    if (this.fake) {
      // Fake catalog = runtime.fakeModels (same on every test node); model.host picks what this node serves.
      this.deps.cfg.runtime.fakeModels.forEach((id, i) => this.catalog.set(id, fakeEntry(id, i)));
      const saved = await readJsonIfExists(this.stateFile).then((r) => (r ? StateFile.parse(r).hosted : null)).catch(() => null);
      const chosen = (saved ?? this.deps.cfg.model.host).filter((id) => this.catalog.has(id));
      this.hosted = chosen.length ? chosen : [...this.deps.cfg.runtime.fakeModels];
      return;
    }
    for (const e of await loadCatalog(this.deps.cfg.model.catalog)) this.catalog.set(e.id, e);
    const state = await readJsonIfExists(this.stateFile).then((r) => (r ? StateFile.parse(r) : null)).catch(() => null);
    const saved = state?.hosted ?? null;
    this.accel = state?.accel ?? (this.deps.cfg.runtime.gpu === 'none' ? 'cpu' : this.deps.cfg.runtime.gpu);
    this.gpus = await detectGpus();
    if (this.accel !== 'cpu' && !gpuBuildInstalled(this.deps.runtimePin, this.accel)) {
      this.deps.log.warn({ accel: this.accel }, 'GPU build not installed; using the CPU until it is (./mesh gpu on)');
      this.accel = 'cpu';
    }
    this.hosted = (saved ?? this.deps.cfg.model.host).filter((id) => {
      if (this.catalog.has(id)) return true;
      this.deps.log.warn({ model: id }, 'hosted model is not in the catalog; ignored');
      return false;
    });
    if (this.deps.cfg.runtime.mode === 'external' && this.hosted.length > 1) {
      this.deps.log.warn('runtime.mode "external" serves exactly one model; hosting only the first');
      this.hosted = this.hosted.slice(0, 1);
    }
  }

  fingerprintOf(e: CatalogEntry): string {
    return this.fake ? fakeFingerprint(e.id) : modelFingerprint(e);
  }

  /** Resolve a request's `model` (catalog ID or fingerprint). */
  resolve(model: string): CatalogEntry | undefined {
    const byId = this.catalog.get(model);
    if (byId) return byId;
    for (const e of this.catalog.values()) if (this.fingerprintOf(e) === model) return e;
    return undefined;
  }

  byFingerprint(fp: string): HostedModel | undefined {
    for (const h of this.hosts.values()) if (h.fingerprint === fp) return h;
    return undefined;
  }

  readyHosts(): HostedModel[] {
    return [...this.hosts.values()].filter((h) => h.state === 'serving' && h.adapter.status().ready && !h.pool.draining);
  }

  /** Start every hosted model, one after another (starting several at once would compete for RAM and disk). */
  async startHosted(): Promise<void> {
    for (const id of this.hosted) {
      await this.startModel(id).catch((err) => this.deps.log.error({ model: id, err: (err as Error).message }, 'model failed to start'));
    }
  }

  private makeAdapter(e: CatalogEntry): InferenceAdapter {
    const cfg = this.deps.cfg;
    if (this.fake) return new FakeAdapter(cfg.runtime.fakeTokenDelayMs);
    return new LlamaCppAdapter({
      name: e.id,
      thinking: e.capabilities.thinking,
      mode: cfg.runtime.mode,
      binary: this.accel === 'cpu' ? cfg.runtime.binary : (gpuBinaryPath(this.deps.runtimePin, this.accel) ?? cfg.runtime.binary),
      gpuLayers: this.accel === 'cpu' ? 0 : cfg.runtime.gpuLayers,
      url: cfg.runtime.url,
      apiKeyFile: cfg.runtime.apiKeyFile,
      modelPath: modelPath(e, cfg.model.dir),
      expectedBuildInfo: this.deps.runtimePin.buildInfo,
      threads: cfg.runtime.threads,
      batchThreads: cfg.runtime.batchThreads,
      contextTokens: e.serving.contextTokens,
      parallel: cfg.worker.maxConcurrency,
      // Server-side cap on generated tokens (thinking + answer); per-request limits are enforced by the mesh.
      maxOutputTokens: e.serving.contextTokens,
      mlock: cfg.runtime.mlock,
      mmap: cfg.runtime.mmap,
      startupTimeoutMs: cfg.runtime.startupTimeoutMs,
      dataDir: this.deps.dataDir,
      log: this.deps.log.child({ component: 'runtime', model: e.id }),
    });
  }

  async startModel(id: string): Promise<HostedModel> {
    const e = this.catalog.get(id);
    if (!e) throw new MeshError('bad_request', `unknown model ${id}`);
    const existing = this.hosts.get(id);
    if (existing && existing.state !== 'failed') return existing;
    const cfg = this.deps.cfg;
    const adapter = this.makeAdapter(e);
    const pool = new WorkerPool(cfg.worker.maxConcurrency, cfg.worker.maxQueue);
    const worker = new WorkerService(
      adapter,
      pool,
      { contextTokens: e.serving.contextTokens, queueTimeoutMs: cfg.worker.queueTimeoutMs, firstTokenMs: cfg.timeouts.firstTokenMs, streamIdleMs: cfg.timeouts.streamIdleMs },
      this.deps.metrics,
      { ttlMs: cfg.worker.dedupTtlMs, maxEntries: cfg.worker.dedupMaxEntries },
    );
    const h: HostedModel = { entry: e, fingerprint: this.fingerprintOf(e), adapter, pool, worker, state: 'verifying', detail: 'verifying model file' };
    this.hosts.set(id, h);
    this.failures.delete(id);
    try {
      if (!this.fake && cfg.runtime.mode === 'spawn') {
        const v = await verifyModel(e, cfg.model.dir);
        if (!v.ok) throw new Error(v.reason === 'absent' ? `model file not installed (${e.artifact.filename})` : `model file failed verification: ${v.detail}`);
        this.deps.log.info({ model: id, ms: v.ms }, 'model verified against its catalog manifest');
      }
      h.state = 'starting';
      h.detail = 'loading into memory';
      const t0 = Date.now();
      await adapter.start();
      h.state = 'serving';
      h.detail = adapter.status().detail;
      this.deps.metrics.sample('runtime_start_ms', Date.now() - t0);
      this.deps.log.info({ model: id, ms: Date.now() - t0 }, 'model ready');
      return h;
    } catch (err) {
      h.state = 'failed';
      h.detail = (err as Error).message.slice(0, 300);
      this.failures.set(id, h.detail);
      await adapter.stop().catch(() => undefined);
      throw err;
    }
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.stateFile, { version: 1, hosted: this.hosted, accel: this.accel });
  }

  /** Resource check before installing/hosting: RAM for all hosted models + this one, and disk for the download. */
  async fit(id: string): Promise<{ ok: boolean; reasons: string[] }> {
    const e = this.catalog.get(id);
    if (!e) return { ok: false, reasons: ['not in the catalog'] };
    if (this.fake) return { ok: true, reasons: [] };
    const reasons: string[] = [];
    const MB = 2 ** 20;
    const others = [...this.hosts.values()].filter((h) => h.entry.id !== id && h.state !== 'failed');
    const total = totalmem() / MB;
    const ramOf = (x: CatalogEntry) => (this.accel === 'cpu' ? x.resources.ramMB : Math.max(512, x.resources.ramMB - this.vramOf(x)));
    const hostedRam = others.reduce((n, h) => n + ramOf(h.entry), 0);
    if (hostedRam + ramOf(e) > total * 0.85) {
      reasons.push(`needs about ${(ramOf(e) / 1024).toFixed(1)} GB of RAM; with the models already running that is more than this machine has (${(total / 1024).toFixed(1)} GB)`);
    } else if (ramOf(e) > freemem() / MB + 256) {
      reasons.push(`needs about ${(ramOf(e) / 1024).toFixed(1)} GB of free RAM; ${(freemem() / 2 ** 30).toFixed(1)} GB is free right now`);
    }
    if (this.accel !== 'cpu') {
      const vram = this.gpus.find((g) => g.vramMB)?.vramMB;
      const used = others.reduce((n, h) => n + this.vramOf(h.entry), 0);
      if (vram && used + this.vramOf(e) > vram * 0.95) {
        reasons.push(`needs about ${(this.vramOf(e) / 1024).toFixed(1)} GB of GPU memory; with the models already on the GPU that is more than its ${(vram / 1024).toFixed(0)} GB (switch it to the CPU or stop another model)`);
      }
    }
    if (!(await exists(modelPath(e, this.deps.cfg.model.dir)))) {
      try {
        const s = await statfs(this.deps.cfg.model.dir);
        const free = (s.bavail * s.bsize) / MB;
        if (free < e.artifact.sizeBytes / MB + 512) reasons.push(`needs ${(e.artifact.sizeBytes / 2 ** 30).toFixed(1)} GB of disk; ${(free / 1024).toFixed(1)} GB free`);
      } catch {
        /* unknown */
      }
    }
    if (this.deps.cfg.runtime.mode === 'external') reasons.push('this node uses an external runtime container and can only serve its configured model');
    if (!this.deps.cfg.model.allowInstall) reasons.push('installing models is disabled on this node (model.allowInstall)');
    return { ok: reasons.length === 0, reasons };
  }

  vramOf(e: CatalogEntry): number {
    return (e.resources as { vramMB?: number }).vramMB ?? estimateVramMB(e.artifact.sizeBytes, e.serving.contextTokens);
  }

  /** What this machine offers and uses: for the operator's GPU switch. */
  async runtimeView() {
    this.gpus = await detectGpus();
    const pin = this.deps.runtimePin as unknown as { gpuBinaries?: Record<string, { requires?: string }> };
    const key = (b: GpuBackend) => `${process.platform}-${process.arch}-${b}`;
    return {
      accel: this.accel,
      gpus: this.gpus,
      builds: (['cuda', 'vulkan'] as const).map((b) => ({
        backend: b,
        pinned: !!pin.gpuBinaries?.[key(b)],
        installed: gpuBuildInstalled(this.deps.runtimePin, b),
        requires: pin.gpuBinaries?.[key(b)]?.requires ?? null,
        usable: this.gpus.some((g) => g.backends.includes(b)),
      })),
      job: this.runtimeJob,
    };
  }

  /**
   * Switch this node between CPU and GPU. Installs the pinned GPU build first
   * if needed (background, verified), then restarts every hosted model on the
   * new backend. Peers see the change on the next status exchange.
   */
  async setAccel(target: Accel): Promise<void> {
    if (this.fake) throw new MeshError('bad_request', 'the fake runtime has no GPU mode');
    if (this.deps.cfg.runtime.mode === 'external') throw new MeshError('bad_request', 'this node uses an external runtime');
    if (target !== 'cpu' && !(await detectGpus()).some((g) => g.backends.includes(target))) {
      throw new MeshError('bad_request', `no GPU usable with ${target} was found on this computer`);
    }
    if (this.runtimeJob && !this.runtimeJob.error) throw new MeshError('bad_request', 'a GPU switch is already in progress');
    const apply = async () => {
      this.runtimeJob = { backend: target, phase: 'restarting', done: 0, total: 0 };
      this.accel = target;
      await this.persist();
      for (const id of [...this.hosted]) {
        const h = this.hosts.get(id);
        if (h) {
          h.state = 'stopping';
          h.pool.draining = true;
          const end = Date.now() + 10_000;
          while ((h.pool.activeCount > 0 || h.pool.queuedCount > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
          await h.adapter.stop().catch(() => undefined);
          this.hosts.delete(id);
        }
        const fit = await this.fit(id);
        if (!fit.ok) {
          // Doesn't fit on the new backend (e.g. an 8B model moving from GPU to CPU): stop it instead of exhausting memory.
          this.hosted = this.hosted.filter((x) => x !== id);
          this.failures.set(id, `stopped when switching to ${target}: ${fit.reasons.join('; ')}`);
          await this.persist();
          this.deps.log.warn({ model: id, reasons: fit.reasons }, 'model does not fit on the new backend; stopped');
          continue;
        }
        await this.startModel(id).catch((err) => this.deps.log.error({ model: id, err: (err as Error).message }, 'model failed to start after switching'));
      }
      this.runtimeJob = null;
      this.deps.log.info({ accel: target }, 'runtimes restarted');
    };
    if (target === 'cpu' || gpuBuildInstalled(this.deps.runtimePin, target)) {
      void apply();
      return;
    }
    const job: { backend: Accel; phase: 'downloading' | 'restarting'; done: number; total: number; error?: string } = { backend: target, phase: 'downloading', done: 0, total: 0 };
    this.runtimeJob = job;
    void (async () => {
      try {
        await installGpuBuild(this.deps.runtimePin, target as GpuBackend, (d, t) => {
          job.done = d;
          job.total = t ?? job.total;
        });
        await apply();
      } catch (err) {
        job.error = (err as Error).message.slice(0, 300);
        this.deps.log.warn({ backend: target, err: job.error }, 'GPU build install failed');
      }
    })();
  }

  /** Download (if needed), verify, start and host a catalog model. Runs in the background; poll views(). */
  async install(id: string): Promise<void> {
    const e = this.catalog.get(id);
    if (!e) throw new MeshError('bad_request', `"${id}" is not in the model catalog`);
    if (this.jobs.has(id)) return;
    if (this.hosts.get(id)?.state === 'serving') return;
    const fit = await this.fit(id);
    if (!fit.ok) throw new MeshError('bad_request', fit.reasons.join('; '));
    const job: Job = { phase: 'downloading', done: 0, total: e.artifact.sizeBytes, ctl: new AbortController() };
    this.jobs.set(id, job);
    this.failures.delete(id);
    void (async () => {
      try {
        const path = modelPath(e, this.deps.cfg.model.dir);
        const present = this.fake ? { ok: true } : await verifyModel(e, this.deps.cfg.model.dir);
        if (!present.ok) {
          this.deps.log.info({ model: id, bytes: e.artifact.sizeBytes }, 'downloading model');
          await downloadVerified(e.artifact.url, path, { sha256: e.artifact.sha256, sizeBytes: e.artifact.sizeBytes }, (d, t) => {
            job.done = d;
            job.total = t ?? job.total;
          }, job.ctl.signal);
        }
        job.phase = 'starting';
        job.done = job.total;
        if (!this.hosted.includes(id)) this.hosted.push(id);
        await this.persist();
        this.hosts.delete(id);
        await this.startModel(id);
        this.deps.metrics.inc('models_installed');
      } catch (err) {
        const msg = job.ctl.signal.aborted ? 'cancelled' : (err as Error).message.slice(0, 300);
        this.failures.set(id, msg);
        this.deps.log.warn({ model: id, err: msg }, 'model install failed');
      } finally {
        this.jobs.delete(id);
      }
    })();
  }

  cancelInstall(id: string): void {
    this.jobs.get(id)?.ctl.abort();
  }

  /** Stop serving a model (keeps the file). Drains first. */
  async unhost(id: string): Promise<void> {
    this.hosted = this.hosted.filter((x) => x !== id);
    await this.persist();
    const h = this.hosts.get(id);
    if (!h) return;
    h.state = 'stopping';
    h.pool.draining = true;
    const end = Date.now() + 10_000;
    while ((h.pool.activeCount > 0 || h.pool.queuedCount > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await h.adapter.stop().catch(() => undefined);
    this.hosts.delete(id);
  }

  /** Delete a model file that is not being served. */
  async remove(id: string): Promise<void> {
    const e = this.catalog.get(id);
    if (!e) throw new MeshError('bad_request', 'unknown model');
    if (this.hosts.has(id) || this.hosted.includes(id)) throw new MeshError('bad_request', 'stop serving the model before deleting it');
    await unlink(modelPath(e, this.deps.cfg.model.dir)).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    for (const j of this.jobs.values()) j.ctl.abort();
    await Promise.all([...this.hosts.values()].map((h) => h.adapter.stop().catch(() => undefined)));
  }

  /** Catalog as seen from this node. `servedBy` counts reachable peers serving each fingerprint. */
  async views(servedBy: (fp: string) => number, admin: boolean): Promise<CatalogModelView[]> {
    const out: CatalogModelView[] = [];
    for (const e of this.catalog.values()) {
      const fp = this.fingerprintOf(e);
      const h = this.hosts.get(e.id);
      const localServing = !!h && h.state === 'serving' && h.adapter.status().ready;
      const v: CatalogModelView = {
        id: e.id,
        name: e.displayName,
        family: e.family,
        params: e.params,
        description: e.description,
        license: e.source.license,
        thinking: e.capabilities.thinking,
        contextTokens: e.serving.contextTokens,
        maxOutputTokens: e.serving.maxOutputTokens,
        downloadBytes: e.artifact.sizeBytes,
        ramMB: e.resources.ramMB,
        vramMB: this.vramOf(e),
        tested: e.resources.tested,
        fingerprint: fp,
        available: { nodes: servedBy(fp) + (localServing ? 1 : 0), local: localServing },
      };
      if (admin) {
        const job = this.jobs.get(e.id);
        let state: NonNullable<CatalogModelView['local']>['state'];
        if (job) state = job.phase === 'downloading' ? 'downloading' : job.phase === 'verifying' ? 'verifying' : 'starting';
        else if (h) state = h.state === 'serving' ? (localServing ? 'serving' : 'starting') : h.state === 'failed' ? 'failed' : h.state === 'stopping' ? 'stopping' : h.state === 'verifying' ? 'verifying' : 'starting';
        else if (this.failures.has(e.id)) state = 'failed';
        else state = this.fake || (await exists(modelPath(e, this.deps.cfg.model.dir))) ? 'installed' : 'not_installed';
        v.local = {
          state,
          ...(job ? { progress: { done: job.done, total: job.total } } : {}),
          ...(this.failures.has(e.id) || h?.state === 'failed' ? { error: this.failures.get(e.id) ?? h?.detail } : {}),
          fit: state === 'serving' ? { ok: true, reasons: [] } : await this.fit(e.id),
        };
      }
      out.push(v);
    }
    return out;
  }

  /** The model used when a request names none: the first ready local model, else the catalog default. */
  defaultModel(servedBy: (fp: string) => number): CatalogEntry | undefined {
    const local = [...this.hosts.values()].find((h) => h.state === 'serving' && h.adapter.status().ready);
    if (local) return local.entry;
    for (const e of this.catalog.values()) if (servedBy(this.fingerprintOf(e)) > 0) return e;
    return this.catalog.get(DEFAULT_MODEL_ID) ?? [...this.catalog.values()][0];
  }
}
