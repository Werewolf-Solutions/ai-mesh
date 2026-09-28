/**
 * REAL MODEL tests: llama.cpp b11223 + verified SmolLM2-135M-Instruct Q4_K_M.
 * No fake runtime anywhere in this file. Requires:
 *   ./mesh runtime install && ./mesh model download && pnpm build
 * Measurements are written to .cache/measurements.json for docs/benchmarks.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, ROOT, sleep, startNode, stopNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

const MODEL = join(ROOT, 'models/SmolLM2-135M-Instruct-Q4_K_M.gguf');
const BIN = join(ROOT, '.cache/runtime/llama-b11223/llama-server');
const haveReal = existsSync(MODEL) && existsSync(BIN);
const measurements: Record<string, unknown> = {};

function rssKiB(pid: number): number {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return 0;
  }
}
function childRss(pid: number): number {
  try {
    const kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
    return kids.reduce((n, k) => n + rssKiB(k) + childRss(k), 0);
  } catch {
    return 0;
  }
}

const REAL_PATCH = () => ({
  timeouts: { connectMs: 3000, firstTokenMs: 20000, streamIdleMs: 10000, defaultDeadlineMs: 60000 },
  runtime: { threads: 2, batchThreads: 2 },
  scorer: { enabled: true },
});

describe.skipIf(!haveReal)('real llama.cpp model', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode;

  beforeAll(async () => {
    c = await makeCluster({ nodes: 3, fake: false, patch: REAL_PATCH });
    [n1, n2, n3] = c.nodes as [TestNode, TestNode, TestNode];
  });
  afterAll(async () => {
    await c?.cleanup();
    await mkdir(join(ROOT, '.cache'), { recursive: true });
    const hw = { cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30), threadsPerNode: 2, ctx: 2048, model: 'SmolLM2-135M-Instruct Q4_K_M', runtime: 'llama.cpp b11223 (CPU)' };
    await writeFile(join(ROOT, '.cache/measurements.json'), JSON.stringify({ at: new Date().toISOString(), hardware: hw, ...measurements }, null, 2));
  });

  it('1. a fresh node verifies the model, loads it, and answers locally', async () => {
    const t0 = Date.now();
    await startNode(n1);
    measurements.startupToReadyMs = Date.now() - t0;
    const s = await admin(n1, '/admin/status');
    expect(s.runtime).toMatchObject({ kind: 'llama.cpp', ready: true });
    expect(s.model.verified).toBe(true);
    const r = await chat(n1, 'What is the capital of France? Answer in one short sentence.', { maxTokens: 32, extra: { temperature: 0 } });
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-runtime')).toBe('llama.cpp');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).toMatch(/Paris/);
    measurements.nodeRssKiB = rssKiB(n1.proc!.pid!);
    measurements.runtimeRssKiB = childRss(n1.proc!.pid!);
  });

  it('measures TTFT and decode throughput (local, 128 tokens)', async () => {
    const samples: Array<{ ttftMs: number; tokens: number; totalMs: number }> = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      let first = 0;
      const r = await chat(n1, 'Write a short paragraph about wolves.', { maxTokens: 128, extra: { temperature: 0, seed: 1 }, onToken: () => void (first ||= performance.now()) });
      const end = performance.now();
      const usage = r.chunks.at(-1)?.usage;
      samples.push({ ttftMs: Math.round(first - t0), tokens: usage.completion_tokens, totalMs: Math.round(end - t0) });
    }
    measurements.localGeneration = samples.map((s) => ({ ...s, decodeTokPerS: Math.round((s.tokens / ((s.totalMs - s.ttftMs) / 1000)) * 10) / 10 }));
    expect(samples.every((s) => s.tokens > 0)).toBe(true);
  });

  it('2+3. three nodes discover each other; a request is routed to a chosen remote node', async () => {
    await startNode(n2);
    await startNode(n3);
    await waitAvailable(n3, [n1, n2], 30_000);
    const t0 = performance.now();
    let first = 0;
    const r = await chat(n3, 'Name one planet.', { target: n1.peerId, maxTokens: 24, extra: { temperature: 0 }, onToken: () => void (first ||= performance.now()) });
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-worker')).toBe(n1.peerId);
    expect(r.headers.get('x-mesh-route')).toBe('remote');
    measurements.remoteTtftMs = Math.round(first - t0);
    measurements.peerRttMs = (await admin(n3, '/admin/peers')).peers.map((p: any) => p.rttMs);
  });

  it('4a. worker frozen before output → bounded failover to another real worker', async () => {
    n2.proc!.kill('SIGSTOP');
    try {
      const t0 = Date.now();
      const r = await chat(n3, 'Say hello.', { prefer: n2.peerId, maxTokens: 16 });
      measurements.failoverBeforeOutputMs = Date.now() - t0;
      expect(r.done).toBe(true);
      const attempts = r.chunks.at(-1).mesh.attempts;
      expect(attempts[0]).toMatchObject({ workerPeerId: n2.peerId, outcome: 'connect_timeout' });
      expect(attempts.length).toBe(2);
    } finally {
      n2.proc!.kill('SIGCONT');
    }
  });

  it('4b. worker killed during output → visible interruption, partial text kept', async () => {
    await waitAvailable(n3, [n2], 30_000);
    let killedAt = 0;
    const r = await chat(n3, 'Write a long, detailed story about a wolf pack in winter.', {
      prefer: n2.peerId,
      maxTokens: 256,
      extra: { temperature: 0.7 },
      onToken: (_t, all) => {
        if (!killedAt && all.length > 20) {
          killedAt = Date.now();
          n2.proc!.kill('SIGKILL');
        }
      },
    });
    measurements.interruptDetectMs = Date.now() - killedAt;
    expect(r.headers.get('x-mesh-worker')).toBe(n2.peerId);
    expect(r.done).toBe(false);
    expect(r.error.code).toBe('interrupted');
    expect(r.text.length).toBeGreaterThan(20);
    // runtime child of the killed node must not be orphaned
    await sleep(500);
    const orphans = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('llama-server') && !l.includes('setpriv') && l.includes(`${n2.dir}/runtime.key`));
    expect(orphans).toEqual([]);
    await waitFor(() => n2.proc!.exitCode !== null || n2.proc!.signalCode !== null, 5000);
    await startNode(n2);
  });

  it('5. cancellation stops real generation and frees the slot', async () => {
    const ctl = new AbortController();
    await chat(n1, 'Write a very long essay about the Roman empire.', {
      maxTokens: 256,
      target: 'local',
      signal: ctl.signal,
      onToken: (_t, all) => all.length > 10 && ctl.abort(),
    }).catch(() => null);
    await waitFor(async () => (await admin(n1, '/admin/status')).worker.active === 0, 3000, 'slot freed');
    const t0 = performance.now();
    let first = 0;
    await chat(n1, 'Hi', { maxTokens: 4, target: 'local', onToken: () => void (first ||= performance.now()) });
    measurements.ttftAfterCancelMs = Math.round(first - t0);
    // 256 tokens at ~100+ tok/s would still be running for >1 s if cancel had not reached llama.cpp
    expect(first - t0).toBeLessThan(1000);
  });

  it('scores summaries by meaning with the pinned embedding model', async () => {
    if (!existsSync(join(ROOT, 'models/bge-small-en-v1.5-q8_0.gguf'))) return; // optional model not installed
    // node1 runs with the scorer enabled (see REAL_PATCH)
    await waitFor(async () => (await (await fetch(`${n1.url}/v1/mesh/scorer`)).json()).state === 'ready', 30_000, 'scorer ready');
    const ref = 'The pack survives the journey because many wolves share knowledge and work.';
    const r = await (
      await fetch(`${n1.url}/v1/mesh/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: ref, candidates: ['Wolves get through the trip by sharing what they know and the hard work.', 'The stock market fell after rates rose.'] }),
      })
    ).json();
    expect(r.semantic.available).toBe(true);
    expect(r.semantic.cosine[0]).toBeGreaterThan(r.semantic.cosine[1] + 0.3);
    expect(r.semantic.cosine[1]).toBeLessThan(r.semantic.unrelatedBaseline + 0.15);
  });

  it('pack memory: a note shared on one node is found by meaning on another and used in the answer', async () => {
    if (!existsSync(join(ROOT, 'models/bge-small-en-v1.5-q8_0.gguf'))) return; // optional model not installed
    const share = await fetch(`${n2.url}/v1/pack/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'solution',
        title: 'Docker says permission denied without sudo',
        problem: 'Running docker commands fails with permission denied on the Docker daemon socket unless I use sudo.',
        solution: 'Add your user to the docker group with: sudo usermod -aG docker $USER. Then log out and back in so the new group applies.',
        tags: ['docker'],
        withdrawHash: 'b'.repeat(64),
      }),
    });
    const { id } = (await share.json()) as { id: string };
    // replicated to node3 and indexed by its embedding model
    await waitFor(async () => {
      const r = await (await fetch(`${n3.url}/v1/pack/notes?q=${encodeURIComponent('docker permission denied')}`)).json();
      return r.semantic && r.notes.some((v: any) => v.note.id === id);
    }, 30_000, 'note replicated and indexed on node3');
    const q = 'docker keeps saying permission denied unless I run it with sudo, how do I fix that?';
    const withPack = await chat(n3, q, { stream: false, maxTokens: 80, extra: { temperature: 0 } });
    expect(withPack.body.mesh.packNotes.map((n: any) => n.id)).toContain(id);
    expect(withPack.text).toMatch(/usermod/);
    const unrelated = await chat(n3, 'What is the capital of France?', { stream: false, maxTokens: 16, extra: { temperature: 0 } });
    expect(unrelated.body.mesh.packNotes).toBeUndefined();
    measurements.packRetrieval = { withPack: withPack.text.slice(0, 160), similarity: withPack.body.mesh.packNotes[0].similarity };
  });

  it('6. after stopping the bootstrap node, survivors still serve new requests', async () => {
    await waitAvailable(n3, [n2], 30_000);
    await stopNode(n1);
    const r = await chat(n3, 'Name a colour.', { target: n2.peerId, maxTokens: 12 });
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-worker')).toBe(n2.peerId);
  });

  it('restart preserves identity with the real runtime', async () => {
    await stopNode(n2);
    await startNode(n2);
    expect((await admin(n2, '/admin/status')).peerId).toBe(n2.peerId);
    const cfg = JSON.parse(await readFile(join(n2.dir, 'node.json'), 'utf8'));
    expect(cfg.runtime.kind).toBe('llama.cpp');
  });
});

describe.skipIf(haveReal)('real model prerequisites', () => {
  it('SKIPPED: real model or runtime missing — run ./mesh runtime install && ./mesh model download', () => {
    expect(haveReal).toBe(false);
  });
});
