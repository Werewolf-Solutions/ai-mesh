/**
 * External engines against a stand-in OpenAI-compatible server (like
 * ds4-server): node1 serves it; node2 has never heard of it, sees it through
 * the mesh and uses it. Also: API key, thinking control, budget, engine loss.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, chat, makeCluster, startNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';
import { startStandInEngine, type StandIn } from '../standin-engine.js';

const ID = 'ds4-flash';

describe('external engines (stand-in for ds4-server)', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode;
  let engine: StandIn;

  beforeAll(async () => {
    engine = await startStandInEngine({ apiKey: 'k-standin' });
    c = await makeCluster({ nodes: 2, patch: () => ({ runtime: { fakeTokenDelayMs: 1 } }) });
    [n1, n2] = c.nodes as [TestNode, TestNode];
    await startNode(n1);
    await startNode(n2);
    await waitAvailable(n2, [n1]);
  });
  afterAll(async () => {
    await c?.cleanup();
    await engine?.close();
  });

  const add = (n: TestNode, body: object, token = n.adminToken) =>
    fetch(`${n.url}/admin/engines`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('only the operator can add an engine, and a wrong API key is reported', async () => {
    expect((await add(n1, { id: ID, name: 'DeepSeek V4 Flash', url: engine.url }, n1.clientToken)).status).toBe(403);
    const r = await add(n1, { id: ID, name: 'DeepSeek V4 Flash', url: engine.url });
    expect(r.status).toBe(200);
    const v = await admin(n1, '/admin/engines');
    expect(v.engines[0].status.ready).toBe(false);
    expect(v.engines[0].status.detail).toMatch(/refused the API key/);
  });

  it('with its key, the engine serves the model to the whole pack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wam-key-'));
    await writeFile(join(dir, 'key'), 'k-standin\n', { mode: 0o600 });
    const r = await add(n1, { id: ID, name: 'DeepSeek V4 Flash', url: engine.url, apiKeyFile: join(dir, 'key'), thinking: 'toggle', thinkingControl: 'reasoning_effort', contextTokens: 32768 });
    expect(r.status).toBe(200);
    const v = await admin(n1, '/admin/engines');
    expect(v.engines[0].status.ready).toBe(true);
    expect(v.engines[0].fingerprint).toMatch(/^ds4-flash:ext:[0-9a-f]{64}$/);
    // node2 has no such model in its catalog; it learns it from node1's status.
    await waitFor(async () => (await (await fetch(`${n2.url}/v1/models`)).json()).data.some((m: any) => m.id === ID), 15_000, 'node2 lists the external model');
    const m = (await (await fetch(`${n2.url}/v1/models`)).json()).data.find((x: any) => x.id === ID);
    expect(m.mesh.available).toMatchObject({ nodes: 1, local: false });
  });

  it('a request on node2 is answered by the engine behind node1, marked external', async () => {
    const r = await chat(n2, 'Hello engine', { extra: { model: ID, reasoning_effort: 'none' } });
    expect(r.error).toBeNull();
    expect(r.done).toBe(true);
    expect(r.text).toContain('echo(Hello engine)');
    const first = r.chunks.find((ch) => ch.mesh);
    expect(first.mesh).toMatchObject({ workerPeerId: n1.peerId, route: 'remote', runtime: 'external', model: ID });
    // Fast effort switched the engine's thinking off in its own dialect.
    expect(engine.requests.at(-1).reasoning_effort).toBe('none');
  });

  it('streams thinking separately, and enforces the thinking budget by stopping', async () => {
    const ok = await chat(n2, 'Think a bit [[think=20]]', { extra: { model: ID, reasoning_effort: 'low' } });
    const reasoning = ok.chunks.map((ch) => ch.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(reasoning).toContain('r19');
    expect(ok.text).toContain('echo(Think a bit)');
    // Budget for "low" is 512 thinking tokens: an engine that thinks for 700 is stopped there.
    const long = await chat(n2, 'Think forever [[think=700]]', { extra: { model: ID, reasoning_effort: 'low' } });
    const r2 = long.chunks.map((ch) => ch.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(r2.split(' ').filter(Boolean).length).toBeLessThanOrEqual(512);
    expect(long.chunks.at(-1).choices[0].finish_reason).toBe('length');
  });

  it('when the engine goes away the pack stops routing to it, and it comes back by itself', async () => {
    engine.setDown(true);
    await waitFor(async () => !(await (await fetch(`${n2.url}/v1/models`)).json()).data.some((m: any) => m.id === ID), 30_000, 'model withdrawn');
    const r = await chat(n2, 'anyone?', { stream: false, extra: { model: ID } });
    expect(r.status).toBe(400); // node2 no longer knows the model at all
    engine.setDown(false);
    await waitFor(async () => (await (await fetch(`${n2.url}/v1/models`)).json()).data.some((m: any) => m.id === ID), 30_000, 'model back');
    const again = await chat(n2, 'back?', { extra: { model: ID, reasoning_effort: 'none' } });
    expect(again.text).toContain('echo(back?)');
  });

  it('removing the engine stops serving it', async () => {
    const r = await fetch(`${n1.url}/admin/engines/${ID}`, { method: 'DELETE', headers: { authorization: `Bearer ${n1.adminToken}` } });
    expect(r.status).toBe(200);
    expect((await admin(n1, '/admin/engines')).engines).toEqual([]);
    await waitFor(async () => !(await (await fetch(`${n2.url}/v1/models`)).json()).data.some((m: any) => m.id === ID), 15_000, 'gone from node2');
  });
});
