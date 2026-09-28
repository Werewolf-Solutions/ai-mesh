/**
 * REAL multi-model tests on llama.cpp b11223 with catalog models already
 * downloaded into ./models (the install path is exercised through the admin
 * API; the download itself is covered by `./mesh models install` / docs).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, makeCluster, ROOT, startNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

const have = (f: string) => existsSync(join(ROOT, 'models', f)) && existsSync(join(ROOT, '.cache/runtime/llama-b11223/llama-server'));
const Q35 = 'qwen3.5-0.8b-q8_0';
const Q4B = 'qwen3-4b-q4_k_m';

async function ask(n: TestNode, body: object) {
  const r = await fetch(`${n.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ temperature: 0, ...body }) });
  return { status: r.status, worker: r.headers.get('x-mesh-worker'), body: (await r.json()) as any };
}
const q = (content: string) => [{ role: 'user', content }];

describe.skipIf(!have('Qwen3.5-0.8B-Q8_0.gguf'))('real models: install, effort, routing by model', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode;
  beforeAll(async () => {
    c = await makeCluster({ nodes: 2, fake: false, patch: () => ({ runtime: { threads: 4, batchThreads: 4 }, timeouts: { connectMs: 3000, firstTokenMs: 120000, streamIdleMs: 60000, defaultDeadlineMs: 180000 } }) });
    [n1, n2] = c.nodes as [TestNode, TestNode];
    await startNode(n1);
    await startNode(n2);
    await waitAvailable(n2, [n1], 30_000);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('installs a catalog model on node1 through the admin API', async () => {
    const r = await fetch(`${n1.url}/admin/models/${Q35}/install`, { method: 'POST', headers: { authorization: `Bearer ${n1.adminToken}` } });
    expect(r.status).toBe(200);
    await waitFor(async () => (await admin(n1, '/admin/models')).models.find((m: any) => m.id === Q35).local.state === 'serving', 60_000, 'serving');
  });

  it('effort "none" answers directly; "low" thinks first (and gets the arithmetic right)', async () => {
    const fast = await ask(n1, { model: Q35, reasoning_effort: 'none', max_tokens: 32, messages: q('What is 17*23? Answer with just the number.') });
    expect(fast.body.choices[0].message.reasoning_content).toBeUndefined();
    const think = await ask(n1, { model: Q35, reasoning_effort: 'low', max_tokens: 32, messages: q('What is 17*23? Answer with just the number.') });
    expect(think.body.choices[0].message.reasoning_content.length).toBeGreaterThan(50);
    expect(think.body.choices[0].message.content).toMatch(/391/);
    expect(think.body.mesh).toMatchObject({ model: Q35, effort: 'low' });
  });

  it('routes a model to the node that serves it (node2 does not host it)', async () => {
    await waitFor(async () => (await (await fetch(`${n2.url}/v1/models`)).json()).data.some((m: any) => m.id === Q35), 20_000, 'n2 sees the model');
    const r = await ask(n2, { model: Q35, reasoning_effort: 'none', max_tokens: 16, messages: q('Say hello.') });
    expect(r.status).toBe(200);
    expect(r.worker).toBe(n1.peerId);
    expect(r.body.mesh.route).toBe('remote');
  });

  it.skipIf(!have('Qwen3-4B-Q4_K_M.gguf'))('the thinking budget stops a long thinker and still gets an answer (Qwen3 4B)', async () => {
    await fetch(`${n2.url}/admin/models/${Q4B}/install`, { method: 'POST', headers: { authorization: `Bearer ${n2.adminToken}` } });
    await waitFor(async () => (await admin(n2, '/admin/models')).models.find((m: any) => m.id === Q4B).local.state === 'serving', 90_000, 'qwen3-4b serving');
    // Unbounded, this question made Qwen3 4B think past 1,200 tokens without answering.
    const r = await ask(n2, { model: Q4B, reasoning_effort: 'low', max_tokens: 48, messages: q('What is 17*23? Answer with just the number.') });
    const usage = r.body.usage;
    expect(r.body.choices[0].message.content.length).toBeGreaterThan(0);
    // budget 512 thinking + 48 answer (+ a few tokens to close the thinking block)
    expect(usage.completion_tokens).toBeLessThanOrEqual(512 + 48 + 16);
  }, 300_000);
});
