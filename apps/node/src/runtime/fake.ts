/**
 * DETERMINISTIC FAKE RUNTIME — FOR FAULT-INJECTION TESTS ONLY.
 *
 * It produces placeholder tokens, not model output. It is selected only by
 * runtime.kind = "fake" together with MESH_ALLOW_FAKE_RUNTIME=1, advertises a
 * distinct model fingerprint (so real nodes never route to it), and every API
 * response from a node using it is labelled runtime: "fake".
 *
 * Fault directives may appear anywhere in the last user message:
 *   [[fake:tokens=N]]      emit N tokens (default 12)
 *   [[fake:delay=MS]]      per-token delay (default from config)
 *   [[fake:fail_after=K]]  raise a runtime error after K tokens
 *   [[fake:hang_after=K]]  stop producing after K tokens until cancelled
 *   [[fake:crash_after=K]] terminate this whole node process after K tokens
 *   [[fake:slow_start=MS]] wait before the first token
 */
import { MeshError, type ChatMessage, type GenerationSettings } from '@werewolf-mesh/protocol';
import type { GenEvent, InferenceAdapter, RuntimeStatus } from './adapter.js';

export const FAKE_FINGERPRINT = 'fake-test-model:sha256:0000000000000000000000000000000000000000000000000000000000000000';

function directive(text: string, name: string): number | undefined {
  const m = new RegExp(`\\[\\[fake:${name}=(\\d+)\\]\\]`).exec(text);
  return m ? Number(m[1]) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new MeshError('cancelled', 'cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new MeshError('cancelled', 'cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeAdapter implements InferenceAdapter {
  readonly kind = 'fake' as const;
  private ready = false;
  /** Generations currently executing inside the "runtime" (for cancellation tests). */
  running = 0;
  totalStarted = 0;

  constructor(private readonly tokenDelayMs: number) {}

  async start(): Promise<void> {
    this.ready = true;
  }
  async stop(): Promise<void> {
    this.ready = false;
  }
  status(): RuntimeStatus {
    return this.ready
      ? { ready: true, state: 'ready', detail: 'FAKE deterministic test runtime (not a model)' }
      : { ready: false, state: 'stopped', detail: 'FAKE runtime stopped' };
  }

  async countPromptTokens(messages: ChatMessage[]): Promise<number> {
    return 8 + Math.ceil(messages.reduce((n, m) => n + m.content.length + 4, 0) / 4);
  }

  async *generate(messages: ChatMessage[], settings: GenerationSettings, signal: AbortSignal): AsyncIterable<GenEvent> {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const n = Math.min(directive(last, 'tokens') ?? 12, settings.maxTokens);
    const delay = directive(last, 'delay') ?? this.tokenDelayMs;
    const failAfter = directive(last, 'fail_after');
    const hangAfter = directive(last, 'hang_after');
    const crashAfter = directive(last, 'crash_after');
    const slowStart = directive(last, 'slow_start');
    this.running++;
    this.totalStarted++;
    try {
      if (slowStart) await sleep(slowStart, signal);
      for (let i = 0; i < n; i++) {
        if (failAfter !== undefined && i === failAfter) throw new MeshError('runtime_error', 'fake runtime failure');
        if (crashAfter !== undefined && i === crashAfter) {
          process.kill(process.pid, 'SIGKILL');
        }
        if (hangAfter !== undefined && i === hangAfter) await sleep(3_600_000, signal);
        await sleep(delay, signal);
        yield { type: 'token', text: `t${i} ` };
      }
      const prompt = await this.countPromptTokens(messages);
      yield { type: 'done', finishReason: n >= settings.maxTokens ? 'length' : 'stop', usage: { promptTokens: prompt, completionTokens: n } };
    } finally {
      this.running--;
    }
  }
}
