/**
 * @werewolf-mesh/client — HTTP/SSE client with bounded gateway failover.
 *
 * Rules (mirrors the gateway's own policy):
 *  - Gateways are tried in order (last successful first). A gateway is tried at
 *    most once per call, and at most `maxGateways` gateways are tried.
 *  - Failover happens ONLY before any output token has been received.
 *  - Once output has started, a failure — or a stream that ends without the
 *    `[DONE]` marker — yields status "interrupted" with the partial text. The
 *    client never continues or merges an answer from another gateway; the
 *    caller must start a NEW answer (Retry).
 *
 * Works in browsers and Node >= 18 (global fetch + ReadableStream).
 */
import { SseParser, type AgentSourceView, type AgentStepView, type ChatCompletionChunk, type ChatMessage, type CodeRunView } from '@werewolf-mesh/protocol';
export { FarmClient, type FarmJob } from './farm.js';

export interface GatewayConfig {
  url: string;
  /** Client (or admin) bearer token for this gateway. Stored by the caller, never bundled. */
  token?: string;
  label?: string;
}

export interface MeshMeta {
  gatewayUrl: string;
  gatewayPeerId: string | null;
  workerPeerId: string | null;
  route: 'local' | 'remote' | null;
  runtime: string | null;
  attempts: Array<{ workerPeerId: string; route: string; outcome: string }>;
  /** Worker-measured timings from the final chunk (absent on interrupted streams). */
  timings?: { queueMs: number; firstTokenMs: number; totalMs: number };
  /** Model and effort the gateway used. */
  model?: string;
  effort?: string;
  /** Anonymous pack-memory notes the gateway gave the model as context. */
  packNotes?: Array<{ id: string; title: string; solution?: string; similarity: number }>;
  /** Web research the gateway did before answering: the query, what it read, and each step. */
  web?: { query: string | null; sources: AgentSourceView[]; steps: AgentStepView[] };
  /** The code pipeline: each write/test/fix step, then whether the tests passed. */
  code?: { steps: AgentStepView[] } & Partial<CodeRunView>;
}

/** Response of POST /v1/mesh/score. */
export interface ScoreResult {
  rougeL: Array<{ f1: number; precision: number; recall: number }>;
  semantic:
    | { available: true; model: string; cosine: number[]; unrelatedBaseline: number }
    | { available: false; reason: string };
}

export interface GatewayAttempt {
  gatewayUrl: string;
  error: { code: string; message: string; status?: number; retryAfterMs?: number };
}

export type ChatResult =
  | { status: 'completed'; text: string; reasoning: string; finishReason: string; usage?: ChatCompletionChunk['usage']; meta: MeshMeta; gatewayAttempts: GatewayAttempt[] }
  | { status: 'interrupted'; text: string; reasoning: string; error: { code: string; message: string }; meta: MeshMeta; gatewayAttempts: GatewayAttempt[] }
  | { status: 'cancelled'; text: string; meta: MeshMeta | null; gatewayAttempts: GatewayAttempt[] }
  | { status: 'failed'; text: ''; error: { code: string; message: string }; gatewayAttempts: GatewayAttempt[] };

export interface ChatOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Mesh extension: 'auto' | 'local' | peer ID. */
  target?: string;
  /** Catalog model ID (default: the gateway's default). */
  model?: string;
  /** OpenAI reasoning_effort: none = answer directly … high = think longest. */
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** Thinking text as it streams (models with a thinking mode). */
  onReasoning?: (text: string, full: string) => void;
  /** Set false to stop the gateway adding pack-memory notes as context. */
  pack?: boolean;
  /** Web research on the gateway: "on" = always search first, "auto" = when the message asks for it. */
  web?: 'auto' | 'on' | 'off';
  /** Code pipeline on the gateway: "on" = write Python, test it in the sandbox and fix it; "auto" = when the message asks for Python code. */
  code?: 'auto' | 'on' | 'off';
  /** Research or code progress (search, read, write, test, …) before the answer starts. */
  onStep?: (step: AgentStepView, all: AgentStepView[]) => void;
  signal?: AbortSignal;
  onToken?: (text: string, full: string) => void;
  onMeta?: (meta: MeshMeta) => void;
  onGatewayFailed?: (a: GatewayAttempt) => void;
}

export interface ClientOptions {
  /** Max distinct gateways per call (default 3). */
  maxGateways?: number;
  /** Time to wait for response headers (the gateway sends them at the first token). */
  headersTimeoutMs?: number;
  /** Max silence while streaming before declaring the stream interrupted. */
  idleTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** HTTP statuses where another gateway may succeed (no output has been shown). */
const FAILOVER_STATUS = new Set([401, 403, 404, 408, 429, 500, 502, 503, 504]);

const CODE_STEPS = new Set(['write', 'test', 'fix']);

function meshField(o: ChatOptions): { mesh?: Record<string, unknown> } {
  const m: Record<string, unknown> = {};
  if (o.target && o.target !== 'auto') m.target = o.target;
  if (o.pack === false) m.pack = false;
  if (o.web && o.web !== 'off') m.web = o.web;
  if (o.code && o.code !== 'off') m.code = o.code;
  return Object.keys(m).length ? { mesh: m } : {};
}

export class MeshClient {
  private preferred: string | null = null;
  private readonly maxGateways: number;
  private readonly headersTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private gateways: GatewayConfig[],
    opts: ClientOptions = {},
  ) {
    this.maxGateways = Math.max(1, Math.min(opts.maxGateways ?? 3, 10));
    this.headersTimeoutMs = opts.headersTimeoutMs ?? 120_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  }

  setGateways(g: GatewayConfig[]): void {
    this.gateways = g;
  }

  /** Order: last successful gateway first, then configuration order. */
  orderedGateways(): GatewayConfig[] {
    const g = [...this.gateways];
    const i = g.findIndex((x) => x.url === this.preferred);
    if (i > 0) g.unshift(...g.splice(i, 1));
    return g.slice(0, this.maxGateways);
  }

  /**
   * Score candidate texts against a reference on the first reachable gateway
   * (POST /v1/mesh/score). Returns null if no gateway could score.
   */
  async score(reference: string, candidates: string[], signal?: AbortSignal): Promise<(ScoreResult & { gatewayUrl: string }) | null> {
    for (const gw of this.orderedGateways()) {
      try {
        const r = await this.fetchImpl(`${gw.url.replace(/\/$/, '')}/v1/mesh/score`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(gw.token ? { authorization: `Bearer ${gw.token}` } : {}) },
          body: JSON.stringify({ reference, candidates }),
          signal: signal ?? AbortSignal.timeout(30_000),
        });
        if (r.ok) return { ...((await r.json()) as ScoreResult), gatewayUrl: gw.url };
      } catch {
        /* try the next gateway */
      }
    }
    return null;
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const attempts: GatewayAttempt[] = [];
    const list = this.orderedGateways();
    if (list.length === 0) return { status: 'failed', text: '', error: { code: 'no_gateways', message: 'no gateway configured' }, gatewayAttempts: attempts };
    for (const gw of list) {
      if (o.signal?.aborted) return { status: 'cancelled', text: '', meta: null, gatewayAttempts: attempts };
      const r = await this.tryGateway(gw, o);
      if (r.kind === 'failover') {
        attempts.push(r.attempt);
        o.onGatewayFailed?.(r.attempt);
        if (!r.retryable) return { status: 'failed', text: '', error: r.attempt.error, gatewayAttempts: attempts };
        continue;
      }
      if (r.result.status === 'completed') this.preferred = gw.url;
      r.result.gatewayAttempts = attempts;
      return r.result;
    }
    const last = attempts[attempts.length - 1]!;
    return { status: 'failed', text: '', error: { code: last.error.code, message: `all ${attempts.length} gateway(s) failed; last: ${last.error.message}` }, gatewayAttempts: attempts };
  }

  private async tryGateway(
    gw: GatewayConfig,
    o: ChatOptions,
  ): Promise<{ kind: 'failover'; attempt: GatewayAttempt; retryable: boolean } | { kind: 'result'; result: ChatResult }> {
    const base = gw.url.replace(/\/$/, '');
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ctl.abort(), this.headersTimeoutMs);
    const fail = (code: string, message: string, retryable = true, status?: number, retryAfterMs?: number) => ({
      kind: 'failover' as const,
      retryable,
      attempt: { gatewayUrl: gw.url, error: { code, message, ...(status ? { status } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) } },
    });
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(gw.token ? { authorization: `Bearer ${gw.token}` } : {}) },
          body: JSON.stringify({
            messages: o.messages,
            stream: true,
            ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
            ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
            ...(o.model ? { model: o.model } : {}),
            ...(o.effort ? { reasoning_effort: o.effort } : {}),
            ...meshField(o),
          }),
          signal: ctl.signal,
        });
      } catch (err) {
        if (o.signal?.aborted) return { kind: 'result', result: { status: 'cancelled', text: '', meta: null, gatewayAttempts: [] } };
        return fail('gateway_unreachable', ctl.signal.aborted ? `no response within ${this.headersTimeoutMs} ms` : String((err as Error).message ?? err));
      }
      clearTimeout(timer);
      timer = undefined;
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; retry_after_ms?: number } } | null;
        const code = body?.error?.code ?? `http_${res.status}`;
        const retryable = FAILOVER_STATUS.has(res.status) && code !== 'context_exceeded';
        return fail(code, body?.error?.message ?? `HTTP ${res.status}`, retryable, res.status, body?.error?.retry_after_ms);
      }
      const meta: MeshMeta = {
        gatewayUrl: gw.url,
        gatewayPeerId: res.headers.get('x-mesh-gateway'),
        workerPeerId: res.headers.get('x-mesh-worker'),
        route: (res.headers.get('x-mesh-route') as MeshMeta['route']) ?? null,
        runtime: res.headers.get('x-mesh-runtime'),
        attempts: [],
      };
      o.onMeta?.(meta);
      return { kind: 'result', result: await this.consume(res.body, meta, o, ctl) };
    } finally {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async consume(body: ReadableStream<Uint8Array>, meta: MeshMeta, o: ChatOptions, ctl: AbortController): Promise<ChatResult> {
    let text = '';
    let reasoning = '';
    let done = false;
    let finishReason: string | null = null;
    let usage: ChatCompletionChunk['usage'];
    let streamError: { code: string; message: string } | null = null;
    const parser = new SseParser((ev) => {
      if (ev.data === '[DONE]') {
        done = true;
        return;
      }
      let j: (ChatCompletionChunk & { error?: { code: string; message: string } }) | null = null;
      try {
        j = JSON.parse(ev.data);
      } catch {
        streamError = { code: 'protocol_error', message: 'malformed stream event' };
        return;
      }
      if (!j) return;
      if (j.error) {
        streamError = { code: j.error.code ?? 'error', message: j.error.message ?? 'stream error' };
        return;
      }
      const ag = j.mesh?.agent;
      if (ag) {
        const isCode = !!ag.code || (ag.step && CODE_STEPS.has(ag.step.kind));
        const bucket = isCode ? (meta.code ??= { steps: [] }) : (meta.web ??= { query: null, sources: [], steps: [] });
        if (ag.step) {
          // A step replaces the running step of the same kind.
          const i = bucket.steps.findIndex((x) => x.kind === ag.step!.kind && x.status === 'running');
          if (i >= 0) bucket.steps[i] = ag.step;
          else bucket.steps.push(ag.step);
          o.onStep?.(ag.step, [...bucket.steps]);
        }
        if (ag.code) Object.assign(meta.code!, ag.code);
        if (meta.web && ag.sources) meta.web.sources = ag.sources;
        if (meta.web && ag.query !== undefined) meta.web.query = ag.query;
      }
      // The stream may open before a worker is chosen (web research); attribution then arrives with the first text.
      if (j.mesh?.workerPeerId && j.mesh.workerPeerId !== meta.workerPeerId) {
        meta.workerPeerId = j.mesh.workerPeerId;
        meta.route = j.mesh.route;
        o.onMeta?.(meta);
      }
      if (j.mesh?.attempts) meta.attempts = j.mesh.attempts;
      if (j.mesh?.timings) meta.timings = j.mesh.timings;
      const mm = j.mesh as { model?: string; effort?: string } | undefined;
      if (mm?.model) meta.model = mm.model;
      if (mm?.effort) meta.effort = mm.effort;
      const pn = (j.mesh as { packNotes?: MeshMeta['packNotes'] } | undefined)?.packNotes;
      if (pn) meta.packNotes = pn;
      const c = j.choices?.[0];
      const rc = c?.delta?.reasoning_content;
      if (rc) {
        reasoning += rc;
        o.onReasoning?.(rc, reasoning);
      }
      const t = c?.delta?.content;
      if (t) {
        text += t;
        o.onToken?.(t, text);
      }
      if (c?.finish_reason) finishReason = c.finish_reason;
      if (j.usage) usage = j.usage;
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let idleFired = false;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        idleFired = true;
        ctl.abort();
      }, this.idleTimeoutMs);
    };
    try {
      armIdle();
      while (true) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        armIdle();
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* network break: handled below as missing [DONE] */
    } finally {
      if (idle) clearTimeout(idle);
      reader.releaseLock?.();
    }
    if (o.signal?.aborted) return { status: 'cancelled', text, meta, gatewayAttempts: [] };
    if (done && finishReason && !streamError) return { status: 'completed', text, reasoning, finishReason, usage, meta, gatewayAttempts: [] };
    // Failed before any text (e.g. web search unavailable): not an interrupted answer, just no answer.
    if (streamError && !text && !reasoning) return { status: 'failed', text: '', error: streamError, gatewayAttempts: [] };
    const err: { code: string; message: string } = streamError ?? (idleFired
      ? { code: 'stream_idle_timeout', message: `no data for ${this.idleTimeoutMs} ms` }
      : { code: 'interrupted', message: 'stream ended without a completion marker' });
    return { status: 'interrupted', text, reasoning, error: err, meta, gatewayAttempts: [] };
  }
}

export type { ChatMessage };
