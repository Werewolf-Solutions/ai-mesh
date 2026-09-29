/**
 * Several models in one mesh (fake runtime): model-aware routing, the catalog
 * view, effort/thinking (streamed separately, budget enforced), and installing
 * a model on a node through the admin API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, startNode, waitFor, waitAvailable, type TestCluster, type TestNode } from '../harness.js';

const CATALOG = ['fake-a', 'fake-b-think', 'fake-c'];

describe('multi-model mesh', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode;
  beforeAll(async () => {
    c = await makeCluster({
      nodes: 3,
      patch: (i) => ({
        runtime: { fakeModels: CATALOG, fakeTokenDelayMs: 1 },
        // node1: fake-a · node2: fake-b-think · node3: fake-a
        model: { host: i === 2 ? ['fake-b-think'] : ['fake-a'] },
      }),
    });
    [n1, n2, n3] = c.nodes as [TestNode, TestNode, TestNode];
    for (const n of c.nodes) await startNode(n);
    await waitAvailable(n1, [n2, n3]);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('lists models the pack serves, and the whole catalog on request', async () => {
    await waitFor(async () => {
      const r = await (await fetch(`${n1.url}/v1/models`)).json();
      return r.data.length === 2;
    }, 10_000, 'both served models visible');
    const r = await (await fetch(`${n1.url}/v1/models`)).json();
    const byId = Object.fromEntries(r.data.map((m: any) => [m.id, m.mesh]));
    expect(byId['fake-a'].available).toMatchObject({ nodes: 2, local: true });
    expect(byId['fake-b-think'].available).toMatchObject({ nodes: 1, local: false });
    expect(byId['fake-c']).toBeUndefined();
    const all = await (await fetch(`${n1.url}/v1/models?all=1`)).json();
    expect(all.data.map((m: any) => m.id)).toEqual(CATALOG);
    expect(all.data.find((m: any) => m.id === 'fake-c').mesh.available.nodes).toBe(0);
  });

  it('routes a model only to nodes serving it', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await chat(n1, 'x [[fake:tokens=2]]', { extra: { model: 'fake-b-think', reasoning_effort: 'none' } });
      expect(r.done).toBe(true);
      expect(r.headers.get('x-mesh-worker')).toBe(n2.peerId);
    }
    const a = await chat(n2, 'x [[fake:tokens=2]]', { extra: { model: 'fake-a' } });
    expect([n1.peerId, n3.peerId]).toContain(a.headers.get('x-mesh-worker'));
  });

  it('says clearly when no reachable node serves a model, and rejects unknown models', async () => {
    const none = await chat(n1, 'x', { extra: { model: 'fake-c' } });
    expect(none.status).toBe(503);
    expect(none.error.code).toBe('no_workers');
    const unknown = await chat(n1, 'x', { extra: { model: 'not-a-model' } });
    expect(unknown.status).toBe(400);
  });

  it('streams thinking separately from the answer, and effort "none" turns it off', async () => {
    const r = await chat(n1, 'x [[fake:tokens=3]] [[fake:think=4]]', { extra: { model: 'fake-b-think', reasoning_effort: 'medium' } });
    const reasoning = r.chunks.map((ch) => ch.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(reasoning).toBe('r0 r1 r2 r3 ');
    expect(r.text).toBe('t0 t1 t2 ');
    const firstContent = r.chunks.findIndex((ch) => ch.choices?.[0]?.delta?.content);
    const lastReasoning = r.chunks.map((ch) => !!ch.choices?.[0]?.delta?.reasoning_content).lastIndexOf(true);
    expect(lastReasoning).toBeLessThan(firstContent);
    expect(r.chunks.at(-1).mesh).toMatchObject({ model: 'fake-b-think', effort: 'medium' });
    const off = await chat(n1, 'x [[fake:tokens=3]] [[fake:think=4]]', { extra: { model: 'fake-b-think', reasoning_effort: 'none' } });
    expect(off.chunks.some((ch) => ch.choices?.[0]?.delta?.reasoning_content)).toBe(false);
    const ns = await chat(n1, 'x [[fake:tokens=2]] [[fake:think=2]]', { stream: false, extra: { model: 'fake-b-think', reasoning_effort: 'high' } });
    expect(ns.body.choices[0].message.reasoning_content).toBe('r0 r1 ');
  });

  it('enforces the thinking budget chosen by effort', async () => {
    // context 2048, max_tokens 64: effort "low" → budget 512 (fits: 1024 room − 64 answer)
    const r = await chat(n1, 'x [[fake:tokens=1]] [[fake:think=900]]', { extra: { model: 'fake-b-think', reasoning_effort: 'low' } });
    expect(r.chunks.filter((ch) => ch.choices?.[0]?.delta?.reasoning_content).length).toBe(512);
    // a larger answer leaves less room: max_tokens 768 → budget min(512, 1024 − 768) = 256
    const r2 = await chat(n1, 'x [[fake:tokens=1]] [[fake:think=900]]', { maxTokens: 768, extra: { model: 'fake-b-think', reasoning_effort: 'low' } });
    expect(r2.chunks.filter((ch) => ch.choices?.[0]?.delta?.reasoning_content).length).toBe(256);
    expect(r.done).toBe(true);
  });

  it('installs a catalog model on a node through the admin API; the pack can use it at once', async () => {
    expect((await fetch(`${n3.url}/admin/models/fake-c/install`, { method: 'POST', headers: { authorization: `Bearer ${n3.clientToken}` } })).status).toBe(403);
    const ok = await fetch(`${n3.url}/admin/models/fake-c/install`, { method: 'POST', headers: { authorization: `Bearer ${n3.adminToken}` } });
    expect(ok.status).toBe(200);
    await waitFor(async () => (await admin(n3, '/admin/models')).models.find((m: any) => m.id === 'fake-c').local.state === 'serving', 10_000, 'fake-c serving on n3');
    await waitFor(async () => {
      const r = await chat(n1, 'x [[fake:tokens=2]]', { extra: { model: 'fake-c' } });
      return r.done && r.headers.get('x-mesh-worker') === n3.peerId;
    }, 10_000, 'n1 routes fake-c to n3');
    // survives a restart (hosted list persisted in models-state.json)
    await c.stopAll();
    await startNode(n3);
    expect((await admin(n3, '/admin/status')).models.map((m: any) => m.id).sort()).toEqual(['fake-a', 'fake-c']);
    await c.start(n1);
    await c.start(n2);
  });

  it('unhosting stops serving a model', async () => {
    await (await fetch(`${n3.url}/admin/models/fake-c/unhost`, { method: 'POST', headers: { authorization: `Bearer ${n3.adminToken}` } })).json();
    expect((await admin(n3, '/admin/status')).models.map((m: any) => m.id)).toEqual(['fake-a']);
  });

  it("reports this computer's resources to the operator only", async () => {
    const r = await fetch(`${n1.url}/admin/system`, { headers: { authorization: `Bearer ${n1.clientToken}` } });
    expect(r.status).toBe(403);
    const v = await admin(n1, '/admin/system');
    expect(v.cpu.threads).toBeGreaterThan(0);
    expect(v.memory.totalMB).toBeGreaterThan(0);
    expect(v.mesh.node.rssMB).toBeGreaterThan(10);
    // Fake runtimes are not OS processes: listed, but with no pid or usage.
    expect(v.mesh.runtimes.map((x: any) => [x.name, x.pid])).toEqual([['FAKE fake-a', null]]);
  });
});
