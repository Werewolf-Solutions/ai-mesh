/**
 * Multi-process test harness. Each node is a separate OS process running the
 * built node (apps/node/dist/main.js) with its own data directory, identity and
 * ports. Timings are shortened so failure detection runs in seconds.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SseParser } from '@werewolf-mesh/protocol';
import { generateCluster, type ClusterNode } from '../apps/node/src/cluster.js';

export const ROOT = resolve(import.meta.dirname, '..');
const MAIN = join(ROOT, 'apps/node/dist/main.js');

export const FAST_TIMINGS = {
  discovery: { probeIntervalMs: 300, probeTimeoutMs: 1000, failuresBeforeUnavailable: 3, statusTtlMs: 2000, reconnectBaseMs: 200, reconnectMaxMs: 2000, admissionReloadMs: 200 },
  timeouts: { connectMs: 1500, firstTokenMs: 5000, streamIdleMs: 3000, defaultDeadlineMs: 30000, maxDeadlineMs: 60000 },
  worker: { queueTimeoutMs: 10000 },
  shutdown: { graceMs: 2000 },
  // The embedding scorer is exercised in its own tests; keep fault-injection clusters light.
  scorer: { enabled: false },
  pack: { syncIntervalMs: 300, publishDelayMinMs: 0, publishDelayMaxMs: 0 },
};

export interface TestNode extends ClusterNode {
  url: string;
  clientToken: string;
  adminToken: string;
  proc?: ChildProcess;
  logs: string[];
}

export interface TestCluster {
  dir: string;
  nodes: TestNode[];
  start(n: TestNode): Promise<void>;
  stopAll(): Promise<void>;
  cleanup(): Promise<void>;
}

let portCursor = 20000 + Math.floor(Math.random() * 20000);

function deepMerge(a: any, b: any): any {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

export async function makeCluster(opts: { nodes: number; fake?: boolean; patch?: (i: number) => object }): Promise<TestCluster> {
  const dir = await mkdtemp(join(tmpdir(), 'wam-test-'));
  const basePort = portCursor;
  portCursor += 250;
  const gen = await generateCluster({
    nodes: opts.nodes,
    mode: 'native',
    out: join(dir, 'cluster'),
    networkId: 'test-net',
    fake: opts.fake ?? true,
    modelsDir: join(ROOT, 'models'),
    threads: 2,
    basePort,
    image: 'unused',
    cpus: 1,
    memLimit: '1g',
  });
  const nodes: TestNode[] = [];
  for (const g of gen) {
    const cfgPath = join(g.dir, 'node.json');
    let cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    cfg = deepMerge(cfg, FAST_TIMINGS);
    cfg.runtime.fakeTokenDelayMs = 20;
    if (opts.patch) cfg = deepMerge(cfg, opts.patch(g.index));
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    const secrets = JSON.parse(await readFile(join(g.dir, 'secrets.json'), 'utf8'));
    nodes.push({ ...g, url: `http://127.0.0.1:${g.httpPort}`, clientToken: secrets.clientTokens[0], adminToken: secrets.adminToken, logs: [] });
  }
  const cluster: TestCluster = {
    dir,
    nodes,
    async start(n) {
      await startNode(n);
    },
    async stopAll() {
      await Promise.all(nodes.map((n) => stopNode(n)));
    },
    async cleanup() {
      await cluster.stopAll();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return cluster;
}

export async function startNode(n: TestNode): Promise<void> {
  const proc = spawn(process.execPath, [MAIN, '--data', n.dir], {
    env: { ...process.env, MESH_ALLOW_FAKE_RUNTIME: '1', MESH_LOG_LEVEL: process.env.MESH_TEST_LOG ?? 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  n.proc = proc;
  const cap = (d: Buffer) => {
    for (const l of d.toString().split('\n')) if (l) n.logs.push(l);
    if (n.logs.length > 500) n.logs.splice(0, n.logs.length - 500);
    if (process.env.MESH_TEST_LOG) process.stderr.write(`[${n.name}] ${d}`);
  };
  proc.stdout!.on('data', cap);
  proc.stderr!.on('data', cap);
  await waitFor(async () => (await fetch(`${n.url}/health/ready`).then((r) => r.ok).catch(() => false)), 20_000, `${n.name} ready`);
}

export async function stopNode(n: TestNode, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const p = n.proc;
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  if (signal === 'SIGSTOP') {
    p.kill('SIGCONT');
  }
  const exited = new Promise((r) => p.once('exit', r));
  p.kill(signal);
  await Promise.race([exited, sleep(8000)]);
  if (p.exitCode === null && p.signalCode === null) {
    p.kill('SIGKILL');
    await exited;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function admin<T = any>(n: TestNode, path: string): Promise<T> {
  const r = await fetch(`${n.url}${path}`, { headers: { authorization: `Bearer ${n.adminToken}` } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function peerView(n: TestNode, of: TestNode): Promise<any | undefined> {
  const r = await admin<{ peers: any[] }>(n, '/admin/peers');
  return r.peers.find((p) => p.peerId === of.peerId);
}

export async function waitAvailable(from: TestNode, others: TestNode[], timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => {
    for (const o of others) if (!(await peerView(from, o).catch(() => undefined))?.available) return false;
    return true;
  }, timeoutMs, `${from.name} sees ${others.map((o) => o.name).join(',')} available`);
}

export interface StreamResult {
  status: number;
  headers: Headers;
  text: string;
  done: boolean;
  error: any | null;
  chunks: any[];
  body?: any;
}

export async function chat(
  n: TestNode,
  content: string,
  opts: { stream?: boolean; target?: string; prefer?: string; maxTokens?: number; signal?: AbortSignal; onToken?: (t: string, all: string) => void; token?: string; extra?: object } = {},
): Promise<StreamResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${opts.token ?? n.clientToken}` };
  if (opts.prefer) headers['x-mesh-prefer'] = opts.prefer;
  const r = await fetch(`${n.url}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal: opts.signal,
    body: JSON.stringify({ messages: [{ role: 'user', content }], stream: opts.stream ?? true, max_tokens: opts.maxTokens ?? 64, ...(opts.target ? { mesh: { target: opts.target } } : {}), ...opts.extra }),
  });
  if (!r.ok || !(opts.stream ?? true)) {
    const body = await r.json().catch(() => null);
    return { status: r.status, headers: r.headers, text: body?.choices?.[0]?.message?.content ?? '', done: r.ok, error: body?.error ?? null, chunks: [], body };
  }
  const res: StreamResult = { status: r.status, headers: r.headers, text: '', done: false, error: null, chunks: [] };
  const p = new SseParser((ev) => {
    if (ev.data === '[DONE]') {
      res.done = true;
      return;
    }
    const j = JSON.parse(ev.data);
    if (j.error) {
      res.error = j.error;
      return;
    }
    res.chunks.push(j);
    const t = j.choices?.[0]?.delta?.content;
    if (t) {
      res.text += t;
      opts.onToken?.(t, res.text);
    }
  });
  const dec = new TextDecoder();
  try {
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) p.push(dec.decode(c, { stream: true }));
  } catch (e) {
    if (!opts.signal?.aborted) res.error ??= { code: 'stream_broken', message: (e as Error).message };
  }
  return res;
}
