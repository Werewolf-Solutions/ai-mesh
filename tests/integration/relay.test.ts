/**
 * Circuit relay v2 path. node1 and node2 are "public" bootstrap+relay nodes.
 * node3 and node4 have NO listening socket (like home machines behind NAT with
 * no port forwarding): they can only dial out. They reach each other solely
 * through relay reservations, and keep working if either relay is lost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, peerView, startNode, stopNode, waitFor, type TestCluster, type TestNode } from '../harness.js';

describe('circuit relay between two NAT-only nodes', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode, n4: TestNode;

  beforeAll(async () => {
    c = await makeCluster({ nodes: 4, patch: (i) => (i >= 3 ? { p2p: { listen: [] } } : {}) });
    [n1, n2, n3, n4] = c.nodes as [TestNode, TestNode, TestNode, TestNode];
    for (const n of c.nodes) await startNode(n);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('home nodes advertise only relay (p2p-circuit) addresses via both relays', async () => {
    await waitFor(async () => {
      const s = await admin(n4, '/admin/status');
      const circ = s.advertisedAddrs.filter((a: string) => a.includes('/p2p-circuit'));
      return circ.some((a: string) => a.includes(n1.peerId)) && circ.some((a: string) => a.includes(n2.peerId));
    }, 20_000, 'n4 reservations on both relays');
    const s = await admin(n4, '/admin/status');
    expect(s.advertisedAddrs.every((a: string) => a.includes('/p2p-circuit'))).toBe(true);
  });

  it('two NAT-only nodes connect through a relay and run inference over it', async () => {
    await waitFor(async () => (await peerView(n3, n4))?.available === true, 25_000, 'n3 sees n4 available');
    const v = await peerView(n3, n4);
    expect(v.relayed).toBe(true);
    const r = await chat(n3, 'hi [[fake:tokens=6]]', { target: n4.peerId });
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-worker')).toBe(n4.peerId);
    expect(r.text).toBe('t0 t1 t2 t3 t4 t5 ');
  });

  it('long streams are not cut by relay limits (no default 2 min / 128 KiB cap on mesh relays)', async () => {
    // ~190 frames: more than enough to cross a small data cap if one were applied.
    const r = await chat(n3, 'x [[fake:tokens=190]] [[fake:delay=2]]', { target: n4.peerId, maxTokens: 256 });
    expect(r.done).toBe(true);
    expect(r.text.split(' ').filter(Boolean).length).toBe(190);
  });

  it.each([
    ['relay node1', () => n1],
    ['relay node2', () => n2],
  ])('survives loss of %s', async (_name, pick) => {
    const lost = pick();
    await stopNode(lost);
    await waitFor(
      async () => {
        const v = await peerView(n3, n4);
        if (!v?.available) return false;
        const r = await chat(n3, 'y [[fake:tokens=3]]', { target: n4.peerId });
        return r.done;
      },
      30_000,
      `n3→n4 via the remaining relay after losing ${lost.name}`,
    );
    await startNode(lost);
    // wait for both reservations again before the next case
    await waitFor(async () => {
      const s = await admin(n4, '/admin/status');
      const circ = s.advertisedAddrs.filter((a: string) => a.includes('/p2p-circuit'));
      return circ.some((a: string) => a.includes(n1.peerId)) && circ.some((a: string) => a.includes(n2.peerId));
    }, 30_000, 'reservations restored');
  });
});
