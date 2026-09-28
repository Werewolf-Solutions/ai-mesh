/**
 * `./mesh demo failover --dir <cluster>` — scripted, observable demonstration
 * against a RUNNING generated cluster (docker or native). Every step prints
 * what it did and what was observed; nothing is simulated in this script.
 *
 *  1. Peer view from the last node's gateway.
 *  2. Deliberate remote execution (target = node1) with visible serving peer.
 *  3. Worker hangs BEFORE output (process frozen with SIGSTOP / docker pause):
 *     the gateway times out and fails over to another worker.
 *  4. Worker killed DURING output: the answer is marked interrupted and the
 *     partial text is kept; nothing is appended from another worker.
 *  5. Bootstrap loss: stop bootstrap node1; surviving peers still serve.
 *  Nodes stopped by the demo are restarted at the end.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SseParser } from '@werewolf-mesh/protocol';
import { loadSecrets } from './secrets.js';

interface ClusterNode {
  index: number;
  name: string;
  dir: string;
  peerId: string;
  httpPort: number;
}

const out = (s = '') => process.stdout.write(s + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function demoFailover(dir: string): Promise<void> {
  const cluster = JSON.parse(await readFile(join(dir, 'cluster.json'), 'utf8')) as { mode: 'docker' | 'native'; fake: boolean; nodes: ClusterNode[] };
  const nodes = cluster.nodes;
  if (nodes.length < 3) throw new Error('the demo needs at least 3 nodes');
  const gw = nodes[nodes.length - 1]!;
  const [n1, n2] = [nodes[0]!, nodes[1]!];
  const tokens = new Map<string, { client: string; admin: string }>();
  for (const n of nodes) {
    const s = await loadSecrets(n.dir);
    tokens.set(n.name, { client: s.clientTokens[0]!, admin: s.adminToken });
  }
  const url = (n: ClusterNode) => `http://127.0.0.1:${n.httpPort}`;
  const name = (peerId: string | null) => nodes.find((n) => n.peerId === peerId)?.name ?? peerId ?? '?';

  const ctl = {
    freeze: (n: ClusterNode) => (cluster.mode === 'docker' ? compose(dir, 'pause', n.name) : signal(n, 'SIGSTOP')),
    thaw: (n: ClusterNode) => (cluster.mode === 'docker' ? compose(dir, 'unpause', n.name) : signal(n, 'SIGCONT')),
    kill: (n: ClusterNode) => (cluster.mode === 'docker' ? compose(dir, 'kill', n.name) : signal(n, 'SIGKILL')),
    stop: (n: ClusterNode) => (cluster.mode === 'docker' ? compose(dir, 'stop', n.name) : signal(n, 'SIGTERM')),
    start: (n: ClusterNode) =>
      cluster.mode === 'docker'
        ? compose(dir, 'start', n.name)
        : spawnSync(process.execPath, [join(import.meta.dirname, 'cli.js'), 'start', '--data', n.dir, '--detach'], {
            stdio: 'inherit',
            env: { ...process.env, ...(cluster.fake ? { MESH_ALLOW_FAKE_RUNTIME: '1' } : {}) },
          }),
  };

  async function peers(): Promise<Array<Record<string, any>>> {
    const r = await fetch(`${url(gw)}/admin/peers`, { headers: { authorization: `Bearer ${tokens.get(gw.name)!.admin}` } });
    return ((await r.json()) as { peers: Array<Record<string, any>> }).peers;
  }
  async function waitAvailable(want: ClusterNode[], timeoutMs = 90_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const p = await peers().catch(() => []);
      if (want.every((w) => p.find((x) => x.peerId === w.peerId)?.available)) return true;
      await sleep(500);
    }
    return false;
  }
  async function ask(prompt: string, opts: { target?: string; prefer?: string; maxTokens?: number; onFirst?: () => void }) {
    const t0 = Date.now();
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${tokens.get(gw.name)!.client}` };
    if (opts.prefer) headers['x-mesh-prefer'] = opts.prefer;
    const r = await fetch(`${url(gw)}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: opts.maxTokens ?? 64, temperature: 0, ...(opts.target ? { mesh: { target: opts.target } } : {}) }),
    });
    if (!r.ok) return { ok: false, status: r.status, error: await r.text(), text: '', worker: null as string | null, done: false, ms: Date.now() - t0, attempts: [] as any[] };
    let text = '';
    let done = false;
    let error: string | null = null;
    let attempts: any[] = [];
    let first = true;
    const p = new SseParser((ev) => {
      if (ev.data === '[DONE]') return void (done = true);
      const j = JSON.parse(ev.data);
      if (j.error) return void (error = `${j.error.code}: ${j.error.message}`);
      if (j.mesh?.attempts) attempts = j.mesh.attempts;
      const t = j.choices?.[0]?.delta?.content;
      if (t) {
        text += t;
        if (first) {
          first = false;
          opts.onFirst?.();
        }
      }
    });
    const dec = new TextDecoder();
    try {
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) p.push(dec.decode(c, { stream: true }));
    } catch (e) {
      error ??= `stream broke: ${(e as Error).message}`;
    }
    return { ok: true, status: r.status, error, text, worker: r.headers.get('x-mesh-worker'), done, ms: Date.now() - t0, attempts };
  }

  out(`== Werewolf AI Mesh failover demo (${cluster.mode}${cluster.fake ? ', FAKE runtime' : ', real llama.cpp runtime'}) — gateway ${gw.name}`);
  out('   Observations are local and partial (from this gateway), not a global network view.\n');

  out('-- 1. Waiting for all peers to be available from the gateway ...');
  const others = nodes.filter((n) => n !== gw);
  if (!(await waitAvailable(others))) out('   (not all peers became available; continuing)');
  for (const p of await peers()) out(`   ${name(p.peerId).padEnd(6)} ${p.connected ? (p.relayed ? 'relayed' : 'direct ') : 'offline'} available=${p.available} rtt=${p.rttMs}ms`);

  out(`\n-- 2. Deliberate remote execution: target ${n1.name}`);
  const r2 = await ask('What is the capital of France? Answer briefly.', { target: n1.peerId });
  out(`   served by ${name(r2.worker)} | completed=${r2.done} | ${r2.ms} ms | text: ${JSON.stringify(r2.text.slice(0, 120))}`);

  out(`\n-- 3. Worker frozen BEFORE output: freeze ${n2.name}, prefer it, expect bounded failover`);
  ctl.freeze(n2);
  const t3 = Date.now();
  const r3 = await ask('Name three colours.', { prefer: n2.peerId });
  ctl.thaw(n2);
  out(`   attempts: ${r3.attempts.map((a: any) => `${name(a.workerPeerId)}=${a.outcome}`).join(' -> ') || '(none)'}`);
  out(`   served by ${name(r3.worker)} | completed=${r3.done} | total ${Date.now() - t3} ms (includes connect timeout) | ${r3.error ?? ''}`);

  out(`\n-- 4. Worker killed DURING output: prefer ${n2.name}, kill it after the first token`);
  await waitAvailable([n2], 30_000);
  const r4 = await ask(cluster.fake ? 'long [[fake:tokens=200]] [[fake:delay=50]]' : 'Write a long story about a wolf who learns to code. Make it detailed.', {
    prefer: n2.peerId,
    maxTokens: 256,
    onFirst: () => void setTimeout(() => ctl.kill(n2), 150),
  });
  out(`   served by ${name(r4.worker)} | completed=${r4.done} | terminal error: ${r4.error ?? '(none)'}`);
  out(`   partial text kept (${r4.text.length} chars): ${JSON.stringify(r4.text.slice(0, 100))}...`);
  out(r4.done ? '   NOTE: the generation finished before the kill landed; rerun to observe interruption.' : '   -> client shows INTERRUPTED + Retry; no second worker output was appended.');
  ctl.start(n2);

  out(`\n-- 5. Bootstrap loss: stop ${n1.name} (bootstrap/relay); survivors keep serving`);
  await waitAvailable([n2], 60_000);
  ctl.stop(n1);
  await sleep(1500);
  const survivor = nodes.find((n) => n !== n1 && n !== gw && n.index > 2) ?? n2;
  const r5 = await ask('Say hello.', { target: survivor.peerId });
  out(`   target ${survivor.name}: served by ${name(r5.worker)} | completed=${r5.done} | ${r5.ok ? '' : r5.error}`);
  ctl.start(n1);
  out('\nRestarted stopped nodes. Measured values above are from this machine only.');
}

function compose(dir: string, verb: string, service: string) {
  const r = spawnSync('docker', ['compose', '-f', join(dir, 'compose.yaml'), verb, service], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) out(`   (docker compose ${verb} ${service} failed)`);
  return r;
}

function signal(n: ClusterNode, sig: NodeJS.Signals) {
  try {
    const pid = Number(spawnSync('cat', [join(n.dir, 'node.pid')], { encoding: 'utf8' }).stdout);
    process.kill(pid, sig);
  } catch (e) {
    out(`   (could not send ${sig} to ${n.name}: ${(e as Error).message})`);
  }
  return null;
}
