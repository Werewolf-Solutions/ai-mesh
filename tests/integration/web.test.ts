/**
 * Web research through a real node process (fake model runtime): a stand-in
 * SearXNG and a local web page. Checks the streamed steps and sources, who may
 * use it, what happens when search is down, and that only result URLs are read.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chat, makeCluster, startNode, type TestCluster, type TestNode } from '../harness.js';

describe('web research', () => {
  let c: TestCluster;
  let n: TestNode;
  let web: http.Server;
  let base = '';
  const pageHits: string[] = [];
  const queries: string[] = [];
  let searchDown = false;

  beforeAll(async () => {
    web = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/search') {
        queries.push(u.searchParams.get('q') ?? '');
        if (searchDown) {
          res.writeHead(500);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            results: [
              { title: 'Wolf facts', url: `${base}/wolves`, content: 'Wolves live in packs.' },
              { title: 'A PDF', url: `${base}/paper.pdf`, content: 'A paper about wolves.' },
              { title: 'Metadata trap', url: 'http://169.254.169.254/latest/meta-data/', content: 'Cloud metadata.' },
              { title: 'Other', url: `${base}/other`, content: 'Other page summary.' },
            ],
          }),
        );
      }
      pageHits.push(u.pathname);
      if (u.pathname === '/wolves' || u.pathname === '/other') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<html><head><title>Wolf facts</title></head><body><article>${'<p>A gray wolf pack usually has five to nine members, led by the breeding pair.</p>'.repeat(8)}</article></body></html>`);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
    // Clusters have at least two nodes; only the first is started.
    c = await makeCluster({
      nodes: 2,
      patch: () => ({
        runtime: { fakeTokenDelayMs: 1 },
        agent: { web: { searxUrl: base, unsafeAllowLoopback: true, fetchTimeoutMs: 3000 } },
      }),
    });
    n = c.nodes[0]!;
    await startNode(n);
  });
  afterAll(async () => {
    await c?.cleanup();
    web?.closeAllConnections();
    web?.close();
  });

  it('streams the steps and sources before the answer, and gives the model the page text', async () => {
    pageHits.length = 0;
    const plain = await chat(n, 'How big is a wolf pack?', { stream: false, token: n.adminToken });
    const r = await chat(n, 'How big is a wolf pack?', { token: n.adminToken, extra: { mesh: { web: 'on' } } });
    expect(r.error).toBeNull();
    expect(r.done).toBe(true);
    const agent = r.chunks.map((ch) => ch.mesh?.agent).filter(Boolean);
    const steps = agent.filter((a) => a.step).map((a) => `${a.step.kind}:${a.step.status}`);
    expect(steps).toEqual(['query:running', 'query:done', 'search:running', 'search:done', 'read:running', 'read:done', 'answer:running']);
    const firstText = r.chunks.findIndex((ch) => ch.choices?.[0]?.delta?.content);
    const lastAgent = r.chunks.map((ch) => !!ch.mesh?.agent).lastIndexOf(true);
    expect(lastAgent).toBeLessThan(firstText);
    const sources = agent.find((a) => a.sources)!.sources;
    expect(sources.map((s: any) => [s.kind, s.url])).toEqual([
      ['page', `${base}/wolves`],
      ['page', `${base}/other`],
      ['snippet', `${base}/paper.pdf`],
    ]);
    // The PDF is not read (summary only); the metadata address is dropped from the results.
    expect(pageHits.sort()).toEqual(['/other', '/wolves']);
    expect(queries.at(-1)).toBe('How big is a wolf pack');
    // Attribution arrives with the first text; the answer carried the pages as context.
    expect(r.chunks[firstText].mesh.workerPeerId).toBe(n.peerId);
    const usage = r.chunks.at(-1).usage;
    expect(usage.prompt_tokens).toBeGreaterThan(plain.body.usage.prompt_tokens + 100);
  });

  it('"auto" searches only when asked, and never for another operator\'s client', async () => {
    const before = queries.length;
    const plain = await chat(n, 'Explain recursion', { stream: false, token: n.adminToken, extra: { mesh: { web: 'auto' } } });
    expect(plain.body.mesh.web).toBeUndefined();
    const asked = await chat(n, 'search the web for wolf pack size', { stream: false, token: n.adminToken, extra: { mesh: { web: 'auto' } } });
    expect(asked.body.mesh.web.sources.length).toBeGreaterThan(0);
    expect(queries.length).toBe(before + 1);
    // A client token (someone using this node as their gateway) cannot make it search.
    const client = await chat(n, 'search the web for wolf pack size', { stream: false, extra: { mesh: { web: 'auto' } } });
    expect(client.status).toBe(200);
    expect(client.body.mesh.web).toBeUndefined();
    const forced = await chat(n, 'wolves', { stream: false, extra: { mesh: { web: 'on' } } });
    expect(forced.status).toBe(403);
    expect(queries.length).toBe(before + 1);
  });

  it('reports a clear error when the search engine is down', async () => {
    searchDown = true;
    try {
      const r = await chat(n, 'wolves', { stream: false, token: n.adminToken, extra: { mesh: { web: 'on' } } });
      expect(r.status).toBe(502);
      expect(r.error.code).toBe('tool_failed');
      expect(r.error.message).toMatch(/HTTP 500/);
      const s = await chat(n, 'wolves', { token: n.adminToken, extra: { mesh: { web: 'on' } } });
      expect(s.done).toBe(false);
      expect(s.error.code).toBe('tool_failed');
      expect(s.chunks.some((ch) => ch.mesh?.agent?.step?.status === 'failed')).toBe(true);
    } finally {
      searchDown = false;
    }
  });
});
