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
import { REPO_ROOT } from '../version.js';

export interface HttpDeps {
  cfg: NodeConfig;
  log: Logger;
  tokens: TokenChecker;
  gateway: Gateway;
  selfPeerId: string;
  modelId: string;
  fingerprint: string;
  runtimeKind: 'llama.cpp' | 'fake';
  ready: () => ReadyBody;
  status: () => NodeStatusView;
  peers: () => unknown;
  metrics: () => MetricsView;
  modelInfo: () => unknown;
  reloadAdmission: () => Promise<void>;
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
  app.get('/v1/models', { preHandler: requireRole('client') }, async () => ({
    object: 'list',
    data: [
      {
        id: deps.modelId,
        object: 'model',
        created: 0,
        owned_by: 'werewolf-mesh',
        mesh: { fingerprint: deps.fingerprint, runtime: deps.runtimeKind, execution: 'replicated (each node holds a full copy)' },
      },
    ],
  }));

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
    if (r.model && r.model !== deps.modelId && r.model !== deps.fingerprint) {
      return sendError(reply, new MeshError('bad_request', `model "${r.model}" is not served; use "${deps.modelId}"`));
    }
    const maxTokens = r.max_completion_tokens ?? r.max_tokens ?? LIMITS.maxOutputTokens;
    if (maxTokens > LIMITS.maxOutputTokens) {
      return sendError(reply, new MeshError('bad_request', `max_tokens must be <= ${LIMITS.maxOutputTokens} in v0.1`));
    }
    const totalChars = r.messages.reduce((n, m) => n + m.content.length, 0);
    if (totalChars > LIMITS.maxTotalChars) {
      return sendError(reply, new MeshError('payload_too_large', `messages total ${totalChars} chars; limit ${LIMITS.maxTotalChars}`));
    }
    const deadlineMs = Math.min(r.mesh?.timeout_ms ?? cfg.timeouts.defaultDeadlineMs, cfg.timeouts.maxDeadlineMs);
    const target = r.mesh?.target ?? 'auto';
    const prefer = (req.headers['x-mesh-prefer'] as string | undefined)?.slice(0, 128);
    const settings = {
      maxTokens,
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
    const gen = deps.gateway.execute({ messages: r.messages, settings, deadlineMs, target, ...(prefer ? { prefer } : {}) }, ctl.signal);
    const meshInfo = (worker: string | null, route: 'local' | 'remote' | null, attempts: AttemptRecord[]) => ({
      gatewayPeerId: deps.selfPeerId,
      workerPeerId: worker,
      route,
      attempts,
      runtime: deps.runtimeKind,
    });

    if (!r.stream) {
      let text = '';
      try {
        for await (const ev of gen) {
          if (ev.type === 'first_token' || ev.type === 'token') text += ev.text;
          else {
            reply.header('x-mesh-worker', ev.workerPeerId).header('x-mesh-gateway', deps.selfPeerId).header('x-mesh-route', ev.route).header('x-mesh-runtime', deps.runtimeKind);
            return reply.send({
              id,
              object: 'chat.completion',
              created,
              model: deps.modelId,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: ev.finishReason }],
              usage: { prompt_tokens: ev.usage.promptTokens, completion_tokens: ev.usage.completionTokens, total_tokens: ev.usage.promptTokens + ev.usage.completionTokens },
              mesh: meshInfo(ev.workerPeerId, ev.route, ev.attempts),
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
      model: deps.modelId,
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
          await write(chunk({ role: 'assistant', content: ev.text }, null, { mesh: meshInfo(ev.workerPeerId, ev.route, ev.attempts) }));
        } else if (ev.type === 'token') {
          await write(chunk({ content: ev.text }, null));
        } else {
          await write(
            chunk({}, ev.finishReason, {
              usage: { prompt_tokens: ev.usage.promptTokens, completion_tokens: ev.usage.completionTokens, total_tokens: ev.usage.promptTokens + ev.usage.completionTokens },
              mesh: meshInfo(ev.workerPeerId, ev.route, ev.attempts),
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
