/**
 * External engine adapter: serve a model from another inference server that
 * speaks the OpenAI chat API (ds4-server, LM Studio, Ollama, vLLM, …) through
 * the mesh (docs/engines.md).
 *
 * Differences from the pinned llama.cpp runtime, all visible to the operator:
 * - The model file is not verified by the mesh. Its identity is what the
 *   operator declares (optionally with the weights' SHA-256).
 * - Prompt length is estimated (these servers have no standard tokenizer
 *   endpoint); the engine itself rejects prompts that do not fit.
 * - Thinking can only be turned on or off (if the engine supports a switch);
 *   a thinking budget is enforced by stopping the answer when it is used up.
 */
import { MeshError, type ChatMessage, type GenerationSettings } from '@werewolf-mesh/protocol';
import { readFile } from 'node:fs/promises';
import { SseParser } from '@werewolf-mesh/protocol';
import type { Logger } from '../util/log.js';
import type { GenEvent, InferenceAdapter, RuntimeStatus } from './adapter.js';

export interface EngineOptions {
  id: string;
  /** Base URL of the engine, e.g. http://127.0.0.1:8000 (ds4-server's default). */
  url: string;
  /** Model name to send; default: the first model the engine lists. */
  model?: string;
  apiKeyFile?: string;
  /** How to switch thinking off per request, if the engine supports it. */
  thinkingControl: 'none' | 'reasoning_effort' | 'chat_template_kwargs';
  log: Logger;
}

/** Rough prompt size: ~3.5 characters per token plus per-message overhead. Deliberately generous. */
export function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + Math.ceil(m.content.length / 3.5) + 8, 0) + 16;
}

export class EngineAdapter implements InferenceAdapter {
  readonly kind = 'external' as const;
  private state: RuntimeStatus = { ready: false, state: 'stopped', detail: 'not started' };
  private apiKey = '';
  private modelName = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly base: string;

  constructor(private readonly opts: EngineOptions) {
    this.base = opts.url.replace(/\/$/, '');
  }

  status(): RuntimeStatus {
    return { ...this.state };
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async start(): Promise<void> {
    this.state = { ready: false, state: 'loading', detail: `connecting to ${this.base}` };
    // A missing key file is a configuration error; an engine that is not running yet is not.
    this.apiKey = this.opts.apiKeyFile ? (await readFile(this.opts.apiKeyFile, 'utf8')).trim() : '';
    // Keep checking: an engine can start later, go away and come back without the node restarting.
    this.timer = setInterval(() => void this.check().catch(() => undefined), 10_000);
    this.timer.unref();
    await this.check().catch(() => undefined);
  }

  private async check(): Promise<void> {
    try {
      const r = await fetch(`${this.base}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (r.status === 401 || r.status === 403) throw new Error(`the engine refused the API key (HTTP ${r.status})`);
      if (!r.ok) throw new Error(`GET /v1/models answered HTTP ${r.status}`);
      const j = (await r.json()) as { data?: Array<{ id?: string }> };
      const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
      if (this.opts.model && !ids.includes(this.opts.model)) throw new Error(`the engine does not list model "${this.opts.model}" (it lists: ${ids.join(', ') || 'none'})`);
      this.modelName = this.opts.model ?? ids[0] ?? '';
      if (!this.modelName) throw new Error('the engine lists no model');
      if (!this.state.ready) this.opts.log.info({ url: this.base, model: this.modelName }, 'external engine ready');
      this.state = { ready: true, state: 'ready', detail: `external engine at ${this.base} serving ${this.modelName} (not verified by the mesh)` };
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'no answer within 5 s' : (err as Error).message;
      if (this.state.ready) this.opts.log.warn({ url: this.base, err: msg }, 'external engine unavailable');
      this.state = { ready: false, state: 'failed', detail: `external engine at ${this.base}: ${msg}`.slice(0, 300) };
      throw new Error(this.state.detail);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state = { ready: false, state: 'stopped', detail: 'stopped' };
  }

  async countPromptTokens(messages: ChatMessage[]): Promise<number> {
    return estimateTokens(messages);
  }

  async *generate(messages: ChatMessage[], settings: GenerationSettings, signal: AbortSignal): AsyncIterable<GenEvent> {
    const thinkingOff = settings.thinking?.mode === 'off';
    const budget = settings.thinking?.mode === 'on' ? settings.thinking.budget : undefined;
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // Thinking counts against the same limit on most engines, so leave room for it.
      max_tokens: settings.maxTokens + (budget ?? 0),
      ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
      ...(settings.topP !== undefined ? { top_p: settings.topP } : {}),
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
      ...(settings.stop?.length ? { stop: settings.stop } : {}),
      ...(settings.presencePenalty !== undefined ? { presence_penalty: settings.presencePenalty } : {}),
      ...(settings.frequencyPenalty !== undefined ? { frequency_penalty: settings.frequencyPenalty } : {}),
    };
    if (thinkingOff && this.opts.thinkingControl === 'reasoning_effort') body.reasoning_effort = 'none';
    if (thinkingOff && this.opts.thinkingControl === 'chat_template_kwargs') body.chat_template_kwargs = { enable_thinking: false };

    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctl.signal });
    } catch (err) {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) throw signal.reason ?? new MeshError('cancelled', 'cancelled');
      throw new MeshError('runtime_error', `external engine unreachable: ${(err as Error).message}`.slice(0, 300));
    }
    if (!res.ok || !res.body) {
      signal.removeEventListener('abort', onAbort);
      const text = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 400 && /context|too long|exceed/i.test(text)) throw new MeshError('context_exceeded', `the engine says the prompt is too long: ${text}`);
      throw new MeshError('runtime_error', `external engine answered HTTP ${res.status}: ${text}`);
    }

    const queue: GenEvent[] = [];
    let finish: 'stop' | 'length' = 'stop';
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    let reasoningTokens = 0;
    let answerTokens = 0;
    let cut = false;
    let failure: string | null = null;
    const parser = new SseParser((ev) => {
      if (ev.data === '[DONE]') return;
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (j.error) {
        failure = String(j.error.message ?? j.error).slice(0, 200);
        return;
      }
      const c = j.choices?.[0];
      const r = c?.delta?.reasoning_content ?? c?.delta?.reasoning;
      if (typeof r === 'string' && r) {
        if (thinkingOff) return; // the engine thinks anyway: do not show it
        reasoningTokens++;
        if (budget !== undefined && reasoningTokens > budget) {
          cut = true;
          return;
        }
        queue.push({ type: 'token', text: r, channel: 'reasoning' });
      }
      const t = c?.delta?.content;
      if (typeof t === 'string' && t) {
        answerTokens++;
        queue.push({ type: 'token', text: t });
        if (answerTokens >= settings.maxTokens) {
          finish = 'length';
          cut = true;
        }
      }
      if (c?.finish_reason === 'length') finish = 'length';
      if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
    });

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) parser.push(dec.decode(value, { stream: true }));
        while (queue.length) yield queue.shift()!;
        if (failure) throw new MeshError('runtime_error', `external engine error: ${failure}`);
        if (cut) {
          // Thinking budget used up, or the answer limit reached: stop the engine's work.
          if (budget !== undefined && reasoningTokens > budget) finish = 'length';
          ctl.abort(new Error('limit reached'));
          break;
        }
        if (done) break;
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? new MeshError('cancelled', 'cancelled');
      if (err instanceof MeshError) throw err;
      throw new MeshError('runtime_error', `external engine stream broke: ${(err as Error).message}`.slice(0, 300));
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock?.();
    }
    const u = usage as { promptTokens: number; completionTokens: number } | null;
    yield { type: 'done', finishReason: finish, usage: u ?? { promptTokens: estimateTokens(messages), completionTokens: reasoningTokens + answerTokens } };
  }
}
