/**
 * /werewolf-mesh/infer/1.0.0
 *
 * Gateway -> worker:  InferRequest, then optionally CancelFrame.
 *                     The gateway keeps its write side open until the job ends;
 *                     remote EOF/reset is treated as cancellation.
 * Worker -> gateway:  exactly one of accepted | rejected, then
 *                     token* followed by exactly one of completed | failed | cancelled.
 *
 * Workers execute locally and NEVER forward a job: the handler only calls
 * WorkerService, and `originPeerId` must equal the authenticated remote peer.
 */
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  CancelFrame,
  INFER_PROTOCOL,
  InferRequest,
  LIMITS,
  MeshError,
  PROTOCOL_VERSION,
  WorkerFrame,
  type ChatMessage,
  type FinishReason,
  type GenerationSettings,
  type Usage,
} from '@werewolf-mesh/protocol';
import type { Admission } from '../admission.js';
import type { NodeConfig } from '../config.js';
import type { Metrics } from '../metrics.js';
import { abortReason, linkedController, Watchdog } from '../util/abort.js';
import type { Logger } from '../util/log.js';
import type { ModelManager } from '../models/manager.js';
import { FrameStream, ProtocolError } from './framing.js';

export type AttemptEvent =
  | { type: 'accepted'; queuePosition: number; promptTokens: number }
  | { type: 'token'; text: string; channel?: 'reasoning' }
  | { type: 'done'; finishReason: FinishReason; usage: Usage; timings?: { queueMs: number; firstTokenMs: number; totalMs: number } };

// -------------------------------------------------------------------- worker side

export class InferHandler {
  constructor(
    private readonly deps: {
      admission: Admission;
      models: ModelManager;
      selfPeerId: string;
      cfg: NodeConfig;
      metrics: Metrics;
      log: Logger;
    },
  ) {}

  async register(libp2p: Libp2p): Promise<void> {
    await libp2p.handle(INFER_PROTOCOL, (s, c) => this.handle(s, c), {
      maxInboundStreams: this.deps.cfg.p2p.maxInboundStreamsPerProtocol,
      runOnLimitedConnection: true,
    });
  }

  async handle(stream: Stream, conn: Connection): Promise<void> {
    const { metrics, log } = this.deps;
    const remote = conn.remotePeer.toString();
    if (!this.deps.admission.isAuthorized(remote)) {
      metrics.inc('p2p_unauthorized_stream');
      stream.abort(new Error('unauthorized'));
      return;
    }
    const fs = new FrameStream(stream);
    let req: InferRequest;
    try {
      req = await fs.read(InferRequest, AbortSignal.timeout(this.deps.cfg.timeouts.connectMs));
    } catch (err) {
      metrics.inc('p2p_malformed_infer');
      log.debug({ peer: remote, err: (err as Error).message }, 'rejected malformed inference frame');
      fs.abort('malformed request');
      return;
    }
    const reject = async (e: MeshError) => {
      metrics.inc(`p2p_infer_rejected_${e.code}`);
      await fs
        .write({ v: PROTOCOL_VERSION, type: 'rejected', requestId: req.requestId, attemptId: req.attemptId, code: e.code, message: e.message.slice(0, LIMITS.maxErrorChars), ...(e.retryAfterMs !== undefined ? { retryAfterMs: Math.round(e.retryAfterMs) } : {}) })
        .catch(() => undefined);
      await fs.close();
    };
    if (req.originPeerId !== remote) return reject(new MeshError('forbidden', 'originPeerId must be the connecting peer (no forwarding)'));
    const host = this.deps.models.byFingerprint(req.model);
    if (!host || host.state !== 'serving') return reject(new MeshError('model_mismatch', 'this worker does not serve that model right now'));

    const ctl = new AbortController();
    let job;
    try {
      job = await host.worker.prepare(
        { requestId: req.requestId, attemptId: req.attemptId, originPeerId: remote, messages: req.messages, settings: req.settings, deadlineMs: req.deadlineMs },
        ctl.signal,
      );
    } catch (err) {
      return reject(err instanceof MeshError ? err : new MeshError('internal', 'worker error'));
    }
    try {
      await fs.write({ v: PROTOCOL_VERSION, type: 'accepted', requestId: req.requestId, attemptId: req.attemptId, workerPeerId: this.deps.selfPeerId, queuePosition: job.queuePosition, promptTokens: job.promptTokens });
    } catch {
      job.abandon();
      fs.abort('write failed');
      return;
    }
    metrics.inc('p2p_infer_accepted');

    // Watch for cancel frames / gateway disappearance while generating.
    let finished = false;
    void (async () => {
      try {
        while (!finished) {
          const f = await fs.read(CancelFrame, ctl.signal);
          if (f.requestId === req.requestId && f.attemptId === req.attemptId) {
            ctl.abort(new MeshError('cancelled', 'cancelled by gateway'));
            return;
          }
        }
      } catch {
        if (!finished) ctl.abort(new MeshError('cancelled', 'gateway closed stream'));
      }
    })();

    let seq = 0;
    try {
      for await (const ev of job.run(ctl.signal)) {
        if (ev.type === 'token') await fs.write({ v: PROTOCOL_VERSION, type: 'token', seq: seq++, text: ev.text, ...(ev.channel ? { channel: ev.channel } : {}) });
        else await fs.write({ v: PROTOCOL_VERSION, type: 'completed', finishReason: ev.finishReason, usage: ev.usage, timings: job.timings });
      }
      metrics.inc('p2p_infer_completed');
    } catch (err) {
      const e = err instanceof MeshError ? err : new MeshError('runtime_error', 'generation failed');
      if (e.code === 'cancelled') {
        metrics.inc('p2p_infer_cancelled');
        await fs.write({ v: PROTOCOL_VERSION, type: 'cancelled' }).catch(() => undefined);
      } else {
        await fs.write({ v: PROTOCOL_VERSION, type: 'failed', code: e.code, message: e.message.slice(0, LIMITS.maxErrorChars) }).catch(() => undefined);
      }
    } finally {
      finished = true;
      ctl.abort();
      await fs.close();
    }
  }
}

// -------------------------------------------------------------------- gateway side

export interface RemoteAttemptSpec {
  /** Model fingerprint to run. */
  model: string;
  requestId: string;
  attemptId: string;
  messages: ChatMessage[];
  settings: GenerationSettings;
  deadlineMs: number;
}

export class InferClient {
  constructor(
    private readonly deps: {
      libp2p: Libp2p;
      selfPeerId: string;
      cfg: NodeConfig;
      metrics: Metrics;
    },
  ) {}

  async *attempt(peerId: string, spec: RemoteAttemptSpec, signal: AbortSignal): AsyncGenerator<AttemptEvent> {
    const { cfg } = this.deps;
    const ctl = linkedController(signal);
    const dog = new Watchdog(ctl);
    let fs: FrameStream | undefined;
    let terminal = false;
    dog.arm(cfg.timeouts.connectMs, () => new MeshError('connect_timeout', `no response from worker within ${cfg.timeouts.connectMs} ms`));
    try {
      let stream: Stream;
      try {
        stream = await this.deps.libp2p.dialProtocol(peerIdFromString(peerId), INFER_PROTOCOL, {
          signal: ctl.signal,
          runOnLimitedConnection: true,
        });
      } catch (err) {
        if (ctl.signal.aborted) throw abortReason(ctl.signal);
        throw new MeshError('worker_unreachable', `cannot open stream: ${(err as Error).message}`.slice(0, 300));
      }
      stream.inactivityTimeout = cfg.timeouts.maxDeadlineMs;
      fs = new FrameStream(stream);
      const req: InferRequest = {
        v: PROTOCOL_VERSION,
        type: 'infer',
        requestId: spec.requestId,
        attemptId: spec.attemptId,
        originPeerId: this.deps.selfPeerId,
        model: spec.model,
        messages: spec.messages,
        settings: spec.settings,
        deadlineMs: Math.max(100, Math.round(spec.deadlineMs)),
      };
      await this.write(fs, req, ctl.signal);

      const first = await this.read(fs, ctl.signal);
      if (first.type === 'rejected') {
        terminal = true;
        throw new MeshError(first.code, `worker rejected: ${first.message}`, first.retryAfterMs);
      }
      if (first.type !== 'accepted') throw new ProtocolError(`expected accepted/rejected, got ${first.type}`);
      if (first.workerPeerId !== peerId) throw new ProtocolError('accepted by unexpected worker identity');
      yield { type: 'accepted', queuePosition: first.queuePosition, promptTokens: first.promptTokens };

      dog.arm(cfg.worker.queueTimeoutMs + cfg.timeouts.firstTokenMs, () => new MeshError('first_token_timeout', 'no first token from worker in time'));
      let expectSeq = 0;
      while (true) {
        const f = await this.read(fs, ctl.signal);
        if (f.type === 'token') {
          if (f.seq !== expectSeq++) throw new ProtocolError('token sequence gap');
          dog.arm(cfg.timeouts.streamIdleMs, () => new MeshError('stream_idle_timeout', `worker silent for ${cfg.timeouts.streamIdleMs} ms`));
          yield { type: 'token', text: f.text, ...(f.channel ? { channel: f.channel } : {}) };
        } else if (f.type === 'completed') {
          terminal = true;
          yield { type: 'done', finishReason: f.finishReason, usage: f.usage, ...(f.timings ? { timings: f.timings } : {}) };
          return;
        } else if (f.type === 'failed') {
          terminal = true;
          throw new MeshError(f.code === 'cancelled' ? 'worker_failed' : f.code, `worker failed: ${f.message}`);
        } else if (f.type === 'cancelled') {
          terminal = true;
          throw new MeshError('cancelled', 'worker reports cancellation');
        } else {
          throw new ProtocolError(`unexpected ${f.type} frame`);
        }
      }
    } finally {
      dog.clear();
      if (fs) {
        if (!terminal) {
          // Best-effort explicit cancel, then close; the worker also treats EOF as cancel.
          await fs
            .write({ v: PROTOCOL_VERSION, type: 'cancel', requestId: spec.requestId, attemptId: spec.attemptId }, AbortSignal.timeout(500))
            .catch(() => undefined);
          fs.abort('attempt ended');
        } else {
          await fs.close();
        }
      }
      ctl.abort();
    }
  }

  private async write(fs: FrameStream, frame: object, signal: AbortSignal): Promise<void> {
    try {
      await fs.write(frame, signal);
    } catch (err) {
      if (signal.aborted) throw abortReason(signal);
      throw new MeshError('worker_unreachable', `write failed: ${(err as Error).message}`.slice(0, 300));
    }
  }

  private async read(fs: FrameStream, signal: AbortSignal): Promise<WorkerFrame> {
    try {
      return await fs.read(WorkerFrame, signal);
    } catch (err) {
      if (signal.aborted) throw abortReason(signal);
      if (err instanceof ProtocolError && /stream ended/.test(err.message)) {
        throw new MeshError('worker_failed', 'worker connection lost');
      }
      throw err;
    }
  }
}
