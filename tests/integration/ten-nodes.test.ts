/**
 * Ten distinct node processes (fake runtime: this checks mesh formation and
 * bounded state, not inference throughput). Each node is configured with only
 * the two bootstrap nodes; everything else is learned by peer exchange.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, startNode, waitFor, type TestCluster } from '../harness.js';

describe('10-node mesh formation', () => {
  let c: TestCluster;
  beforeAll(async () => {
    c = await makeCluster({ nodes: 10 });
    await Promise.all(c.nodes.map((n) => startNode(n)));
  }, 120_000);
  afterAll(async () => {
    await c?.cleanup();
  });

  it('every node sees the other nine as available, with bounded connections', async () => {
    for (const n of c.nodes) {
      await waitFor(async () => (await admin(n, '/admin/peers')).peers.filter((p: any) => p.available).length === 9, 30_000, `${n.name} sees 9 peers`);
    }
    const ids = new Set(await Promise.all(c.nodes.map(async (n) => (await admin(n, '/admin/status')).peerId)));
    expect(ids.size).toBe(10);
    for (const n of c.nodes) {
      const m = await admin(n, '/admin/metrics');
      expect(m.trackedPeers).toBe(9);
      expect(m.connections).toBeLessThanOrEqual(18);
    }
  }, 120_000);

  it('the last node can route to the first and vice versa', async () => {
    const [first, last] = [c.nodes[0]!, c.nodes[9]!];
    expect((await chat(last, 'x [[fake:tokens=2]]', { target: first.peerId })).headers.get('x-mesh-worker')).toBe(first.peerId);
    expect((await chat(first, 'x [[fake:tokens=2]]', { target: last.peerId })).headers.get('x-mesh-worker')).toBe(last.peerId);
  });
});
