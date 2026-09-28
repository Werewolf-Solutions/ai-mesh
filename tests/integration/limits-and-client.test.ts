/**
 * Saturation, bounded resources, queued-job cancellation, and client gateway fallback.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeshClient } from '@werewolf-mesh/client';
import { admin, chat, makeCluster, sleep, startNode, stopNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

describe('limits, cancellation of queued jobs, and client fallback', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode;

  beforeAll(async () => {
    c = await makeCluster({ nodes: 2, patch: () => ({ http: { maxInFlight: 64 } }) });
    [n1, n2] = c.nodes as [TestNode, TestNode];
    await startNode(n1);
    await startNode(n2);
    await waitAvailable(n1, [n2]);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('saturated worker queue rejects predictably: 1 running + 8 queued accepted, rest busy with Retry-After', async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => chat(n1, `job${i} [[fake:tokens=3]] [[fake:delay=60]]`, { target: 'local', stream: false }));
    const res = await Promise.all(jobs);
    const ok = res.filter((r) => r.status === 200);
    const busy = res.filter((r) => r.status === 429);
    expect(ok.length).toBe(9);
    expect(busy.length).toBe(3);
    for (const b of busy) {
      expect(b.error.code).toBe('busy');
      expect(b.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(b.error.retry_after_ms).toBeGreaterThan(0);
    }
    const s = await admin(n1, '/admin/status');
    expect(s.worker).toMatchObject({ active: 0, queued: 0 });
  });

  it('auto routing spills load onto the other node instead of rejecting', async () => {
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => chat(n1, `s${i} [[fake:tokens=3]] [[fake:delay=80]]`, { stream: false })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const workers = new Set(res.map((r) => r.body.mesh.workerPeerId));
    expect(workers).toEqual(new Set([n1.peerId, n2.peerId]));
  });

  it('cancelling a QUEUED job removes it from the queue', async () => {
    const running = chat(n1, 'long [[fake:tokens=30]] [[fake:delay=50]]', { target: 'local' });
    await waitFor(async () => (await admin(n1, '/admin/status')).worker.active === 1, 3000);
    const ctl = new AbortController();
    const queued = chat(n1, 'q [[fake:tokens=3]]', { target: 'local', signal: ctl.signal }).catch(() => null);
    await waitFor(async () => (await admin(n1, '/admin/status')).worker.queued === 1, 3000, 'queued');
    ctl.abort();
    await queued;
    await waitFor(async () => (await admin(n1, '/admin/status')).worker.queued === 0, 3000, 'queue drained');
    expect((await running).done).toBe(true);
  });

  it('memory and connection counts stay bounded after a burst', async () => {
    const before = await admin(n1, '/admin/metrics');
    await Promise.all(Array.from({ length: 40 }, (_, i) => chat(n1, `b${i} [[fake:tokens=2]] [[fake:delay=1]]`, { stream: false })));
    const after = await admin(n1, '/admin/metrics');
    expect(after.connections).toBeLessThanOrEqual(4);
    expect(after.trackedPeers).toBe(1);
    expect(after.dedupEntries).toBeLessThanOrEqual(2048);
    expect(after.memory.rssBytes - before.memory.rssBytes).toBeLessThan(80 * 1024 * 1024);
  });

  it('scores summaries with ROUGE-L and reports when the meaning scorer is off', async () => {
    const r = await fetch(`${n1.url}/v1/mesh/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${n1.clientToken}` },
      body: JSON.stringify({ reference: 'the pack shares the work', candidates: ['the pack shares the work', 'bread needs flour'] }),
    });
    const j = await r.json();
    expect(j.rougeL[0].f1).toBe(1);
    expect(j.rougeL[1].f1).toBe(0);
    expect(j.semantic).toMatchObject({ available: false });
    const bad = await fetch(`${n1.url}/v1/mesh/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${n1.clientToken}` },
      body: JSON.stringify({ reference: 'x', candidates: Array(21).fill('y') }),
    });
    expect(bad.status).toBe(400);
  });

  it('client fails over to the next gateway before output, and remembers the good one', async () => {
    const client = new MeshClient([
      { url: 'http://127.0.0.1:1', token: 'x' }, // nothing listening
      { url: n2.url, token: 'wrong-token-00000000000000000000' }, // 401 → gateway-specific, try next
      { url: n1.url, token: n1.clientToken },
    ]);
    const r = await client.chat({ messages: [{ role: 'user', content: 'hi [[fake:tokens=4]]' }] });
    expect(r.status).toBe('completed');
    expect(r.text).toBe('t0 t1 t2 t3 ');
    expect(r.gatewayAttempts.map((a) => a.error.code)).toEqual(['gateway_unreachable', 'unauthorized']);
    if (r.status === 'completed') expect(r.meta.gatewayUrl).toBe(n1.url);
    expect(client.orderedGateways()[0]!.url).toBe(n1.url);
  });

  it('client never merges answers: a mid-stream failure is "interrupted" and the next gateway is NOT called', async () => {
    let hits = 0;
    const spy: Server = createServer((_req, res) => {
      hits++;
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => spy.listen(0, '127.0.0.1', () => r()));
    const spyUrl = `http://127.0.0.1:${(spy.address() as { port: number }).port}`;
    try {
      const client = new MeshClient([
        { url: n1.url, token: n1.clientToken },
        { url: spyUrl },
      ]);
      const r = await client.chat({ messages: [{ role: 'user', content: 'x [[fake:tokens=40]] [[fake:crash_after=4]]' }], target: n2.peerId });
      expect(r.status).toBe('interrupted');
      expect(r.text).toBe('t0 t1 t2 t3 ');
      expect(hits).toBe(0);
    } finally {
      spy.close();
      await waitFor(() => n2.proc!.exitCode !== null || n2.proc!.signalCode !== null, 5000);
      await startNode(n2);
    }
  });

  it('client treats a stream cut without [DONE] as interrupted (gateway process killed)', async () => {
    await waitAvailable(n1, [n2]);
    const client = new MeshClient([{ url: n2.url, token: n2.clientToken }]);
    const r = await client.chat({
      messages: [{ role: 'user', content: 'x [[fake:tokens=100]] [[fake:delay=50]]' }],
      target: 'local',
      onToken: (_t, full) => {
        if (full.length === 3) n2.proc!.kill('SIGKILL');
      },
    });
    expect(r.status).toBe('interrupted');
    expect(r.text.startsWith('t0 ')).toBe(true);
    await sleep(200);
    await stopNode(n2);
  });
});
