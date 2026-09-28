/**
 * Pack memory across separate node processes: anonymous notes, pull-based
 * replication, delayed publication, anonymous withdrawal, local-only
 * reinforcement and moderation. (Meaning-based search/retrieval needs the
 * embedding model and is covered in tests/real.)
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCluster, sleep, startNode, waitFor, waitAvailable, type TestCluster, type TestNode } from '../harness.js';

const token = () => randomBytes(32).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function api(n: TestNode, path: string, body?: unknown, auth = n.clientToken) {
  const r = await fetch(`${n.url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}
const has = async (n: TestNode, id: string) => (await api(n, '/v1/pack/notes?limit=100')).body.notes.some((v: any) => v.note.id === id);

describe('pack memory', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode;
  beforeAll(async () => {
    // node2 holds its own notes back for 3 s before peers may pull them.
    c = await makeCluster({ nodes: 3, patch: (i) => (i === 2 ? { pack: { publishDelayMinMs: 3000, publishDelayMaxMs: 3000 } } : {}) });
    [n1, n2, n3] = c.nodes as [TestNode, TestNode, TestNode];
    for (const n of c.nodes) await startNode(n);
    await waitAvailable(n3, [n1, n2]);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  let noteId = '';
  const secret = token();

  it('stores a shared note anonymously and scrubs personal data', async () => {
    const r = await api(n1, '/v1/pack/notes', {
      kind: 'solution',
      title: 'Printer offline after router change',
      problem: 'My printer shows offline. Mail me at jane.doe@example.org or call +44 20 7946 0958.',
      solution: 'Give the printer a fixed address in the router (192.168.1.50) and re-add it.',
      tags: ['printer', 'Network'],
      withdrawHash: sha(secret),
    });
    expect(r.status).toBe(200);
    noteId = r.body.id;
    expect(r.body.removed).toEqual(expect.arrayContaining(['email address', 'phone number', 'IP address']));
    const n = r.body.note;
    expect(Object.keys(n).sort()).toEqual(['day', 'id', 'kind', 'problem', 'solution', 'tags', 'title', 'v', 'withdrawHash']);
    expect(n.problem).not.toContain('jane.doe');
    expect(n.problem).not.toContain('7946');
    expect(n.solution).not.toContain('192.168.1.50');
    expect(n.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(n.tags).toEqual(['printer', 'network']);
    expect(JSON.stringify(n)).not.toContain(n1.peerId);
  });

  it('replicates to every node by pull-based sync', async () => {
    await waitFor(() => has(n2, noteId), 10_000, 'n2 has the note');
    await waitFor(() => has(n3, noteId), 10_000, 'n3 has the note');
  });

  it('holds a new note back for the publish delay (hides which node published it)', async () => {
    const r = await api(n2, '/v1/pack/notes', { kind: 'idea', title: 'Label the cables', problem: '', solution: 'Label both ends of every cable.', tags: [], withdrawHash: sha(token()) });
    const id = r.body.id;
    expect((await api(n2, '/v1/pack/stats')).body.waitingToSpread).toBe(1);
    await sleep(1500);
    expect(await has(n1, id)).toBe(false);
    await waitFor(() => has(n1, id), 10_000, 'n1 gets the delayed note');
  });

  it('refuses a withdrawal with the wrong token; accepts the right one from ANY gateway and removes it everywhere', async () => {
    const wrong = await api(n3, '/v1/pack/withdraw', { noteId, token: token() });
    expect(wrong.status).toBe(403);
    expect(await has(n3, noteId)).toBe(true);
    // Withdraw through node3, not the node where it was shared: nothing ties the author to a node.
    const ok = await api(n3, '/v1/pack/withdraw', { noteId, token: secret });
    expect(ok.status).toBe(200);
    await waitFor(async () => !(await has(n1, noteId)) && !(await has(n2, noteId)), 10_000, 'withdrawal spread');
    // A withdrawn note is not re-imported by later syncs.
    await sleep(1000);
    expect(await has(n1, noteId)).toBe(false);
  });

  it('keeps "this helped" and hiding local to one node', async () => {
    const r = await api(n1, '/v1/pack/notes', { kind: 'howto', title: 'Restart the network service', problem: '', solution: 'Run: sudo systemctl restart NetworkManager', tags: [], withdrawHash: sha(token()) });
    const id = r.body.id;
    await waitFor(() => has(n2, id), 10_000, 'replicated');
    expect((await api(n1, `/v1/pack/notes/${id}/helped`, {})).status).toBe(200);
    const w1 = (await api(n1, '/v1/pack/notes?limit=100')).body.notes.find((v: any) => v.note.id === id).weight;
    const w2 = (await api(n2, '/v1/pack/notes?limit=100')).body.notes.find((v: any) => v.note.id === id).weight;
    expect(w1).toBeGreaterThan(0);
    expect(w2).toBe(0);
    // Hide needs the admin token; hidden only on node1.
    expect((await api(n1, '/admin/pack/hide', { id, hidden: true })).status).toBe(403);
    expect((await api(n1, '/admin/pack/hide', { id, hidden: true }, n1.adminToken)).status).toBe(200);
    expect(await has(n1, id)).toBe(false);
    expect(await has(n2, id)).toBe(true);
  });

  it('rejects malformed notes', async () => {
    const bad = await api(n1, '/v1/pack/notes', { kind: 'solution', title: 'x', problem: '', solution: 'y', tags: [], withdrawHash: 'nothex' });
    expect(bad.status).toBe(400);
    const extra = await api(n1, '/v1/pack/notes', { kind: 'solution', title: 'ok title', problem: '', solution: 'ok solution', tags: [], withdrawHash: sha('x'), author: 'me' });
    expect(extra.status).toBe(400);
  });
});
