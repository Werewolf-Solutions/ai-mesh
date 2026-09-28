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
import { SseParser, type ChatCompletionChunk, type ChatMessage } from '@werewolf-mesh/protocol';

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
  /** Anonymous pack-memory notes the gateway gave the model as context. */
  packNotes?: Array<{ id: string; title: string; solution?: string; similarity: number }>;
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
  | { status: 'completed'; text: string; finishReason: string; usage?: ChatCompletionChunk['usage']; meta: MeshMeta; gatewayAttempts: GatewayAttempt[] }
  | { status: 'interrupted'; text: string; error: { code: string; message: string }; meta: MeshMeta; gatewayAttempts: GatewayAttempt[] }
  | { status: 'cancelled'; text: string; meta: MeshMeta | null; gatewayAttempts: GatewayAttempt[] }
  | { status: 'failed'; text: ''; error: { code: string; message: string }; gatewayAttempts: GatewayAttempt[] };

export interface ChatOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Mesh extension: 'auto' | 'local' | peer ID. */
  target?: string;
  /** Set false to stop the gateway adding pack-memory notes as context. */
  pack?: boolean;
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
            ...(o.target && o.target !== 'auto' ? { mesh: { target: o.target, ...(o.pack === false ? { pack: false } : {}) } } : o.pack === false ? { mesh: { pack: false } } : {}),
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
      if (j.mesh?.attempts) meta.attempts = j.mesh.attempts;
      if (j.mesh?.timings) meta.timings = j.mesh.timings;
      const pn = (j.mesh as { packNotes?: MeshMeta['packNotes'] } | undefined)?.packNotes;
      if (pn) meta.packNotes = pn;
      const c = j.choices?.[0];
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
    if (done && finishReason && !streamError) return { status: 'completed', text, finishReason, usage, meta, gatewayAttempts: [] };
    const err: { code: string; message: string } = streamError ?? (idleFired
      ? { code: 'stream_idle_timeout', message: `no data for ${this.idleTimeoutMs} ms` }
      : { code: 'interrupted', message: 'stream ended without a completion marker' });
    return { status: 'interrupted', text, error: err, meta, gatewayAttempts: [] };
  }
}

export type { ChatMessage };
