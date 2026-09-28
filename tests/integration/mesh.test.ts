/**
 * Multi-process mesh behaviour with the DETERMINISTIC FAKE runtime (fault injection).
 * Real-model equivalents live in tests/real/.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, peerView, sleep, startNode, stopNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

describe('4-node mesh (fake runtime)', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode, n4: TestNode;

  beforeAll(async () => {
    c = await makeCluster({ nodes: 4 });
    [n1, n2, n3, n4] = c.nodes as [TestNode, TestNode, TestNode, TestNode];
    for (const n of c.nodes) await startNode(n);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('gives every node a distinct persistent identity', async () => {
    const ids = await Promise.all(c.nodes.map(async (n) => (await admin(n, '/admin/status')).peerId));
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(c.nodes.map((n) => n.peerId));
  });

  it('discovers all peers; non-bootstrap nodes find each other via peer exchange', async () => {
    // node3 and node4 are configured with only node1+node2 as bootstrap and no address for each other.
    await waitAvailable(n3, [n1, n2, n4]);
    await waitAvailable(n4, [n1, n2, n3]);
    const v = await peerView(n3, n4);
    expect(v.connected).toBe(true);
    expect(v.rttMs).toBeGreaterThan(0);
  });

  it('routes a request deliberately to another node and exposes the serving identity', async () => {
    const r = await chat(n3, 'hello [[fake:tokens=5]]', { target: n1.peerId });
    expect(r.status).toBe(200);
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-worker')).toBe(n1.peerId);
    expect(r.headers.get('x-mesh-route')).toBe('remote');
    expect(r.headers.get('x-mesh-runtime')).toBe('fake');
    expect(r.text).toBe('t0 t1 t2 t3 t4 ');
    const last = r.chunks.at(-1);
    expect(last.mesh.workerPeerId).toBe(n1.peerId);
    expect(last.mesh.gatewayPeerId).toBe(n3.peerId);
    expect(last.usage.completion_tokens).toBe(5);
    // worker-measured timings travel back through the gateway (used by the reading-speed test)
    expect(last.mesh.timings.firstTokenMs).toBeGreaterThan(0);
    expect(last.mesh.timings.totalMs).toBeGreaterThanOrEqual(last.mesh.timings.firstTokenMs);
  });

  it('local execution reports worker timings as well', async () => {
    const r = await chat(n3, 'x [[fake:tokens=2]]', { target: 'local', stream: false });
    expect(r.body.mesh.timings.firstTokenMs).toBeGreaterThan(0);
  });

  it('non-streaming responses carry attribution too', async () => {
    const r = await chat(n3, 'x [[fake:tokens=3]]', { target: n2.peerId, stream: false });
    expect(r.status).toBe(200);
    expect(r.body.mesh.workerPeerId).toBe(n2.peerId);
    expect(r.body.choices[0].message.content).toBe('t0 t1 t2 ');
  });

  it('fails over (bounded) when the selected worker hangs before output', async () => {
    n1.proc!.kill('SIGSTOP');
    try {
      const t0 = Date.now();
      const r = await chat(n3, 'x [[fake:tokens=4]]', { prefer: n1.peerId });
      const ms = Date.now() - t0;
      expect(r.status).toBe(200);
      expect(r.done).toBe(true);
      const attempts = r.chunks.at(-1).mesh.attempts;
      expect(attempts[0]).toMatchObject({ workerPeerId: n1.peerId, outcome: 'connect_timeout' });
      expect(attempts.length).toBe(2);
      expect(r.headers.get('x-mesh-worker')).not.toBe(n1.peerId);
      expect(r.text).toBe('t0 t1 t2 t3 '); // exactly ONE generation, never merged
      expect(ms).toBeLessThan(5000);
    } finally {
      n1.proc!.kill('SIGCONT');
    }
  });

  it('never retries more than twice (3 attempts) and reports the last error', async () => {
    const r = await chat(n3, 'x [[fake:fail_after=0]]');
    expect(r.status).toBe(502);
    expect(r.error.code).toBe('runtime_error');
    expect(r.body?.error?.mesh?.attempts?.length ?? r.error.mesh.attempts.length).toBe(3);
  });

  it('marks a stream interrupted when the worker dies after output began (no merge, no success marker)', async () => {
    await waitAvailable(n3, [n2]);
    const r = await chat(n3, 'x [[fake:tokens=50]] [[fake:crash_after=3]]', { prefer: n2.peerId });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-mesh-worker')).toBe(n2.peerId);
    expect(r.done).toBe(false); // no [DONE]
    expect(r.error.code).toBe('interrupted');
    expect(r.text).toBe('t0 t1 t2 '); // partial text preserved, nothing appended from another worker
    expect(r.chunks.some((ch) => ch.choices?.[0]?.finish_reason)).toBe(false);
    expect(r.error.mesh.attempts.length).toBe(1);
    // restart node2 with the same identity
    await waitFor(() => n2.proc!.exitCode !== null || n2.proc!.signalCode !== null, 5000);
    await startNode(n2);
    expect((await admin(n2, '/admin/status')).peerId).toBe(n2.peerId);
    await waitAvailable(n3, [n2]);
  });

  it('propagates client cancellation to the remote worker and frees the slot', async () => {
    const ctl = new AbortController();
    const p = chat(n3, 'x [[fake:tokens=200]] [[fake:delay=100]]', {
      target: n4.peerId,
      signal: ctl.signal,
      onToken: (_t, all) => {
        if (all.length > 6) ctl.abort();
      },
    }).catch(() => null);
    await waitFor(async () => (await admin(n4, '/admin/status')).worker.active === 1, 5000, 'n4 busy');
    await p;
    await waitFor(async () => {
      const s = await admin(n4, '/admin/status');
      return s.worker.active === 0 && s.worker.queued === 0;
    }, 3000, 'n4 slot released');
    const m = await admin(n4, '/admin/metrics');
    expect(m.counters.worker_jobs_cancelled).toBeGreaterThanOrEqual(1);
    // and the slot is actually usable again
    const r = await chat(n3, 'y [[fake:tokens=2]]', { target: n4.peerId });
    expect(r.done).toBe(true);
  });

  it('restarts preserve identity and the peer cache lets nodes reconnect', async () => {
    const before = n4.peerId;
    await stopNode(n4);
    const cache = JSON.parse(await readFile(join(n4.dir, 'peers-cache.json'), 'utf8'));
    expect(cache.peers.length).toBeGreaterThan(0);
    await startNode(n4);
    expect((await admin(n4, '/admin/status')).peerId).toBe(before);
    await waitAvailable(n4, [n1, n2, n3]);
  });

  it('survivors keep serving after BOTH bootstrap nodes stop', async () => {
    await waitAvailable(n3, [n4]);
    await stopNode(n1);
    await stopNode(n2);
    await sleep(500);
    const r = await chat(n3, 'x [[fake:tokens=3]]', { target: n4.peerId });
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-worker')).toBe(n4.peerId);
    // auto-routing still spreads between the two survivors
    const r2 = await chat(n4, 'x [[fake:tokens=3]]', { target: n3.peerId });
    expect(r2.done).toBe(true);
    // gateway view reflects the loss locally
    await waitFor(async () => !(await peerView(n3, n1)).available, 5000, 'n1 unavailable');
  });

  it('draining node refuses new work and peers stop routing to it', async () => {
    const p = stopNode(n4); // SIGTERM → graceful drain
    await p;
    await waitFor(async () => !(await peerView(n3, n4)).available, 5000, 'n4 unavailable');
    const r = await chat(n3, 'x [[fake:tokens=2]]');
    expect(r.done).toBe(true);
    expect(r.headers.get('x-mesh-worker')).toBe(n3.peerId);
  });
});
