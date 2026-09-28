import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { lpStream, streamPair } from '@libp2p/utils';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Admission, writeAuthorized } from '../../apps/node/src/admission.js';
import { NodeConfigSchema } from '../../apps/node/src/config.js';
import { rankCandidates } from '../../apps/node/src/gateway/router.js';
import { ensureIdentity } from '../../apps/node/src/identity.js';
import { FrameStream } from '../../apps/node/src/p2p/framing.js';
import { peerIdOfAddr } from '../../apps/node/src/p2p/peers.js';
import { TokenChecker } from '../../apps/node/src/secrets.js';
import { atomicWriteJson } from '../../apps/node/src/util/fs.js';
import { DedupCache } from '../../apps/node/src/worker/dedup.js';
import { WorkerPool } from '../../apps/node/src/worker/pool.js';
import { InferRequest, MeshError, SseParser, StatusExchange, WorkerFrame } from '@werewolf-mesh/protocol';

const tmp = () => mkdtemp(join(tmpdir(), 'wam-unit-'));

describe('framing', () => {
  it('round-trips a valid frame and rejects wrong version / malformed / oversized', async () => {
    const [a, b] = await streamPair();
    const fa = new FrameStream(a, 1024);
    const fb = new FrameStream(b, 1024);
    await fa.write({ v: 2, type: 'cancelled' });
    expect(await fb.read(WorkerFrame)).toEqual({ v: 2, type: 'cancelled' });

    await lpStream(a).write(new TextEncoder().encode(JSON.stringify({ v: 3, type: 'cancelled' })));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/unsupported protocol version/);

    await lpStream(a).write(new TextEncoder().encode('{nope'));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/malformed/);

    await lpStream(a).write(new Uint8Array([0xff, 0xfe]));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/malformed/); // invalid UTF-8

    await expect(fa.write({ v: 2, type: 'token', seq: 0, text: 'x'.repeat(2000) })).rejects.toThrow(/exceeds/);
  });

  it('refuses an incoming frame larger than the limit', async () => {
    const [a, b] = await streamPair();
    const fb = new FrameStream(b, 64);
    await lpStream(a).write(new Uint8Array(200));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/exceeds 64 bytes/);
  });
});

describe('schemas', () => {
  const base = {
    v: 2,
    type: 'infer',
    requestId: 'r1',
    attemptId: 'a1',
    originPeerId: '12D3KooWGwNG4YVDhEuz3HVs1L5kaCpyXhLe2pHAAzuPfxQExNBd',
    model: 'm:sha256:x',
    messages: [{ role: 'user', content: 'hi' }],
    settings: { maxTokens: 10 },
    deadlineMs: 1000,
  };
  it('accepts a valid inference request and rejects unknown fields and limits', () => {
    expect(InferRequest.safeParse(base).success).toBe(true);
    expect(InferRequest.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(InferRequest.safeParse({ ...base, settings: { maxTokens: 20000 } }).success).toBe(false);
    expect(InferRequest.safeParse({ ...base, settings: { maxTokens: 64, thinking: { mode: 'on', budget: 512 } } }).success).toBe(true);
    expect(InferRequest.safeParse({ ...base, settings: { maxTokens: 64, thinking: { mode: 'maybe' } } }).success).toBe(false);
    expect(InferRequest.safeParse({ ...base, messages: [] }).success).toBe(false);
    expect(InferRequest.safeParse({ ...base, requestId: 'has space' }).success).toBe(false);
  });
  it('bounds peer-exchange hints', () => {
    const hint = { peerId: base.originPeerId, addrs: ['/ip4/1.2.3.4/tcp/1'] };
    const status = { peerId: base.originPeerId, networkId: 'n', protocolVersion: 2, softwareVersion: 'x', state: 'ready', inferenceReady: true, models: [], modelLoad: [], activeJobs: 0, queueLength: 0, maxConcurrency: 1, maxQueue: 8, addrs: [], sentAt: 1 };
    expect(StatusExchange.safeParse({ v: 2, type: 'status', status, hints: Array(32).fill(hint) }).success).toBe(true);
    expect(StatusExchange.safeParse({ v: 2, type: 'status', status, hints: Array(33).fill(hint) }).success).toBe(false);
    expect(StatusExchange.safeParse({ v: 2, type: 'status', status, hints: [{ ...hint, addrs: Array(9).fill('/ip4/1.2.3.4/tcp/1') }] }).success).toBe(false);
  });
});

describe('WorkerPool', () => {
  it('admits concurrency + queue atomically, then rejects busy with a retry hint', () => {
    const p = new WorkerPool(1, 2);
    const t1 = p.admit();
    const t2 = p.admit();
    const t3 = p.admit();
    const t4 = p.admit();
    expect(t1).not.toBeInstanceOf(MeshError);
    expect(t2).not.toBeInstanceOf(MeshError);
    expect(t3).not.toBeInstanceOf(MeshError);
    expect(t4).toBeInstanceOf(MeshError);
    expect((t4 as MeshError).code).toBe('busy');
    expect((t4 as MeshError).retryAfterMs).toBeGreaterThan(0);
    expect([p.activeCount, p.queuedCount]).toEqual([1, 2]);
  });

  it('hands the slot to the next waiter FIFO, and cancelling a waiter frees its place', async () => {
    const p = new WorkerPool(1, 3);
    const running = p.admit() as any;
    const q1 = p.admit() as any;
    const q2 = p.admit() as any;
    const ctl = new AbortController();
    const w1 = q1.wait(5000, ctl.signal);
    const w2 = q2.wait(5000, new AbortController().signal);
    ctl.abort();
    await expect(w1).rejects.toMatchObject({ code: 'cancelled' });
    expect(p.queuedCount).toBe(1);
    running.release();
    await w2;
    expect([p.activeCount, p.queuedCount]).toEqual([1, 0]);
    q2.release();
    q2.release(); // idempotent
    expect(p.activeCount).toBe(0);
  });

  it('times out queued jobs and rejects everything while draining', async () => {
    const p = new WorkerPool(1, 1);
    p.admit();
    const q = p.admit() as any;
    await expect(q.wait(20, new AbortController().signal)).rejects.toMatchObject({ code: 'queue_timeout' });
    expect(p.queuedCount).toBe(0);
    p.draining = true;
    expect((p.admit() as MeshError).code).toBe('draining');
  });
});

describe('DedupCache', () => {
  it('rejects repeats within TTL, expires, and stays bounded', () => {
    let now = 0;
    const d = new DedupCache(1000, 3, () => now);
    expect(d.claim('a')).toBe(true);
    expect(d.claim('a')).toBe(false);
    now = 1500;
    expect(d.claim('a')).toBe(true);
    for (const k of ['b', 'c', 'd', 'e']) d.claim(k);
    expect(d.size).toBeLessThanOrEqual(3);
  });
});

describe('router', () => {
  const st = (active: number, queued: number) => ({ model: 'm', ready: true, active, queued, maxConcurrency: 1, maxQueue: 8 });
  it('prefers idle local, spills to the least-loaded remote, and honours exclusions', () => {
    const remotes = [
      { peerId: 'B', load: st(0, 0), rttMs: 5 },
      { peerId: 'C', load: st(1, 3), rttMs: 1 },
    ];
    const local = { ready: true, active: 0, queued: 0, maxConcurrency: 1, maxQueue: 8 };
    const r = (l = local, exclude = new Set<string>(), outstanding = new Map<string, number>()) =>
      rankCandidates({ selfPeerId: 'A', local: l, remotes, outstanding, exclude, remotePenalty: 0.5 }).map((c) => c.peerId);
    expect(r()).toEqual(['A', 'B', 'C']);
    expect(r({ ...local, active: 1 })).toEqual(['B', 'A', 'C']);
    expect(r(local, new Set(['A']))).toEqual(['B', 'C']);
    expect(r({ ...local, active: 1 }, new Set(), new Map([['B', 2]]))).toEqual(['A', 'B', 'C']);
    expect(r({ ...local, ready: false })).toEqual(['B', 'C']);
  });
});

describe('SSE parser', () => {
  it('handles arbitrary chunk boundaries, CRLF, comments and multi-line data', () => {
    const evs: string[] = [];
    const p = new SseParser((e) => evs.push(e.data));
    const text = ': ping\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n';
    for (const ch of text) p.push(ch);
    expect(evs).toEqual(['{"a":1}', 'line1\nline2', '[DONE]']);
  });
  it('bounds event size', () => {
    const p = new SseParser(() => {}, 100);
    expect(() => p.push('data: ' + 'x'.repeat(200))).toThrow(/maximum/);
  });
});

describe('persistence & identity', () => {
  it('writes atomically with mode 0600 and keeps the identity across calls', async () => {
    const d = await tmp();
    await atomicWriteJson(join(d, 'x.json'), { a: 1 });
    expect((await stat(join(d, 'x.json'))).mode & 0o777).toBe(0o600);
    const a = await ensureIdentity(d);
    const b = await ensureIdentity(d);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.identity.peerId).toBe(a.identity.peerId);
    expect((await stat(join(d, 'identity.key'))).mode & 0o777).toBe(0o600);
  });

  it('config defaults match the v0.1 limits', () => {
    const c = NodeConfigSchema.parse({ networkId: 'n' });
    expect(c.worker).toMatchObject({ maxConcurrency: 1, maxQueue: 8 });
    expect(c.runtime.contextTokens).toBe(2048);
    expect(c.discovery).toMatchObject({ probeIntervalMs: 5000, failuresBeforeUnavailable: 3 });
    expect(c.routing.maxAttempts).toBe(3);
    expect(c.http.host).toBe('127.0.0.1');
  });
});

describe('admission', () => {
  it('only authorises listed peers, rejects a mismatched network ID, and reloads', async () => {
    const d = await tmp();
    const self = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const other = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    await writeAuthorized(d, { networkId: 'n', peers: [] });
    const changes: string[][] = [];
    const a = new Admission(d, 'n', self, (added) => changes.push(added));
    await a.load();
    expect(a.isAuthorized(other)).toBe(false);
    await writeAuthorized(d, { networkId: 'n', peers: [{ peerId: other }, { peerId: self }] });
    await a.load();
    expect(a.isAuthorized(other)).toBe(true);
    expect(a.isAuthorized(self)).toBe(false); // self is never a "peer"
    expect(changes).toEqual([[other]]);
    await writeFile(join(d, 'authorized-peers.json'), JSON.stringify({ networkId: 'other', peers: [] }));
    await expect(a.load()).rejects.toThrow(/does not match/);
    expect(a.isAuthorized(other)).toBe(true); // previous list kept on error
  });

  it('parses peer IDs out of multiaddrs including relay circuits', () => {
    expect(peerIdOfAddr('/ip4/1.2.3.4/tcp/1/p2p/12D3KooWGwNG4YVDhEuz3HVs1L5kaCpyXhLe2pHAAzuPfxQExNBd')).toBe('12D3KooWGwNG4YVDhEuz3HVs1L5kaCpyXhLe2pHAAzuPfxQExNBd');
    expect(peerIdOfAddr('/ip4/1.2.3.4/tcp/1/p2p/12D3KooWGwNG4YVDhEuz3HVs1L5kaCpyXhLe2pHAAzuPfxQExNBd/p2p-circuit/p2p/12D3KooWJqEiTy264KZ6PQC1frnVS2sDw7Xy6gK3KYApkt6QEPKt')).toBe(
      '12D3KooWJqEiTy264KZ6PQC1frnVS2sDw7Xy6gK3KYApkt6QEPKt',
    );
    expect(peerIdOfAddr('/ip4/1.2.3.4/tcp/1')).toBeNull();
  });
});

describe('tokens', () => {
  it('separates client and admin roles', () => {
    const t = new TokenChecker({ clientTokens: ['c'.repeat(30)], adminToken: 'a'.repeat(30) });
    expect(t.check('c'.repeat(30))).toBe('client');
    expect(t.check('a'.repeat(30))).toBe('admin');
    expect(t.check('x'.repeat(30))).toBeNull();
    expect(t.check(undefined)).toBeNull();
  });
});


describe('summary scoring', async () => {
  const { rougeL } = await import('../../apps/node/src/scoring/rouge.js');
  const { cosine } = await import('../../apps/node/src/scoring/scorer.js');
  it('ROUGE-L is 1 for identical text, 0 for disjoint, and ignores case and punctuation', () => {
    expect(rougeL('The pack, shares WORK.', 'the pack shares work').f1).toBe(1);
    expect(rougeL('bread and flour', 'the pack shares work').f1).toBe(0);
    const r = rougeL('the wolves share work', 'the pack shares the work');
    expect(r.f1).toBeGreaterThan(0);
    expect(r.f1).toBeLessThan(1);
  });
  it('cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1);
  });
});

describe('pack memory store', async () => {
  const { PackStore, noteId, tombId, sha256 } = await import('../../apps/node/src/pack/store.js');
  const { scrub, isShareIntent } = await import('@werewolf-mesh/protocol');
  const log = { warn: () => {}, info: () => {}, debug: () => {} } as any;
  const body = (t: string, tok: string) => ({ v: 1 as const, kind: 'solution' as const, title: t, problem: '', solution: 'do the thing', tags: [], day: '2026-09-28', withdrawHash: sha256(tok) });

  it('accepts notes only when the id is the content hash; merges by id', async () => {
    const s = new PackStore(await tmp(), { publishDelayMinMs: 0, publishDelayMaxMs: 0, log });
    const b = body('A title', 'tok'.repeat(12));
    const id = noteId(b);
    expect(s.acceptNote({ ...b, id }, 'peer')).toMatchObject({ ok: true, isNew: true });
    expect(s.acceptNote({ ...b, id }, 'peer')).toMatchObject({ ok: true, isNew: false });
    expect(s.acceptNote({ ...b, title: 'Tampered', id }, 'peer')).toMatchObject({ ok: false });
  });

  it('withdrawal needs the secret; a withdrawal that arrives first blocks the note', async () => {
    const s = new PackStore(await tmp(), { publishDelayMinMs: 0, publishDelayMaxMs: 0, log });
    const tok = 'x'.repeat(40);
    const b = body('Another', tok);
    const id = noteId(b);
    s.acceptNote({ ...b, id }, 'peer');
    expect(s.acceptTomb({ v: 1, noteId: id, token: 'y'.repeat(40), day: '2026-09-28' }).ok).toBe(false);
    expect(s.acceptTomb({ v: 1, noteId: id, token: tok, day: '2026-09-28' }).ok).toBe(true);
    expect(s.notes.has(id)).toBe(false);
    expect(s.tombs.has(tombId(id))).toBe(true);
    const s2 = new PackStore(await tmp(), { publishDelayMinMs: 0, publishDelayMaxMs: 0, log });
    s2.acceptTomb({ v: 1, noteId: id, token: tok, day: '2026-09-28' });
    expect(s2.acceptNote({ ...b, id }, 'peer').ok).toBe(false);
  });

  it('holds local notes back from peers until the publish delay passes', async () => {
    let now = 1_000_000;
    const s = new PackStore(await tmp(), { publishDelayMinMs: 5000, publishDelayMaxMs: 5000, log, now: () => now });
    const r = s.createLocal({ kind: 'idea', title: 'Local idea', problem: '', solution: 'something', tags: [], withdrawHash: sha256('t'.repeat(40)) });
    expect(r.ok).toBe(true);
    expect(s.getItems([r.ok ? r.id : ''], []).notes).toHaveLength(0);
    now += 5001;
    expect(s.getItems([r.ok ? r.id : ''], []).notes).toHaveLength(1);
  });

  it('scrubs personal data and recognises share requests', () => {
    const r = scrub('mail a.b@c.io, call 020 7946 0958, ip 10.0.0.1, see https://x.org/p?token=abc, key ' + 'sk_' + 'live_' + 'fixture1'.repeat(4) + '');
    expect(r.text).not.toMatch(/a\.b@c\.io|7946|10\.0\.0\.1|token=abc|fixture1/);
    expect(r.text).toContain('https://x.org/p');
    for (const yes of ['share this with the pack', 'Please add it to the hive!', 'share it', 'Share the answer with the pack.', 'save this solution to the pack', 'share with the pack', 'Can you share this with the pack?'])
      expect(isShareIntent(yes), yes).toBe(true);
    for (const no of ['How do wolves share food in a pack?', 'what is the capital of France?', 'Wolves share food with the pack after a hunt', 'Can you tell me how a pack shares food?', 'I want to add a new member to the pack'])
      expect(isShareIntent(no), no).toBe(false);
  });
});

describe('effort → generation plan', async () => {
  const { planGeneration } = await import('../../apps/node/src/models/effort.js');
  const entry = (thinking: 'none' | 'toggle' | 'always', ctx = 8192, maxOut = 2048) =>
    ({ id: 'm', capabilities: { thinking }, serving: { contextTokens: ctx, maxOutputTokens: maxOut } }) as any;
  it('thinking models: none → off, low/medium/high → growing budgets; default is low', () => {
    expect(planGeneration(entry('toggle'), 'none', undefined)).toMatchObject({ thinking: { mode: 'off' } });
    expect(planGeneration(entry('toggle'), 'low', undefined).thinking).toEqual({ mode: 'on', budget: 512 });
    expect(planGeneration(entry('toggle'), 'medium', undefined).thinking).toEqual({ mode: 'on', budget: 1536 });
    expect(planGeneration(entry('toggle'), 'high', undefined).thinking).toEqual({ mode: 'on', budget: 4096 });
    expect(planGeneration(entry('toggle'), undefined, undefined).effort).toBe('low');
  });
  it('never exceeds the context; models without thinking only change the answer length', () => {
    const p = planGeneration(entry('toggle', 2048, 512), 'high', undefined);
    expect(p.maxTokens + (p.thinking?.budget ?? 0)).toBeLessThanOrEqual(2048 - 1024);
    expect(planGeneration(entry('none'), 'high', undefined)).toEqual({ maxTokens: 2048, effort: 'high' });
    expect(planGeneration(entry('none'), 'none', undefined).thinking).toBeUndefined();
    expect(() => planGeneration(entry('none', 8192, 512), 'low', 4000)).toThrow(/max_tokens/);
  });
});
