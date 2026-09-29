/**
 * WebSocket transport: a public node reachable only over /ws (as behind nginx
 * on 443, where nginx terminates TLS and forwards to a loopback /ws listener).
 * node1 has no TCP listener at all, so every connection to it is WebSocket.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, startNode, waitAvailable, type TestCluster, type TestNode } from '../harness.js';

describe('WebSocket transport', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode;
  let wsPort = 0;
  beforeAll(async () => {
    c = await makeCluster({ nodes: 2, patch: () => ({ runtime: { fakeTokenDelayMs: 1 } }) });
    [n1, n2] = c.nodes as [TestNode, TestNode];
    wsPort = n1.p2pPort + 100;
    const edit = async (n: TestNode, fn: (cfg: any) => void) => {
      const p = join(n.dir, 'node.json');
      const cfg = JSON.parse(await readFile(p, 'utf8'));
      fn(cfg);
      await writeFile(p, JSON.stringify(cfg, null, 2));
    };
    await edit(n1, (cfg) => {
      cfg.p2p.listen = [`/ip4/127.0.0.1/tcp/${wsPort}/ws`];
    });
    await edit(n2, (cfg) => {
      cfg.p2p.bootstrap = [`/ip4/127.0.0.1/tcp/${wsPort}/ws/p2p/${n1.peerId}`];
    });
    await startNode(n1);
    await startNode(n2);
    await waitAvailable(n2, [n1], 20_000);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('connects and answers over WebSocket only', async () => {
    const view = (await admin(n2, '/admin/peers')).peers.find((p: any) => p.peerId === n1.peerId);
    expect(view.addrs.some((a: string) => a.includes('/ws'))).toBe(true);
    const r = await chat(n2, 'hello over websocket [[fake:tokens=8]]', { extra: { mesh: { target: n1.peerId } } });
    expect(r.error).toBeNull();
    expect(r.done).toBe(true);
    expect(r.chunks.find((ch) => ch.mesh)?.mesh.workerPeerId).toBe(n1.peerId);
  });

  it('refuses unapproved peers on the WebSocket listener too', async () => {
    const { createLibp2p } = await import('libp2p');
    const { webSockets } = await import('@libp2p/websockets');
    const { noise } = await import('@chainsafe/libp2p-noise');
    const { yamux } = await import('@chainsafe/libp2p-yamux');
    const { multiaddr } = await import('@multiformats/multiaddr');
    const stranger = await createLibp2p({ transports: [webSockets()], connectionEncrypters: [noise()], streamMuxers: [yamux()] });
    try {
      await expect(stranger.dial(multiaddr(`/ip4/127.0.0.1/tcp/${wsPort}/ws/p2p/${n1.peerId}`), { signal: AbortSignal.timeout(5000) }).then(async (conn) => {
        // The gater closes it right after the handshake; any stream attempt fails.
        await conn.newStream('/ipfs/ping/1.0.0', { signal: AbortSignal.timeout(3000) });
      })).rejects.toThrow();
    } finally {
      await stranger.stop();
    }
  });
});
