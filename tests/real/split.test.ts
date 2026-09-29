/**
 * REAL model splitting: two node processes, llama.cpp b11223. node2 lends its
 * CPU memory (ggml-rpc-server on its loopback); node1 splits a model so half
 * of its layers live in node2's process, reached only through the mesh
 * tunnel. Covers refusal, answering, losing the lender mid-answer, and healing.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, ROOT, startNode, stopNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

const MODEL = 'qwen3.5-0.8b-q8_0';
const have = existsSync(join(ROOT, 'models', 'Qwen3.5-0.8B-Q8_0.gguf')) && existsSync(join(ROOT, '.cache/runtime/llama-b11223/ggml-rpc-server'));

async function post(n: TestNode, path: string, body: object) {
  const r = await fetch(`${n.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${n.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
}
const modelStatus = async (n: TestNode) => (await admin(n, '/admin/status')).models.find((m: any) => m.id === MODEL);
const rpcServers = async () => {
  const { execSync } = await import('node:child_process');
  return execSync('pgrep -x ggml-rpc-server || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
};

// Greedy decoding: the same model gives the same tokens split or not, unless the tunnel corrupts something.
const QUESTION = 'Name three European capitals and one fact about each.';
const ask = (n: TestNode, content = QUESTION) =>
  chat(n, content, { stream: false, token: n.adminToken, extra: { model: MODEL, reasoning_effort: 'none', max_tokens: 48, temperature: 0, seed: 1 } });

describe.skipIf(!have)('real model split across two nodes', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode;
  let unsplit = '';
  beforeAll(async () => {
    c = await makeCluster({
      nodes: 2,
      fake: false,
      patch: () => ({ runtime: { threads: 4, batchThreads: 4 }, timeouts: { connectMs: 3000, firstTokenMs: 120000, streamIdleMs: 60000, defaultDeadlineMs: 180000 } }),
    });
    [n1, n2] = c.nodes as [TestNode, TestNode];
    await startNode(n1);
    await startNode(n2);
    await waitAvailable(n1, [n2], 30_000);
    const r = await post(n1, `/admin/models/${MODEL}/install`, {});
    expect(r.status).toBe(200);
    await waitFor(async () => (await modelStatus(n1))?.state === 'serving', 90_000, 'model serving on node1');
    unsplit = (await ask(n1)).text;
    expect(unsplit.length).toBeGreaterThan(20);
  }, 180_000);
  afterAll(async () => {
    await c?.cleanup();
  });

  it('a lender refuses peers it does not lend to, and the borrower says so', async () => {
    // node2 lends, but only to some other peer.
    const other = '12D3KooWKsxQAVaFXYfd8ekvNZYTffvnPyy6vFjV2gmqNndpL3dn';
    expect((await post(n2, '/admin/split/lend', { enabled: true, peers: [other] })).status).toBe(200);
    await waitFor(async () => (await admin(n1, '/admin/split')).borrow.peers.find((p: any) => p.peerId === n2.peerId)?.lends === true, 20_000, 'node1 sees node2 lending');
    await post(n1, `/admin/models/${MODEL}/split`, { peers: [n2.peerId], localShare: 0.5 });
    await waitFor(async () => /does not lend to this node/.test((await modelStatus(n1))?.detail ?? ''), 60_000, 'refusal reported');
    expect((await admin(n2, '/admin/split')).lend.tunnels.refused).toBeGreaterThan(0);
  }, 120_000);

  it('once allowed, the model runs split: half of its layers in node2', async () => {
    await post(n2, '/admin/split/lend', { enabled: true, peers: [n1.peerId] });
    await waitFor(async () => /split: \d+ of \d+ layers here/.test((await modelStatus(n1))?.detail ?? ''), 90_000, 'split and serving');
    const s = await modelStatus(n1);
    expect(s.state).toBe('serving');
    const r = await ask(n1);
    expect(r.status).toBe(200);
    // Half the layers ran in node2 through the tunnel, and the answer is token-for-token the same.
    expect(r.text).toBe(unsplit);
    const lend = (await admin(n2, '/admin/split')).lend;
    // llama-server's RPC connections to node2 go through the tunnel (they stay open while the model is loaded).
    expect(lend.tunnels.total).toBeGreaterThan(0);
    expect(lend.tunnels.active).toBeGreaterThan(0);
  }, 180_000);

  it('losing the lender interrupts the answer in progress; the model waits, then heals', async () => {
    const ctl = new AbortController();
    const streaming = chat(n1, 'Write 400 words about the history of Paris.', { token: n1.adminToken, signal: ctl.signal, extra: { model: MODEL, reasoning_effort: 'none', max_tokens: 600 } });
    await new Promise((r) => setTimeout(r, 2500));
    await stopNode(n2, 'SIGKILL');
    const res = await streaming;
    expect(res.done).toBe(false); // never a silent, truncated "success"
    await waitFor(async () => /waiting for them/.test((await modelStatus(n1))?.detail ?? ''), 60_000, 'waiting for the lender');
    expect(await rpcServers()).toBe(0); // node2's ggml-rpc-server died with it
    await startNode(n2);
    await waitFor(async () => /split: /.test((await modelStatus(n1))?.detail ?? '') && (await modelStatus(n1))?.state === 'serving', 120_000, 'split again');
    // After healing, still identical to the unsplit answer.
    expect((await ask(n1)).text).toBe(unsplit);
  }, 300_000);
});
