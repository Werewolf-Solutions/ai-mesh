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
    const deadlineMs = Math.min(r.mesh?.timeout_ms ?? cfg.timeouts.defaultDeadlineMs, cfg.timeouts.maxDeadlineMs);
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

    // Pack memory: give the model the most relevant anonymous notes as quoted context.
    let messages = r.messages;
    let packNotes: Array<{ id: string; title: string; solution: string; similarity: number }> = [];
    // Skipped for very long prompts: notes must not push a request over the 2,048-token budget.
    if (deps.pack && r.mesh?.pack !== false && totalChars < 3000) {
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
    const gen = deps.gateway.execute({ model: fp, messages, settings, deadlineMs, target, ...(prefer ? { prefer } : {}) }, ctl.signal);
    const meshInfo = (worker: string | null, route: 'local' | 'remote' | null, attempts: AttemptRecord[]) => ({
      gatewayPeerId: deps.selfPeerId,
      workerPeerId: worker,
      route,
      attempts,
      runtime: deps.runtimeKind,
      model: entry.id,
      effort: plan.effort,
      ...(packNotes.length ? { packNotes } : {}),
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

    // ---- streaming (SSE). Headers are sent only once the first token exists, so
    // every pre-output failure is a normal HTTP error with a status code.
    let headersSent = false;
    const write = async (obj: unknown) => {
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
    try {
      for await (const ev of gen) {
        if (ev.type === 'first_token') {
          reply.hijack();
          reply.raw.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
            'x-mesh-worker': ev.workerPeerId,
            'x-mesh-gateway': deps.selfPeerId,
            'x-mesh-route': ev.route,
            'x-mesh-runtime': deps.runtimeKind,
            ...corsHeaders(req, allowedOrigins),
          });
          headersSent = true;
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
