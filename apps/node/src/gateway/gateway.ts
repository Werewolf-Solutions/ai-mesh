/**
 * Gateway: accepts a client request, picks a worker (itself or a directly
 * connected authorised peer), and streams the result back.
 *
 * Failure policy:
 *  - BEFORE the first token reaches the gateway: up to `maxAttempts - 1`
 *    alternate-worker retries (default 2) within the original deadline. A
 *    worker is never tried twice for the same request.
 *  - AFTER the first token: no retry. The request ends as `interrupted`,
 *    partial output is kept by the client, and no success marker is sent.
 *  - Never speculative/duplicate execution. Timeouts can still leave a slow
 *    worker running briefly after the gateway moved on (cancel is sent).
 */
import { randomUUID } from 'node:crypto';
import { MeshError, type ChatMessage, type FinishReason, type GenerationSettings, type Usage } from '@werewolf-mesh/protocol';
import type { Metrics } from '../metrics.js';
import type { InferClient } from '../p2p/infer.js';
import type { PeerManager } from '../p2p/peers.js';
import { abortReason, deadlineTimer, linkedController } from '../util/abort.js';
import type { Logger } from '../util/log.js';
import type { ModelManager } from '../models/manager.js';
import { PRIOR_TOK_PER_S, rankCandidates, type Candidate } from './router.js';

export interface GatewayRequest {
  /** Fingerprint of the model to run. */
  model: string;
  messages: ChatMessage[];
  settings: GenerationSettings;
  deadlineMs: number;
  /** 'auto' | 'local' | <peerId>: strict pin, no failover to others. */
  target: string;
  /** Optional preferred worker: tried first, normal failover afterwards. */
  prefer?: string;
}

export interface AttemptRecord {
  workerPeerId: string;
  route: 'local' | 'remote';
  outcome: string;
}

export type GatewayEvent =
  | { type: 'first_token'; workerPeerId: string; route: 'local' | 'remote'; attempts: AttemptRecord[]; text: string; channel?: 'reasoning' }
  | { type: 'token'; text: string; channel?: 'reasoning' }
  | {
      type: 'done';
      finishReason: FinishReason;
      usage: Usage;
      workerPeerId: string;
      route: 'local' | 'remote';
      attempts: AttemptRecord[];
      /** Measured by the worker: queue wait, slot start to first token (prompt reading), total. */
      timings?: { queueMs: number; firstTokenMs: number; totalMs: number };
    };

export class GatewayError extends MeshError {
  constructor(
    base: MeshError,
    readonly outputStarted: boolean,
    readonly attempts: AttemptRecord[],
    readonly workerPeerId: string | null,
    readonly route: 'local' | 'remote' | null,
  ) {
    super(base.code, base.message, base.retryAfterMs);
    this.name = 'GatewayError';
  }
}

export class Gateway {
  inFlight = 0;
  private readonly outstanding = new Map<string, number>();
  private readonly active = new Set<AbortController>();
  /** Decode speed this gateway measured, per `${peerId}|${model}` (EWMA, tokens/s). */
  private readonly speeds = new Map<string, number>();

  speedOf(peerId: string, model: string, accelHint: string | undefined): number {
    return this.speeds.get(`${peerId}|${model}`) ?? PRIOR_TOK_PER_S[accelHint ?? 'cpu'] ?? 8;
  }

  /** Best measured speed for a peer across models (display only). */
  bestSpeed(peerId: string): number | null {
    let best: number | null = null;
    for (const [k, v] of this.speeds) if (k.startsWith(`${peerId}|`)) best = Math.max(best ?? 0, v);
    return best === null ? null : Math.round(best * 10) / 10;
  }

  private recordSpeed(peerId: string, model: string, tokens: number, ms: number): void {
    if (tokens < 8 || ms <= 0) return;
    const s = tokens / (ms / 1000);
    const k = `${peerId}|${model}`;
    const prev = this.speeds.get(k);
    this.speeds.set(k, prev === undefined ? s : prev * 0.6 + s * 0.4);
    if (this.speeds.size > 4096) this.speeds.delete(this.speeds.keys().next().value!);
  }

  /** Cancel every in-flight request (used at the end of the shutdown grace period). */
  abortAll(reason: MeshError): void {
    for (const c of this.active) c.abort(reason);
  }

  constructor(
    private readonly deps: {
      selfPeerId: string;
      models: ModelManager;
      peers: PeerManager;
      client: InferClient;
      maxInFlight: number;
      maxAttempts: number;
      remotePenalty: number;
      timeouts: { firstTokenMs: number; streamIdleMs: number; queueTimeoutMs: number };
      metrics: Metrics;
      log: Logger;
    },
  ) {}

  canServe(): boolean {
    return this.deps.models.readyHosts().length > 0 || this.deps.peers.anyAvailable();
  }

  private localHost(model: string) {
    const h = this.deps.models.byFingerprint(model);
    return h && h.state === 'serving' && h.adapter.status().ready && !h.pool.draining ? h : undefined;
  }

  private rank(model: string, exclude: Set<string>): Candidate[] {
    const h = this.localHost(model);
    return rankCandidates({
      selfPeerId: this.deps.selfPeerId,
      local: h
        ? { ready: true, active: h.pool.activeCount, queued: h.pool.queuedCount, maxConcurrency: h.pool.maxConcurrency, maxQueue: h.pool.maxQueue, speed: this.speedOf(this.deps.selfPeerId, model, this.deps.models.accel) }
        : { ready: false, active: 0, queued: 0, maxConcurrency: 1, maxQueue: 0, speed: 1 },
      remotes: this.deps.peers.candidatesFor(model).map((r) => ({ ...r, speed: this.speedOf(r.peerId, model, r.accel) })),
      outstanding: this.outstanding,
      exclude,
      remotePenalty: this.deps.remotePenalty,
    });
  }

  private pick(req: GatewayRequest, tried: Set<string>): Candidate | null {
    const { selfPeerId, peers } = this.deps;
    if (req.target === 'local' || req.target === selfPeerId) {
      if (tried.has(selfPeerId)) return null;
      return { peerId: selfPeerId, route: 'local', score: 0, rttMs: 0 };
    }
    if (req.target !== 'auto') {
      if (tried.has(req.target)) return null;
      if (!peers.isConnected(req.target)) return null;
      return { peerId: req.target, route: 'remote', score: 0, rttMs: 0 };
    }
    if (req.prefer && !tried.has(req.prefer)) {
      if (req.prefer === selfPeerId && this.localHost(req.model)) return { peerId: selfPeerId, route: 'local', score: 0, rttMs: 0 };
      if (req.prefer !== selfPeerId && peers.isConnected(req.prefer)) return { peerId: req.prefer, route: 'remote', score: 0, rttMs: 0 };
    }
    return this.rank(req.model, tried)[0] ?? null;
  }

  async *execute(req: GatewayRequest, signal: AbortSignal): AsyncGenerator<GatewayEvent> {
    const { metrics } = this.deps;
    if (this.inFlight >= this.deps.maxInFlight) {
      metrics.inc('gateway_rejected_busy');
      throw new GatewayError(new MeshError('gateway_busy', `gateway at capacity (${this.deps.maxInFlight} in flight)`, 1000), false, [], null, null);
    }
    this.inFlight++;
    const requestId = randomUUID();
    const started = Date.now();
    const ctl = linkedController(signal);
    this.active.add(ctl);
    const clearDeadline = deadlineTimer(ctl, req.deadlineMs);
    const attempts: AttemptRecord[] = [];
    const tried = new Set<string>();
    let lastError: MeshError | null = null;
    let firstFailureAt: number | null = null;
    metrics.inc('gateway_requests');
    try {
      while (attempts.length < this.deps.maxAttempts) {
        if (ctl.signal.aborted) throw abortReason(ctl.signal);
        const cand = this.pick(req, tried);
        if (!cand) break;
        tried.add(cand.peerId);
        const attemptId = `a${attempts.length + 1}-${randomUUID().slice(0, 8)}`;
        const rec: AttemptRecord = { workerPeerId: cand.peerId, route: cand.route, outcome: 'started' };
        attempts.push(rec);
        if (attempts.length > 1) metrics.inc('gateway_retries');
        let outputStarted = false;
        let firstTokenAt = 0;
        if (cand.route === 'remote') this.outstanding.set(cand.peerId, (this.outstanding.get(cand.peerId) ?? 0) + 1);
        try {
          const remaining = req.deadlineMs - (Date.now() - started);
          const source =
            cand.route === 'local'
              ? this.localAttempt(requestId, attemptId, req, remaining, ctl.signal)
              : this.deps.client.attempt(cand.peerId, { model: req.model, requestId, attemptId, messages: req.messages, settings: req.settings, deadlineMs: remaining }, ctl.signal);
          for await (const ev of source) {
            if (ev.type === 'accepted') continue;
            if (ev.type === 'token') {
              if (!outputStarted) {
                outputStarted = true;
                firstTokenAt = Date.now();
                const ttft = Date.now() - started;
                metrics.sample('ttft_ms', ttft);
                if (firstFailureAt !== null) metrics.sample('failover_ms', Date.now() - firstFailureAt);
                yield { type: 'first_token', workerPeerId: cand.peerId, route: cand.route, attempts, text: ev.text, ...(ev.channel ? { channel: ev.channel } : {}) };
              } else {
                yield { type: 'token', text: ev.text, ...(ev.channel ? { channel: ev.channel } : {}) };
              }
            } else {
              rec.outcome = 'completed';
              this.recordSpeed(cand.peerId, req.model, ev.usage.completionTokens, Date.now() - firstTokenAt);
              const genMs = Date.now() - started;
              if (ev.usage.completionTokens > 0 && genMs > 0) metrics.sample('tokens_per_s', (ev.usage.completionTokens * 1000) / genMs);
              metrics.inc(cand.route === 'local' ? 'gateway_completed_local' : 'gateway_completed_remote');
              yield { type: 'done', finishReason: ev.finishReason, usage: ev.usage, workerPeerId: cand.peerId, route: cand.route, attempts, ...('timings' in ev && ev.timings ? { timings: ev.timings } : {}) };
              return;
            }
          }
          throw new MeshError('protocol_error', 'attempt ended without completion');
        } catch (err) {
          const e = err instanceof MeshError ? err : new MeshError('internal', (err as Error).message ?? 'error');
          rec.outcome = e.code;
          if (outputStarted) {
            metrics.inc(e.code === 'cancelled' ? 'gateway_cancelled' : 'gateway_interrupted');
            throw new GatewayError(
              new MeshError(e.code === 'cancelled' ? 'cancelled' : 'interrupted', `generation interrupted after output began (${e.code}: ${e.message})`),
              true,
              attempts,
              cand.peerId,
              cand.route,
            );
          }
          if (e.code === 'cancelled' || e.code === 'deadline_exceeded' || ctl.signal.aborted) throw e;
          if (['worker_unreachable', 'connect_timeout', 'worker_failed', 'protocol_error'].includes(e.code) && cand.route === 'remote') {
            this.deps.peers.reportFailure(cand.peerId, e.message);
          }
          lastError = e;
          firstFailureAt ??= Date.now();
          this.deps.log.info({ worker: cand.peerId, route: cand.route, code: e.code, attempt: attempts.length }, 'attempt failed before output');
          if (!e.retryable || req.target !== 'auto') throw e;
        } finally {
          if (cand.route === 'remote') {
            const n = (this.outstanding.get(cand.peerId) ?? 1) - 1;
            if (n <= 0) this.outstanding.delete(cand.peerId);
            else this.outstanding.set(cand.peerId, n);
          }
        }
      }
      if (lastError) throw lastError;
      if (req.target !== 'auto') throw new MeshError('no_workers', `target ${req.target} is not reachable`, 5000);
      throw new MeshError('no_workers', 'no node you can reach is running this model right now', 5000);
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      const e = err instanceof MeshError ? err : new MeshError('internal', 'gateway error');
      metrics.inc(`gateway_failed_${e.code}`);
      const last = attempts[attempts.length - 1];
      throw new GatewayError(e, false, attempts, last?.workerPeerId ?? null, last?.route ?? null);
    } finally {
      clearDeadline();
      ctl.abort();
      this.active.delete(ctl);
      this.inFlight--;
    }
  }

  private async *localAttempt(requestId: string, attemptId: string, req: GatewayRequest, deadlineMs: number, signal: AbortSignal) {
    const host = this.localHost(req.model);
    if (!host) throw new MeshError('model_mismatch', 'this node does not serve that model right now');
    const job = await host.worker.prepare(
      { requestId, attemptId, originPeerId: this.deps.selfPeerId, messages: req.messages, settings: req.settings, deadlineMs },
      signal,
    );
    try {
      yield { type: 'accepted' as const, queuePosition: job.queuePosition, promptTokens: job.promptTokens };
      for await (const ev of job.run(signal)) {
        // job.timings is complete by the time the done event is produced
        yield ev.type === 'done' ? { ...ev, timings: { ...job.timings } } : ev;
      }
    } finally {
      job.abandon(); // idempotent; guarantees the slot is freed even if the consumer stopped early
    }
  }
}
