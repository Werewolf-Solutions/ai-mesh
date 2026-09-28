/**
 * llama.cpp `llama-server` adapter.
 *
 * spawn mode: starts llama-server as a child process bound to 127.0.0.1 on a
 *   random port, protected by a per-start random API key. The runtime port is
 *   never exposed beyond loopback.
 * external mode: talks to a llama-server on a private container network
 *   (see deploy/). The compose file publishes no runtime port.
 *
 * Tool execution, the built-in web UI, /props mutation and slot saving are
 * never enabled.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { MeshError, SseParser, type ChatMessage, type GenerationSettings } from '@werewolf-mesh/protocol';
import type { Logger } from '../util/log.js';
import { atomicWriteFile } from '../util/fs.js';
import type { GenEvent, InferenceAdapter, RuntimeStatus } from './adapter.js';

export interface LlamaCppOptions {
  mode: 'spawn' | 'external';
  binary: string;
  url?: string;
  apiKeyFile?: string;
  modelPath: string;
  expectedBuildInfo: string;
  threads: number;
  batchThreads: number;
  contextTokens: number;
  parallel: number;
  maxOutputTokens: number;
  mlock: boolean;
  mmap: boolean;
  startupTimeoutMs: number;
  dataDir: string;
  log: Logger;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlamaCppAdapter implements InferenceAdapter {
  readonly kind = 'llama.cpp' as const;
  private child: ChildProcess | undefined;
  private baseUrl = '';
  private apiKey = '';
  private state: RuntimeStatus = { ready: false, state: 'stopped', detail: 'not started' };
  private stopping = false;
  private restarts: number[] = [];
  /** Last lines of runtime stderr, for diagnostics only (llama-server does not log prompt text at default verbosity). */
  private stderrTail: string[] = [];

  constructor(private readonly opts: LlamaCppOptions) {}

  status(): RuntimeStatus {
    return { ...this.state };
  }

  diagnostics(): string[] {
    return [...this.stderrTail];
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.state = { ready: false, state: 'loading', detail: 'starting runtime' };
    if (this.opts.mode === 'external') {
      if (!this.opts.url) throw new Error('runtime.url is required in external mode');
      this.baseUrl = this.opts.url.replace(/\/$/, '');
      this.apiKey = this.opts.apiKeyFile ? (await readFile(this.opts.apiKeyFile, 'utf8')).trim() : '';
    } else {
      await this.spawnChild();
    }
    await this.waitHealthy();
    await this.checkIdentity();
    await this.warmup();
    this.state = { ready: true, state: 'ready', detail: `llama.cpp ${this.opts.expectedBuildInfo} serving ${basename(this.opts.modelPath)}` };
  }

  private async spawnChild(): Promise<void> {
    const port = await freePort();
    this.apiKey = randomBytes(24).toString('base64url');
    const keyFile = join(this.opts.dataDir, 'runtime.key');
    await atomicWriteFile(keyFile, this.apiKey + '\n', 0o600);
    const args = [
      '-m', this.opts.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', String(this.opts.contextTokens * this.opts.parallel),
      '-np', String(this.opts.parallel),
      '-t', String(this.opts.threads),
      '-tb', String(this.opts.batchThreads),
      '-n', String(this.opts.maxOutputTokens),
      '--api-key-file', keyFile,
      '--no-webui',
      '--offline',
      '--no-slots',
    ];
    if (this.opts.mlock) args.push('--mlock');
    if (!this.opts.mmap) args.push('--no-mmap');
    this.baseUrl = `http://127.0.0.1:${port}`;
    await this.killStaleRuntime();
    // On Linux, ask the kernel to SIGTERM the runtime if this node process dies
    // (even by SIGKILL), so a crashed node never leaves an orphaned llama-server.
    const usePdeath = process.platform === 'linux' && existsSync('/usr/bin/setpriv');
    const [cmd, cmdArgs] = usePdeath
      ? ['/usr/bin/setpriv', ['--pdeathsig', 'TERM', '--', this.opts.binary, ...args]]
      : [this.opts.binary, args];
    const child = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LD_LIBRARY_PATH: join(this.opts.binary, '..') },
    });
    this.child = child;
    if (child.pid) await atomicWriteFile(this.pidFile(), String(child.pid), 0o600).catch(() => undefined);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line) continue;
        this.stderrTail.push(line.slice(0, 300));
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    child.on('exit', (code, sig) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopping) return;
      this.state = { ready: false, state: 'failed', detail: `runtime exited (code ${code}, signal ${sig})` };
      this.opts.log.error({ code, sig }, 'llama-server exited unexpectedly');
      void this.restartWithBackoff();
    });
    child.on('error', (err) => {
      this.state = { ready: false, state: 'failed', detail: `cannot start runtime: ${err.message}` };
    });
    this.opts.log.info({ port, threads: this.opts.threads, ctx: this.opts.contextTokens }, 'spawned llama-server on loopback');
  }

  /** Bounded restart policy: at most 5 restarts per 10 minutes, exponential backoff. */
  private async restartWithBackoff(): Promise<void> {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 600_000);
    if (this.restarts.length >= 5) {
      this.opts.log.error('runtime restart budget exhausted; staying not-ready');
      return;
    }
    this.restarts.push(now);
    await sleep(Math.min(30_000, 1000 * 2 ** (this.restarts.length - 1)));
    if (this.stopping) return;
    try {
      await this.start();
      this.opts.log.info('runtime restarted');
    } catch (err) {
      this.opts.log.error({ err: (err as Error).message }, 'runtime restart failed');
    }
  }

  private pidFile(): string {
    return join(this.opts.dataDir, 'runtime.pid');
  }

  /** Terminate a llama-server left behind by a previous run of THIS node (matched by its key-file path). */
  private async killStaleRuntime(): Promise<void> {
    try {
      const pid = Number(await readFile(this.pidFile(), 'utf8'));
      if (!Number.isInteger(pid) || pid <= 1) return;
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      if (cmdline.includes('llama-server') && cmdline.includes(join(this.opts.dataDir, 'runtime.key'))) {
        this.opts.log.warn({ pid }, 'terminating stale llama-server from a previous run');
        process.kill(pid, 'SIGTERM');
        await sleep(500);
      }
    } catch {
      /* no pidfile */
    }
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + this.opts.startupTimeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      if (this.opts.mode === 'spawn' && !this.child) {
        throw new Error(`llama-server exited during startup: ${this.stderrTail.slice(-5).join(' | ')}`);
      }
      try {
        const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
        last = `HTTP ${r.status}`;
      } catch (err) {
        last = (err as Error).message;
      }
      await sleep(200);
    }
    throw new Error(`runtime not healthy after ${this.opts.startupTimeoutMs} ms (${last})`);
  }

  /** Confirm the runtime is the pinned build serving the verified file. */
  private async checkIdentity(): Promise<void> {
    const r = await fetch(`${this.baseUrl}/props`, { headers: this.headers(false), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`runtime /props returned HTTP ${r.status}`);
    const props = (await r.json()) as { build_info?: string; model_path?: string; total_slots?: number };
    if (props.build_info !== this.opts.expectedBuildInfo) {
      throw new Error(`runtime build ${props.build_info} does not match pinned ${this.opts.expectedBuildInfo}`);
    }
    if (!props.model_path || basename(props.model_path) !== basename(this.opts.modelPath)) {
      throw new Error(`runtime serves ${props.model_path}, expected ${basename(this.opts.modelPath)}`);
    }
  }

  private async warmup(): Promise<void> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30_000);
    try {
      for await (const _ of this.generate([{ role: 'user', content: 'Hi' }], { maxTokens: 1, temperature: 0 }, ctl.signal)) {
        /* drain */
      }
    } finally {
      clearTimeout(t);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.state = { ready: false, state: 'stopped', detail: 'stopped' };
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  async countPromptTokens(messages: ChatMessage[], signal?: AbortSignal): Promise<number> {
    const tpl = await fetch(`${this.baseUrl}/apply-template`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messages }),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!tpl.ok) throw new MeshError('runtime_error', `apply-template HTTP ${tpl.status}`);
    const { prompt } = (await tpl.json()) as { prompt: string };
    const tok = await fetch(`${this.baseUrl}/tokenize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content: prompt, add_special: true, parse_special: true }),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!tok.ok) throw new MeshError('runtime_error', `tokenize HTTP ${tok.status}`);
    const { tokens } = (await tok.json()) as { tokens: unknown[] };
    return tokens.length;
  }

  async *generate(messages: ChatMessage[], settings: GenerationSettings, signal: AbortSignal): AsyncIterable<GenEvent> {
    const body = {
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      top_p: settings.topP,
      seed: settings.seed,
      stop: settings.stop,
      presence_penalty: settings.presencePenalty,
      frequency_penalty: settings.frequencyPenalty,
      cache_prompt: true,
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new MeshError('cancelled', 'cancelled');
      throw new MeshError('runtime_error', `runtime unreachable: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /context|exceed/i.test(text)) throw new MeshError('context_exceeded', 'prompt exceeds context');
      throw new MeshError('runtime_error', `runtime HTTP ${res.status}`);
    }

    const queue: GenEvent[] = [];
    let finishReason: 'stop' | 'length' | null = null;
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    let sawDone = false;
    let runtimeError: string | null = null;
    const parser = new SseParser((ev) => {
      if (ev.data === '[DONE]') {
        sawDone = true;
        return;
      }
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        runtimeError = 'malformed runtime event';
        return;
      }
      if (j.error) {
        runtimeError = String(j.error.message ?? 'runtime error').slice(0, 200);
        return;
      }
      const choice = j.choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === 'string' && text.length > 0) queue.push({ type: 'token', text });
      if (choice?.finish_reason) finishReason = choice.finish_reason === 'length' ? 'length' : 'stop';
      if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
      else if (j.timings && !usage) usage = { promptTokens: j.timings.prompt_n ?? 0, completionTokens: j.timings.predicted_n ?? 0 };
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal.aborted) throw new MeshError('cancelled', 'cancelled');
          throw new MeshError('runtime_error', `runtime stream broke: ${(err as Error).message}`);
        }
        if (chunk.done) break;
        parser.push(decoder.decode(chunk.value, { stream: true }));
        while (queue.length) yield queue.shift()!;
        if (runtimeError) throw new MeshError('runtime_error', runtimeError);
      }
    } finally {
      // Closing the response body disconnects from llama-server, which cancels the slot's task.
      await reader.cancel().catch(() => undefined);
    }
    if (!sawDone || !finishReason) throw new MeshError('runtime_error', 'runtime stream ended without completion');
    yield { type: 'done', finishReason, usage: usage ?? { promptTokens: 0, completionTokens: 0 } };
  }
}
