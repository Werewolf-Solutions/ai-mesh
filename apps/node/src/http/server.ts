/**
 * Local HTTP API (Fastify). Separate from peer transport: browsers and HTTP
 * clients talk to an explicitly configured gateway; they never speak libp2p.
 *
 * Access control:
 *  - /health/live, /health/ready: anonymous, minimal information.
 *  - /v1/*:   client token (or admin token), or loopback when trustLoopback.
 *  - /admin/*: admin token, or loopback when trustLoopback.
 *  - Static UI: anonymous (contains no secrets; tokens are entered by the user
 *    and kept in browser storage).
 * Host header allow-list (DNS-rebinding defence) and exact-origin CORS.
 */
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  ChatCompletionRequest,
  IGNORED_OPENAI_FIELDS,
  LIMITS,
  MeshError,
  UNSUPPORTED_OPENAI_FIELDS,
  type ApiErrorBody,
  type ChatCompletionChunk,
  type MetricsView,
  type NodeStatusView,
  type ReadyBody,
  type SystemView,
} from '@werewolf-mesh/protocol';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeConfig } from '../config.js';
import { GatewayError, type AttemptRecord, type Gateway } from '../gateway/gateway.js';
import type { Logger } from '../util/log.js';
import type { TokenChecker } from '../secrets.js';
import type { ScoreResult } from '../scoring/scorer.js';
import type { PackMemory } from '../pack/memory.js';
import type { ModelManager } from '../models/manager.js';
import { planGeneration } from '../models/effort.js';
import type { SplitLender, SplitTunnels } from '../split/split.js';
import type { RewardsLedger, SignedSettlement } from '../rewards/ledger.js';
import { research, wantsWeb, type AgentStep, type Source } from '../agent/research.js';
import { codePipeline, resultNote, wantsCode, type CodeResult } from '../agent/code.js';
import { runPython } from '../agent/sandbox.js';
import { NoteKind, PACK_LIMITS, scrub } from '@werewolf-mesh/protocol';
import { z } from 'zod';

const ShareRequest = z.strictObject({
  kind: NoteKind,
  title: z.string().min(3).max(400),
  problem: z.string().max(3000),
  solution: z.string().min(3).max(6000),
  tags: z.array(z.string().max(PACK_LIMITS.tagChars).regex(/^[\p{L}\p{N} _-]*$/u)).max(PACK_LIMITS.tags),
  withdrawHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const ScoreRequest = z.strictObject({
  reference: z.string().min(1).max(4000),
  candidates: z.array(z.string().max(8000)).min(1).max(20),
});
import { REPO_ROOT } from '../version.js';

export interface HttpDeps {
  cfg: NodeConfig;
  log: Logger;
  tokens: TokenChecker;
  gateway: Gateway;
  selfPeerId: string;
  runtimeKind: 'llama.cpp' | 'fake';
  models: ModelManager;
  /** Reachable peers serving a fingerprint (local, partial view). */
  servedBy: (fingerprint: string) => number;
  ready: () => ReadyBody;
  status: () => NodeStatusView;
  peers: () => unknown;
  metrics: () => MetricsView;
  modelInfo: () => unknown;
  reloadAdmission: () => Promise<void>;
  score: (reference: string, candidates: string[]) => Promise<ScoreResult>;
  scorerStatus: () => { state: string; detail: string };
  pack: PackMemory | null;
  /** This computer's resources (local to the operator; never sent to peers). */
  system: () => Promise<SystemView>;
  rewards?: () => RewardsLedger;
  /** Splitting models across machines (docs/split.md). */
  split?: {
    lender: () => SplitLender;
    tunnels: () => SplitTunnels;
    candidates: () => Promise<Array<{ peerId: string; label: string | null; connected: boolean; lends: boolean; reason: string | null }>>;
  };
  uiDir?: string;
}

type Role = 'admin' | 'client' | null;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

function hostOnly(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0]!.toLowerCase();
}

function errorBody(e: MeshError, extra?: Partial<ApiErrorBody['error']>): ApiErrorBody {
  return {
    error: {
      message: e.message,
      type: e.code,
      code: e.code,
      ...(e.retryAfterMs !== undefined ? { retry_after_ms: Math.round(e.retryAfterMs) } : {}),
      ...extra,
    },
  };
}

function sendError(reply: FastifyReply, e: MeshError, extra?: Partial<ApiErrorBody['error']>): FastifyReply {
  if (e.retryAfterMs !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))));
  return reply.code(e.httpStatus).send(errorBody(e, extra));
}

export async function buildHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const { cfg } = deps;
  const app = Fastify({
    loggerInstance: deps.log.child({ component: 'http' }),
    disableRequestLogging: true,
    bodyLimit: cfg.http.maxBodyBytes,
    trustProxy: false,
  });

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...cfg.http.allowedHosts.map((h) => h.toLowerCase())]);
  const allowAnyHost = cfg.http.allowedHosts.includes('*');
  const allowedOrigins = new Set(cfg.http.allowedOrigins.map((o) => o.replace(/\/$/, '')));

  const isSameOrigin = (origin: string, host: string | undefined) => {
    try {
      return host !== undefined && new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  };

  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    if (!allowAnyHost && (!host || !allowedHosts.has(hostOnly(host)))) {
      return sendError(reply, new MeshError('forbidden', 'Host not allowed; add it to http.allowedHosts'));
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && !isSameOrigin(origin, host)) {
      return sendError(reply, new MeshError('forbidden', 'Origin not allowed; add it to http.allowedOrigins'));
    }
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && allowedOrigins.has(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['x-mesh-worker', 'x-mesh-gateway', 'x-mesh-route', 'x-mesh-runtime', 'retry-after'],
    maxAge: 600,
  });

  const roleOf = (req: FastifyRequest): Role => {
    const token = bearer(req);
    // A presented-but-invalid token is always rejected, even from loopback.
    if (token !== undefined) return deps.tokens.check(token);
    if (cfg.http.trustLoopback && LOOPBACK.has(req.socket.remoteAddress ?? '')) return 'admin';
    return null;
  };
  const requireRole = (need: 'client' | 'admin') => async (req: FastifyRequest, reply: FastifyReply) => {
    const role = roleOf(req);
    if (!role) return sendError(reply, new MeshError('unauthorized', 'missing or invalid bearer token'));
    if (need === 'admin' && role !== 'admin') return sendError(reply, new MeshError('forbidden', 'admin token required'));
  };

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendError(reply, new MeshError('payload_too_large', `body exceeds ${cfg.http.maxBodyBytes} bytes`));
    if (err.statusCode && err.statusCode < 500) return sendError(reply, new MeshError('bad_request', err.message));
    deps.log.error({ err: err.message }, 'unhandled HTTP error');
    return sendError(reply, new MeshError('internal', 'internal error'));
  });

  // ------------------------------------------------------------------ health
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const r = deps.ready();
    return reply.code(r.ready ? 200 : 503).send(r);
  });

  // ------------------------------------------------------------------ OpenAI subset
  /**
   * Models. Default: only models some reachable node is serving (what an
   * OpenAI client can actually use). `?all=1`: the whole vetted catalog with
   * availability, and — for this node's operator — local install state.
   */
  app.get('/v1/models', { preHandler: requireRole('client') }, async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    const views = await deps.models.views(deps.servedBy, roleOf(req) === 'admin');
    return {
      object: 'list',
      data: views
        .filter((v) => all || v.available.nodes > 0)
        .map((v) => ({ id: v.id, object: 'model', created: 0, owned_by: 'werewolf-mesh', mesh: { ...v, runtime: deps.runtimeKind, execution: 'replicated (every serving node holds a full copy)' } })),
    };
  });

  // ------------------------------------------------------------------ model management (this node's operator only)
  app.get('/admin/models', { preHandler: requireRole('admin') }, async () => ({ models: await deps.models.views(deps.servedBy, true) }));
  app.post('/admin/models/:id/install', { preHandler: requireRole('admin') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await deps.models.install(id);
      return { accepted: true };
    } catch (err) {
      return sendError(reply, err instanceof MeshError ? err : new MeshError('internal', (err as Error).message));
    }
  });
  /** CPU/GPU for this node's models (operator only). */
  app.get('/admin/runtime', { preHandler: requireRole('admin') }, async () => deps.models.runtimeView());
  app.post('/admin/runtime', { preHandler: requireRole('admin') }, async (req, reply) => {
    const p = z.strictObject({ accel: z.enum(['cpu', 'cuda', 'vulkan']) }).safeParse(req.body);
    if (!p.success) return sendError(reply, new MeshError('bad_request', 'accel must be cpu, cuda or vulkan'));
    try {
      await deps.models.setAccel(p.data.accel);
      return { accepted: true };
    } catch (err) {
      return sendError(reply, err instanceof MeshError ? err : new MeshError('internal', (err as Error).message));
    }
  });
  app.post('/admin/models/:id/cancel', { preHandler: requireRole('admin') }, async (req) => {
    deps.models.cancelInstall((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/admin/models/:id/unhost', { preHandler: requireRole('admin') }, async (req) => {
    await deps.models.unhost((req.params as { id: string }).id);
    return { ok: true };
  });
  app.delete('/admin/models/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      await deps.models.remove((req.params as { id: string }).id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err instanceof MeshError ? err : new MeshError('internal', (err as Error).message));
    }
  });

  app.post('/v1/chat/completions', { preHandler: requireRole('client') }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(reply, new MeshError('bad_request', 'JSON object body required'));
    }
    const unsupported = UNSUPPORTED_OPENAI_FIELDS.filter((f) => f in body);
    if (unsupported.length) {
      return sendError(reply, new MeshError('unsupported', `unsupported field(s): ${unsupported.join(', ')} (see docs/api.md)`));
    }
    const parsed = ChatCompletionRequest.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return sendError(reply, new MeshError('bad_request', `invalid request: ${i?.path.join('.') || '(body)'}: ${i?.message}`.slice(0, 300)));
    }
    const r = parsed.data;
    const entry = r.model ? deps.models.resolve(r.model) : deps.models.defaultModel(deps.servedBy);
    if (!entry) {
      return sendError(reply, new MeshError('bad_request', `model "${r.model}" is not in the catalog; see GET /v1/models?all=1`));
    }
    const fp = deps.models.fingerprintOf(entry);
    let plan;
    try {
      plan = planGeneration(entry, r.reasoning_effort, r.max_completion_tokens ?? r.max_tokens);
    } catch (err) {
      return sendError(reply, err as MeshError);
    }
    const totalChars = r.messages.reduce((n, m) => n + m.content.length, 0);
    if (totalChars > LIMITS.maxTotalChars) {
      return sendError(reply, new MeshError('payload_too_large', `messages total ${totalChars} chars; limit ${LIMITS.maxTotalChars}`));
    }
    // Web answers carry a long prompt (page text); unless the caller set a budget they get the longest allowed.
    // So do code answers (several rounds of write → test → fix).
    const lastUserText = [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const wantsLong =
      r.mesh?.web === 'on' || (r.mesh?.web === 'auto' && wantsWeb(lastUserText)) || r.mesh?.code === 'on' || (r.mesh?.code === 'auto' && wantsCode(lastUserText));
    const deadlineMs = Math.min(r.mesh?.timeout_ms ?? (wantsLong ? cfg.timeouts.maxDeadlineMs : cfg.timeouts.defaultDeadlineMs), cfg.timeouts.maxDeadlineMs);
    const target = r.mesh?.target ?? 'auto';
    const prefer = (req.headers['x-mesh-prefer'] as string | undefined)?.slice(0, 128);
    const settings = {
      maxTokens: plan.maxTokens,
      ...(plan.thinking ? { thinking: plan.thinking } : {}),
      temperature: r.temperature,
      topP: r.top_p,
      seed: r.seed,
      stop: typeof r.stop === 'string' ? [r.stop] : r.stop,
      presencePenalty: r.presence_penalty,
      frequencyPenalty: r.frequency_penalty,
    };

    const ctl = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) ctl.abort(new MeshError('cancelled', 'client disconnected'));
    };
    reply.raw.on('close', onClose);

    const id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`;
    const created = Math.floor(Date.now() / 1000);

    // Web research (docs/agents.md): runs here, on the node the person asked, before the answer.
    const lastUser = [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const webMode = r.mesh?.web ?? 'off';
    const webCfg = cfg.agent.web;
    let useWeb = webMode === 'on' || (webMode === 'auto' && wantsWeb(lastUser));
    if (useWeb && !webCfg.enabled) {
      if (webMode === 'on') return sendError(reply, new MeshError('bad_request', 'web research is turned off on this node (agent.web.enabled)'));
      useWeb = false;
    }
    if (useWeb && roleOf(req) !== 'admin' && !webCfg.allowClients) {
      if (webMode === 'on') return sendError(reply, new MeshError('forbidden', "web research on this node is only for its operator: searches leave from the operator's own connection"));
      useWeb = false;
    }
    // Code pipeline (docs/agents.md): write → test in the sandbox → fix, on this node.
    const codeMode = r.mesh?.code ?? 'off';
    const codeCfg = cfg.agent.code;
    if (codeMode === 'on' && webMode === 'on') return sendError(reply, new MeshError('bad_request', 'mesh.code "on" and mesh.web "on" cannot be combined'));
    let useCode = codeMode === 'on' || (codeMode === 'auto' && webMode !== 'on' && wantsCode(lastUser));
    if (useCode && !codeCfg.enabled) {
      if (codeMode === 'on') return sendError(reply, new MeshError('bad_request', 'the code sandbox is turned off on this node (agent.code.enabled)'));
      useCode = false;
    }
    if (useCode && roleOf(req) !== 'admin' && !codeCfg.allowClients) {
      if (codeMode === 'on') return sendError(reply, new MeshError('forbidden', "the code sandbox on this node is only for its operator: code runs on the operator's own computer"));
      useCode = false;
    }
    if (useCode) useWeb = false;

    // Pack memory: give the model the most relevant anonymous notes as quoted context.
    let messages = r.messages;
    let packNotes: Array<{ id: string; title: string; solution: string; similarity: number }> = [];
    let web: { query: string | null; sources: Source[]; steps: AgentStep[] } | null = null;
    // Skipped for very long prompts: notes must not push a request over the 2,048-token budget.
    if (!useWeb && !useCode && deps.pack && r.mesh?.pack !== false && totalChars < 3000) {
      const question = [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const found = await deps.pack.relevant(question).catch(() => []);
      if (found.length) {
        // The note text is returned too, so people see the pack's answer even if the model ignores it.
        packNotes = found.map((f) => ({ id: f.note.id, title: f.note.title, solution: f.note.solution.slice(0, 600), similarity: f.similarity }));
        // Keep the caller's own system instructions, after the notes.
        const own = r.messages.filter((m) => m.role === 'system').map((m) => m.content);
        const system = [deps.pack.contextMessage(found), ...own].join('\n\n');
        messages = [{ role: 'system' as const, content: system }, ...r.messages.filter((m) => m.role !== 'system')];
      }
    }
    // ---- streaming (SSE) helpers. Headers are sent at the first token, or at the
    // first research step, so every failure before that is a normal HTTP error.
    let headersSent = false;
    const openStream = (extra: Record<string, string> = {}) => {
      if (headersSent) return;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-mesh-gateway': deps.selfPeerId,
        'x-mesh-runtime': deps.runtimeKind,
        ...extra,
        ...corsHeaders(req, allowedOrigins),
      });
      headersSent = true;
      // SSE comment every 15 s while nothing else is sent (a slow node may read a long prompt for minutes).
      const ka = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) clearInterval(ka);
        else reply.raw.write(': keep-alive\n\n');
      }, 15_000);
      reply.raw.on('close', () => clearInterval(ka));
      reply.raw.on('finish', () => clearInterval(ka));
    };
    const write = async (obj: unknown) => {
      if (reply.raw.destroyed) return;
      const ok = reply.raw.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
      if (!ok && !reply.raw.destroyed) {
        await new Promise<void>((resolve) => {
          const done = () => {
            reply.raw.off('drain', done);
            reply.raw.off('close', done);
            resolve();
          };
          reply.raw.on('drain', done);
          reply.raw.on('close', done);
        });
      }
    };
    const chunk = (delta: ChatCompletionChunk['choices'][0]['delta'], finish: 'stop' | 'length' | null, extra: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: entry.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });
    const agentChunk = (agent: NonNullable<ChatCompletionChunk['mesh']>['agent']) => {
      if (!r.stream) return;
      openStream();
      void write(chunk({}, null, { mesh: { gatewayPeerId: deps.selfPeerId, workerPeerId: null, route: null, agent } }));
    };

    if (useWeb) {
      const steps: AgentStep[] = [];
      const quick = planGeneration(entry, 'none', 40);
      const history = r.messages.filter((m) => m.role !== 'system');
      // Page text that still leaves room for the conversation, the thinking budget and the answer.
      const ctxTokens = entry.serving.contextTokens;
      const reserved = plan.maxTokens + (plan.thinking?.mode === 'on' ? (plan.thinking.budget ?? 0) : 0) + 400 + Math.ceil(totalChars / 3);
      // Capped at ~8,000 characters (~2,300 tokens): on a CPU, reading more takes minutes.
      const budgetChars = Math.max(800, Math.min(8_000, (ctxTokens - reserved) * 3));
      try {
        const found = await research(
          history,
          {
            searxUrl: webCfg.searxUrl,
            maxPages: webCfg.maxPages,
            budgetChars,
            fetch: { maxBytes: webCfg.maxPageBytes, timeoutMs: webCfg.fetchTimeoutMs, allowLoopback: webCfg.unsafeAllowLoopback },
            onStep: (st) => {
              steps.push(st);
              agentChunk({ step: st });
            },
            generate: async (msgs, maxTokens, signal) => {
              let text = '';
              const g = deps.gateway.execute(
                { model: fp, messages: msgs, settings: { maxTokens, ...(quick.thinking ? { thinking: quick.thinking } : {}), temperature: 0.2 }, deadlineMs: Math.min(deadlineMs, 120_000), target },
                signal,
              );
              for await (const ev of g) if ((ev.type === 'first_token' || ev.type === 'token') && ev.channel !== 'reasoning') text += ev.text;
              return text;
            },
          },
          ctl.signal,
        );
        web = { query: found.query, sources: found.sources, steps };
        agentChunk({ sources: found.sources, query: found.query });
        const own = r.messages.filter((m) => m.role === 'system').map((m) => m.content);
        messages = [{ role: 'system' as const, content: [found.context, ...own].join('\n\n') }, ...history];
        const answerStep: AgentStep = { kind: 'answer', status: 'running', text: `Writing the answer with ${entry.displayName}` };
        steps.push(answerStep);
        agentChunk({ step: answerStep });
      } catch (err) {
        if (ctl.signal.aborted) return reply;
        const e = err instanceof MeshError ? err : new MeshError('tool_failed', `web research failed: ${(err as Error).message}`.slice(0, 300));
        reply.raw.off('close', onClose);
        if (!headersSent) return sendError(reply, e);
        await write(errorBody(e, {}));
        reply.raw.end();
        return reply;
      }
    }

    if (useCode) {
      // Room for a solution, its tests and an explanation, whatever the caller's max_tokens.
      const codePlan = planGeneration(entry, r.reasoning_effort, Math.min(Math.max(plan.maxTokens, codeCfg.maxTokens), entry.serving.maxOutputTokens));
      const steps: AgentStep[] = [];
      const until = Date.now() + deadlineMs;
      const used = { prompt: 0, completion: 0 };
      let worker: { peerId: string; route: 'local' | 'remote'; attempts: AttemptRecord[] } | null = null;
      let done: CodeResult;
      const codeView = (x: CodeResult) => ({ passed: x.passed, untested: x.untested, rounds: x.rounds, bestRound: x.bestRound, testsPassed: x.testsPassed, testsTotal: x.testsTotal, failure: x.failure });
      const codeInfo = (res: CodeResult | null) => ({
        gatewayPeerId: deps.selfPeerId,
        workerPeerId: worker?.peerId ?? null,
        route: worker?.route ?? null,
        attempts: worker?.attempts ?? [],
        runtime: entry.family === 'external' ? ('external' as const) : deps.runtimeKind,
        model: entry.id,
        effort: codePlan.effort,
        code: { steps, ...(res ? codeView(res) : {}) },
      });
      try {
        done = await codePipeline(
          r.messages,
          {
            maxRounds: codeCfg.maxRounds,
            modelName: entry.displayName,
            onStep: (st) => {
              steps.push(st);
              agentChunk({ step: st });
            },
            generate: async (msgs, signal) => {
              let text = '';
              const left = until - Date.now();
              if (left < 1000) throw new MeshError('deadline_exceeded', 'the time budget ran out while writing the code');
              // Later rounds go back to the same worker, which still holds the conversation in its cache.
              const g = deps.gateway.execute(
                { model: fp, messages: msgs, settings: { ...settings, maxTokens: codePlan.maxTokens, ...(codePlan.thinking ? { thinking: codePlan.thinking } : {}) }, deadlineMs: left, target, ...((worker?.peerId ?? prefer) ? { prefer: worker?.peerId ?? prefer } : {}) },
                signal,
              );
              for await (const ev of g) {
                if (ev.type === 'first_token' || ev.type === 'token') {
                  if (ev.channel !== 'reasoning') text += ev.text;
                } else {
                  used.prompt += ev.usage.promptTokens;
                  used.completion += ev.usage.completionTokens;
                  worker = { peerId: ev.workerPeerId, route: ev.route, attempts: ev.attempts };
                }
              }
              return text;
            },
            run: (program, signal) =>
              runPython(program, { image: codeCfg.image, timeoutMs: codeCfg.timeoutMs, memoryMb: codeCfg.memoryMb, cpus: codeCfg.cpus, maxOutputBytes: 64 * 1024, signal }),
          },
          ctl.signal,
        );
      } catch (err) {
        reply.raw.off('close', onClose);
        if (ctl.signal.aborted) return reply;
        const e = err instanceof MeshError ? err : new MeshError('tool_failed', `the code pipeline failed: ${(err as Error).message}`.slice(0, 300));
        const g = err instanceof GatewayError ? err : null;
        const info = { ...codeInfo(null), ...(g ? { workerPeerId: g.workerPeerId, route: g.route, attempts: g.attempts } : {}) };
        if (!headersSent) return sendError(reply, e, { mesh: info } as Partial<ApiErrorBody['error']>);
        await write(errorBody(e, { mesh: info }));
        reply.raw.end();
        return reply;
      }
      reply.raw.off('close', onClose);
      const content = done.reply + resultNote(done);
      const usage = { prompt_tokens: used.prompt, completion_tokens: used.completion, total_tokens: used.prompt + used.completion };
      const w = worker as { peerId: string; route: 'local' | 'remote' } | null;
      if (!r.stream) {
        if (w) reply.header('x-mesh-worker', w.peerId).header('x-mesh-route', w.route);
        reply.header('x-mesh-gateway', deps.selfPeerId).header('x-mesh-runtime', deps.runtimeKind);
        return reply.send({ id, object: 'chat.completion', created, model: entry.id, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage, mesh: codeInfo(done) });
      }
      agentChunk({ code: codeView(done) });
      openStream(w ? { 'x-mesh-worker': w.peerId, 'x-mesh-route': w.route } : {});
      await write(chunk({ role: 'assistant', content }, null, { mesh: codeInfo(done) }));
      await write(chunk({}, 'stop', { usage, mesh: codeInfo(done) }));
      await write('[DONE]');
      reply.raw.end();
      return reply;
    }

    const gen = deps.gateway.execute({ model: fp, messages, settings, deadlineMs, target, ...(prefer ? { prefer } : {}) }, ctl.signal);
    const meshInfo = (worker: string | null, route: 'local' | 'remote' | null, attempts: AttemptRecord[]) => ({
      gatewayPeerId: deps.selfPeerId,
      workerPeerId: worker,
      route,
      attempts,
      runtime: entry.family === 'external' ? ('external' as const) : deps.runtimeKind,
      model: entry.id,
      effort: plan.effort,
      ...(packNotes.length ? { packNotes } : {}),
      ...(web ? { web } : {}),
    });

    if (!r.stream) {
      let text = '';
      let reasoning = '';
      try {
        for await (const ev of gen) {
          if (ev.type === 'first_token' || ev.type === 'token') {
            if (ev.channel === 'reasoning') reasoning += ev.text;
            else text += ev.text;
          }
          else {
            reply.header('x-mesh-worker', ev.workerPeerId).header('x-mesh-gateway', deps.selfPeerId).header('x-mesh-route', ev.route).header('x-mesh-runtime', deps.runtimeKind);
            return reply.send({
              id,
              object: 'chat.completion',
              created,
              model: entry.id,
              choices: [{ index: 0, message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: ev.finishReason }],
              usage: { prompt_tokens: ev.usage.promptTokens, completion_tokens: ev.usage.completionTokens, total_tokens: ev.usage.promptTokens + ev.usage.completionTokens },
              mesh: { ...meshInfo(ev.workerPeerId, ev.route, ev.attempts), ...(ev.timings ? { timings: ev.timings } : {}) },
            });
          }
        }
        throw new MeshError('internal', 'generation ended unexpectedly');
      } catch (err) {
        const e = err instanceof MeshError ? err : new MeshError('internal', 'internal error');
        const g = err instanceof GatewayError ? err : null;
        return sendError(reply, e, {
          mesh: meshInfo(g?.workerPeerId ?? null, g?.route ?? null, g?.attempts ?? []),
          ...(g?.outputStarted ? { partial_content: text } : {}),
        } as Partial<ApiErrorBody['error']>);
      } finally {
        reply.raw.off('close', onClose);
      }
    }

    try {
      for await (const ev of gen) {
        if (ev.type === 'first_token') {
          openStream({ 'x-mesh-worker': ev.workerPeerId, 'x-mesh-route': ev.route });
          await write(chunk({ role: 'assistant', ...(ev.channel === 'reasoning' ? { reasoning_content: ev.text } : { content: ev.text }) }, null, { mesh: meshInfo(ev.workerPeerId, ev.route, ev.attempts) }));
        } else if (ev.type === 'token') {
          await write(chunk(ev.channel === 'reasoning' ? { reasoning_content: ev.text } : { content: ev.text }, null));
        } else {
          await write(
            chunk({}, ev.finishReason, {
              usage: { prompt_tokens: ev.usage.promptTokens, completion_tokens: ev.usage.completionTokens, total_tokens: ev.usage.promptTokens + ev.usage.completionTokens },
              mesh: { ...meshInfo(ev.workerPeerId, ev.route, ev.attempts), ...(ev.timings ? { timings: ev.timings } : {}) },
            }),
          );
          await write('[DONE]');
          reply.raw.end();
          return;
        }
      }
    } catch (err) {
      const e = err instanceof MeshError ? err : new MeshError('internal', 'internal error');
      const g = err instanceof GatewayError ? err : null;
      if (!headersSent) {
        if (ctl.signal.aborted && e.code === 'cancelled') return reply; // client already gone
        return sendError(reply, e, { mesh: meshInfo(g?.workerPeerId ?? null, g?.route ?? null, g?.attempts ?? []) });
      }
      // Output already streamed: explicit terminal error, and deliberately NO [DONE].
      if (!reply.raw.destroyed) {
        await write(errorBody(e, { mesh: meshInfo(g?.workerPeerId ?? null, g?.route ?? null, g?.attempts ?? []) }));
        reply.raw.end();
      }
    } finally {
      reply.raw.off('close', onClose);
    }
    return reply;
  });

  // ------------------------------------------------------------------ admin
  app.get('/admin/status', { preHandler: requireRole('admin') }, async () => deps.status());
  app.get('/admin/peers', { preHandler: requireRole('admin') }, async () => ({ observation: 'local-partial', peers: deps.peers() }));
  app.get('/admin/metrics', { preHandler: requireRole('admin') }, async () => deps.metrics());
  app.get('/admin/model', { preHandler: requireRole('admin') }, async () => deps.modelInfo());
  app.get('/admin/system', { preHandler: requireRole('admin') }, async () => deps.system());

  // ---- WLF rewards (operator only; docs/rewards.md)
  app.get('/admin/rewards', { preHandler: requireRole('admin') }, async (_req, reply) => {
    if (!deps.rewards) return sendError(reply, new MeshError('bad_request', 'rewards are not available'));
    const l = deps.rewards();
    return { ...(await l.status()), settler: cfg.rewards.settler ?? null, balance: await l.settlements.balance() };
  });
  app.get('/admin/rewards/bundle', { preHandler: requireRole('admin') }, async (_req, reply) => {
    if (!deps.rewards) return sendError(reply, new MeshError('bad_request', 'rewards are not available'));
    return deps.rewards().bundle();
  });
  app.post('/admin/rewards/settlement', { preHandler: requireRole('admin'), bodyLimit: 16 * 2 ** 20 }, async (req, reply) => {
    if (!deps.rewards) return sendError(reply, new MeshError('bad_request', 'rewards are not available'));
    try {
      return await deps.rewards().settlements.import(req.body as SignedSettlement);
    } catch (err) {
      return sendError(reply, new MeshError('bad_request', (err as Error).message.slice(0, 300)));
    }
  });

  // ---- external engines (operator only): ds4-server, LM Studio, Ollama, vLLM …
  app.get('/admin/engines', { preHandler: requireRole('admin') }, async () => ({
    engines: deps.models.engineList().map((c) => ({ ...c, status: deps.models.hosts.get(c.id)?.adapter.status() ?? null, fingerprint: deps.models.fingerprintOf(deps.models.catalog.get(c.id)!) })),
  }));
  app.post('/admin/engines', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      await deps.models.addEngine(req.body as never);
      const c = deps.models.engineList().find((x) => x.id === (req.body as { id?: string }).id);
      return { added: c?.id, status: deps.models.hosts.get(c!.id)?.adapter.status() ?? null };
    } catch (err) {
      const e = err as Error & { issues?: Array<{ path: unknown[]; message: string }> };
      const msg = e.issues?.[0] ? `${e.issues[0].path.join('.')}: ${e.issues[0].message}` : e.message;
      return sendError(reply, err instanceof MeshError ? err : new MeshError('bad_request', `invalid engine: ${msg}`.slice(0, 300)));
    }
  });
  app.delete('/admin/engines/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    try {
      await deps.models.removeEngine((req.params as { id: string }).id);
      return { removed: true };
    } catch (err) {
      return sendError(reply, err instanceof MeshError ? err : new MeshError('bad_request', (err as Error).message));
    }
  });

  // ---- splitting a model across machines (operator only)
  const PeerList = z.array(z.string().min(10).max(128)).max(64);
  app.get('/admin/split', { preHandler: requireRole('admin') }, async (_req, reply) => {
    if (!deps.split) return sendError(reply, new MeshError('bad_request', 'splitting is not available on this node'));
    return {
      accel: deps.models.accel,
      lend: deps.split.lender().view(),
      borrow: { tunnels: { ...deps.split.tunnels().stats }, peers: await deps.split.candidates() },
      models: [...deps.models.catalog.keys()].map((id) => ({ id, split: deps.models.splitOf(id) })).filter((m) => m.split.length),
    };
  });
  app.post('/admin/split/lend', { preHandler: requireRole('admin') }, async (req, reply) => {
    if (!deps.split) return sendError(reply, new MeshError('bad_request', 'splitting is not available on this node'));
    const p = z.strictObject({ enabled: z.boolean().optional(), peers: PeerList.optional(), device: z.enum(['cpu', 'gpu']).optional() }).safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, new MeshError('bad_request', `invalid body: ${p.error.issues[0]?.message}`));
    try {
      return await deps.split.lender().configure(p.data);
    } catch (err) {
      return sendError(reply, new MeshError('bad_request', (err as Error).message.slice(0, 300)));
    }
  });
  app.post('/admin/models/:id/split', { preHandler: requireRole('admin') }, async (req, reply) => {
    const p = z.strictObject({ peers: PeerList.max(8), localShare: z.number().min(0).max(1).optional() }).safeParse(req.body ?? {});
    if (!p.success) return sendError(reply, new MeshError('bad_request', `invalid body: ${p.error.issues[0]?.message}`));
    try {
      // Restarting takes a while; answer at once and let the caller poll /admin/models.
      const id = (req.params as { id: string }).id;
      if (!deps.models.catalog.has(id)) throw new MeshError('bad_request', `unknown model ${id}`);
      if (deps.runtimeKind === 'fake') throw new MeshError('bad_request', 'the fake runtime cannot be split');
      if (cfg.runtime.mode === 'external') throw new MeshError('bad_request', 'this node uses an external runtime');
      void deps.models.setSplit(id, p.data.peers, p.data.localShare).catch((err) => deps.log.error({ model: id, err: (err as Error).message }, 'split change failed'));
      return { accepted: true, split: p.data.peers };
    } catch (err) {
      return sendError(reply, err instanceof MeshError ? err : new MeshError('bad_request', (err as Error).message));
    }
  });
  app.post('/admin/reload-admission', { preHandler: requireRole('admin') }, async () => {
    await deps.reloadAdmission();
    return { ok: true };
  });
  /**
   * Compare texts with a reference (used by the UI's reading test). Runs on
   * THIS node only: ROUGE-L always, embedding similarity when the scorer model
   * is installed. Bounded input; the texts are not logged or stored.
   */
  app.post('/v1/mesh/score', { preHandler: requireRole('client') }, async (req, reply) => {
    const parsed = ScoreRequest.safeParse(req.body);
    if (!parsed.success) return sendError(reply, new MeshError('bad_request', `invalid score request: ${parsed.error.issues[0]?.message ?? ''}`));
    return deps.score(parsed.data.reference, parsed.data.candidates);
  });
  app.get('/v1/mesh/scorer', { preHandler: requireRole('client') }, async () => deps.scorerStatus());

  // ------------------------------------------------------------------ pack memory
  const pack = deps.pack;
  const noPack = (reply: FastifyReply) => sendError(reply, new MeshError('not_ready', 'pack memory is disabled on this node'));

  /**
   * Share a note. The browser sends only the SHA-256 of its secret withdrawal
   * token; the token itself stays in the browser. Personal data is scrubbed
   * here as well as in the browser preview. Nothing identifying is stored.
   */
  app.post('/v1/pack/notes', { preHandler: requireRole('client') }, async (req, reply) => {
    if (!pack) return noPack(reply);
    const p = ShareRequest.safeParse(req.body);
    if (!p.success) return sendError(reply, new MeshError('bad_request', `invalid note: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message ?? ''}`));
    const title = scrub(p.data.title);
    const problem = scrub(p.data.problem);
    const solution = scrub(p.data.solution);
    const r = pack.store.createLocal({
      kind: p.data.kind,
      title: title.text.slice(0, PACK_LIMITS.titleChars),
      problem: problem.text.slice(0, PACK_LIMITS.problemChars),
      solution: solution.text.slice(0, PACK_LIMITS.solutionChars),
      tags: [...new Set(p.data.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, PACK_LIMITS.tags),
      withdrawHash: p.data.withdrawHash,
    });
    if (!r.ok) return sendError(reply, new MeshError('bad_request', r.reason));
    return { id: r.id, note: r.note, removed: [...new Set([...title.removed, ...problem.removed, ...solution.removed])] };
  });

  app.get('/v1/pack/notes', { preHandler: requireRole('client') }, async (req, reply) => {
    if (!pack) return noPack(reply);
    const q = req.query as { q?: string; limit?: string; hidden?: string };
    const includeHidden = q.hidden === '1' && roleOf(req) === 'admin';
    return pack.search(String(q.q ?? '').slice(0, 500), Math.min(100, Math.max(1, Number(q.limit) || 50)), includeHidden);
  });

  app.post('/v1/pack/withdraw', { preHandler: requireRole('client') }, async (req, reply) => {
    if (!pack) return noPack(reply);
    const p = z.strictObject({ noteId: z.string().regex(/^[0-9a-f]{64}$/), token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) }).safeParse(req.body);
    if (!p.success) return sendError(reply, new MeshError('bad_request', 'invalid withdrawal'));
    if (!pack.store.notes.has(p.data.noteId)) return sendError(reply, new MeshError('bad_request', 'this node does not hold that note'));
    const r = pack.store.acceptTomb({ v: 1, noteId: p.data.noteId, token: p.data.token, day: new Date().toISOString().slice(0, 10) });
    if (!r.ok) return sendError(reply, new MeshError('forbidden', r.reason));
    return { withdrawn: true };
  });

  /** "This helped": local reinforcement only (never shared, so it cannot be used to track anyone). */
  app.post('/v1/pack/notes/:id/helped', { preHandler: requireRole('client') }, async (req, reply) => {
    if (!pack) return noPack(reply);
    const id = (req.params as { id: string }).id;
    if (!pack.store.notes.has(id)) return sendError(reply, new MeshError('bad_request', 'unknown note'));
    pack.store.reinforce(id, 1, false);
    return { ok: true, weight: pack.store.weight(id).w };
  });

  app.get('/v1/pack/stats', { preHandler: requireRole('client') }, async (_req, reply) => {
    if (!pack) return noPack(reply);
    return {
      notes: pack.store.notes.size,
      visible: pack.store.visible().length,
      withdrawn: pack.store.tombs.size,
      waitingToSpread: pack.store.pendingCount,
      semanticSearch: pack.semantic,
      lastSync: pack.lastSync,
      limits: { maxNotes: PACK_LIMITS.maxNotes },
    };
  });

  app.post('/admin/pack/hide', { preHandler: requireRole('admin') }, async (req, reply) => {
    if (!pack) return noPack(reply);
    const p = z.strictObject({ id: z.string().regex(/^[0-9a-f]{64}$/), hidden: z.boolean() }).safeParse(req.body);
    if (!p.success) return sendError(reply, new MeshError('bad_request', 'invalid request'));
    pack.store.setHidden(p.data.id, p.data.hidden);
    return { ok: true };
  });

  /** Lets the UI discover whether its credential works and which role it has. */
  app.get('/v1/mesh/whoami', { preHandler: requireRole('client') }, async (req) => ({ role: roleOf(req), gatewayPeerId: deps.selfPeerId }));

  // ------------------------------------------------------------------ UI
  const uiDir = deps.uiDir ?? join(REPO_ROOT, 'apps/web/dist');
  if (cfg.http.serveUi && existsSync(join(uiDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: uiDir, prefix: '/', index: ['index.html'], cacheControl: true, maxAge: 0 });
  } else {
    app.get('/', async () => ({ name: 'Werewolf AI Mesh node', ui: 'not built (run: pnpm build)' }));
  }

  // Unknown routes: JSON 404.
  app.setNotFoundHandler((_req, reply) => sendError(reply, new MeshError('bad_request', 'not found')).code(404));
  void IGNORED_OPENAI_FIELDS;
  return app as unknown as FastifyInstance;
}

function corsHeaders(req: FastifyRequest, allowed: Set<string>): Record<string, string> {
  const o = req.headers.origin;
  if (o && allowed.has(o)) {
    return { 'access-control-allow-origin': o, vary: 'Origin', 'access-control-expose-headers': 'x-mesh-worker, x-mesh-gateway, x-mesh-route, x-mesh-runtime' };
  }
  return {};
}
