/**
 * Local execution of a single job: readiness, dedup, atomic admission, token
 * budget validation against the real tokenizer, queue wait, generation with
 * first-token / idle / deadline enforcement, and guaranteed slot release.
 *
 * This service never forwards work to another node. Both the local HTTP
 * gateway and the libp2p inference handler call it.
 */
import { MeshError, type ChatMessage, type GenerationSettings, firstTokenAllowanceMs } from '@werewolf-mesh/protocol';
import type { GenEvent, InferenceAdapter } from '../runtime/adapter.js';
import { abortReason, deadlineTimer, linkedController, Watchdog } from '../util/abort.js';
import type { Metrics } from '../metrics.js';
import { DedupCache } from './dedup.js';
import { WorkerPool } from './pool.js';

export interface JobSpec {
  requestId: string;
  attemptId: string;
  originPeerId: string;
  messages: ChatMessage[];
  settings: GenerationSettings;
  deadlineMs: number;
}

export interface WorkerTimeouts {
  contextTokens: number;
  queueTimeoutMs: number;
  firstTokenMs: number;
  streamIdleMs: number;
}

export interface AcceptedJob {
  queuePosition: number;
  promptTokens: number;
  /** Execute. Must be called exactly once; releasing happens automatically. */
  run(signal: AbortSignal): AsyncIterable<GenEvent>;
  /** Release without running (e.g. the caller went away after acceptance). */
  abandon(): void;
  timings: { queueMs: number; firstTokenMs: number; totalMs: number };
}

export class WorkerService {
  readonly dedup: DedupCache;

  constructor(
    readonly adapter: InferenceAdapter,
    readonly pool: WorkerPool,
    private readonly t: WorkerTimeouts,
    private readonly metrics: Metrics,
    dedup: { ttlMs: number; maxEntries: number },
  ) {
    this.dedup = new DedupCache(dedup.ttlMs, dedup.maxEntries);
  }

  async prepare(job: JobSpec, signal: AbortSignal): Promise<AcceptedJob> {
    if (this.pool.draining) throw new MeshError('draining', 'node is draining', 1000);
    if (!this.adapter.status().ready) throw new MeshError('not_ready', 'local model is not ready', 5000);
    if (!this.dedup.claim(`${job.originPeerId}/${job.requestId}`)) {
      throw new MeshError('duplicate', 'request already admitted by this worker');
    }
    const admitted = this.pool.admit();
    if (admitted instanceof MeshError) {
      this.metrics.inc(admitted.code === 'busy' ? 'worker_rejected_busy' : 'worker_rejected_other');
      throw admitted;
    }
    const ticket = admitted;
    let promptTokens: number;
    try {
      promptTokens = await this.adapter.countPromptTokens(job.messages, signal);
    } catch (err) {
      ticket.release();
      if (signal.aborted) throw abortReason(signal);
      throw err instanceof MeshError ? err : new MeshError('runtime_error', 'tokenizer unavailable');
    }
    const thinking = job.settings.thinking?.mode === 'on' ? (job.settings.thinking.budget ?? 0) : 0;
    const budget = promptTokens + job.settings.maxTokens + thinking;
    if (budget > this.t.contextTokens) {
      ticket.release();
      throw new MeshError(
        'context_exceeded',
        `prompt (${promptTokens} tokens) + answer (${job.settings.maxTokens})${thinking ? ` + thinking (${thinking})` : ''} = ${budget} exceeds this model's ${this.t.contextTokens}-token context`,
      );
    }

    const t = this.t;
    const adapter = this.adapter;
    const metrics = this.metrics;
    const receivedAt = Date.now();
    let used = false;
    const timings = { queueMs: 0, firstTokenMs: 0, totalMs: 0 };
    return {
      queuePosition: ticket.position,
      promptTokens,
      timings,
      abandon: () => ticket.release(),
      run(outer: AbortSignal): AsyncIterable<GenEvent> {
        if (used) throw new Error('job already run');
        used = true;
        return (async function* () {
          const ctl = linkedController(outer);
          const clearDeadline = deadlineTimer(ctl, job.deadlineMs - (Date.now() - receivedAt));
          const dog = new Watchdog(ctl);
          metrics.inc('worker_jobs_started');
          try {
            try {
              await ticket.wait(t.queueTimeoutMs, ctl.signal);
            } catch (err) {
              throw ctl.signal.aborted ? abortReason(ctl.signal) : err;
            }
            timings.queueMs = Date.now() - receivedAt;
            const allowance = firstTokenAllowanceMs(t.firstTokenMs, promptTokens);
            dog.arm(allowance, () => new MeshError('first_token_timeout', `no token within ${allowance} ms (prompt: ${promptTokens} tokens)`));
            let first = true;
            try {
              for await (const ev of adapter.generate(job.messages, job.settings, ctl.signal)) {
                if (ev.type === 'token') {
                  if (first) {
                    first = false;
                    timings.firstTokenMs = Date.now() - ticket.startedAt;
                  }
                  dog.arm(t.streamIdleMs, () => new MeshError('stream_idle_timeout', `runtime silent for ${t.streamIdleMs} ms`));
                } else {
                  timings.totalMs = Date.now() - receivedAt;
                }
                yield ev;
              }
            } catch (err) {
              if (ctl.signal.aborted) throw abortReason(ctl.signal);
              throw err;
            }
            metrics.inc('worker_jobs_completed');
          } catch (err) {
            const e = err instanceof MeshError ? err : new MeshError('runtime_error', 'generation failed');
            metrics.inc(e.code === 'cancelled' ? 'worker_jobs_cancelled' : 'worker_jobs_failed');
            throw e;
          } finally {
            dog.clear();
            clearDeadline();
            ticket.release();
            ctl.abort();
          }
        })();
      },
    };
  }
}
