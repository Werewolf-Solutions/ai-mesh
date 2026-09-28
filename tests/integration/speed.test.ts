/**
 * Speed-aware routing: the gateway measures each node's real answer speed per
 * model and prefers the faster one (e.g. a GPU node), even over its own idle
 * CPU. Speeds come from what the gateway observed, never from what a node claims.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, startNode, waitAvailable, type TestCluster, type TestNode } from '../harness.js';

describe('speed-aware routing', () => {
  let c: TestCluster;
  let slow: TestNode, fast: TestNode, gw: TestNode;
  beforeAll(async () => {
    // node1: slow (40 ms/token) · node2: fast (2 ms/token) · node3: the gateway, also slow
    c = await makeCluster({ nodes: 3, patch: (i) => ({ runtime: { fakeTokenDelayMs: i === 2 ? 2 : 40 } }) });
    [slow, fast, gw] = c.nodes as [TestNode, TestNode, TestNode];
    for (const n of c.nodes) await startNode(n);
    await waitAvailable(gw, [slow, fast]);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('learns which node is faster and sends new work there', async () => {
    // Let the gateway observe each node once (prefer = first choice, normal failover).
    await chat(gw, 'x [[fake:tokens=20]]', { prefer: slow.peerId });
    await chat(gw, 'x [[fake:tokens=20]]', { prefer: fast.peerId });
    await chat(gw, 'x [[fake:tokens=20]]', { target: 'local' });
    const workers: string[] = [];
    for (let i = 0; i < 4; i++) workers.push((await chat(gw, 'x [[fake:tokens=20]]')).headers.get('x-mesh-worker')!);
    expect(new Set(workers)).toEqual(new Set([fast.peerId]));
    const peers = (await admin(gw, '/admin/peers')).peers;
    const f = peers.find((p: any) => p.peerId === fast.peerId);
    const s = peers.find((p: any) => p.peerId === slow.peerId);
    expect(f.measuredTokPerS).toBeGreaterThan(s.measuredTokPerS * 3);
    expect(f.accel).toBe('cpu'); // it claims nothing special; speed was measured
  });
});
