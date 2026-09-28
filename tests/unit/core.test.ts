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
    await fa.write({ v: 1, type: 'cancelled' });
    expect(await fb.read(WorkerFrame)).toEqual({ v: 1, type: 'cancelled' });

    await lpStream(a).write(new TextEncoder().encode(JSON.stringify({ v: 2, type: 'cancelled' })));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/unsupported protocol version/);

    await lpStream(a).write(new TextEncoder().encode('{nope'));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/malformed/);

    await lpStream(a).write(new Uint8Array([0xff, 0xfe]));
    await expect(fb.read(WorkerFrame)).rejects.toThrow(/malformed/); // invalid UTF-8

    await expect(fa.write({ v: 1, type: 'token', seq: 0, text: 'x'.repeat(2000) })).rejects.toThrow(/exceeds/);
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
    v: 1,
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
    expect(InferRequest.safeParse({ ...base, settings: { maxTokens: 257 } }).success).toBe(false);
    expect(InferRequest.safeParse({ ...base, messages: [] }).success).toBe(false);
    expect(InferRequest.safeParse({ ...base, requestId: 'has space' }).success).toBe(false);
  });
  it('bounds peer-exchange hints', () => {
    const hint = { peerId: base.originPeerId, addrs: ['/ip4/1.2.3.4/tcp/1'] };
    const status = { peerId: base.originPeerId, networkId: 'n', protocolVersion: 1, softwareVersion: 'x', state: 'ready', inferenceReady: true, models: [], activeJobs: 0, queueLength: 0, maxConcurrency: 1, maxQueue: 8, addrs: [], sentAt: 1 };
    expect(StatusExchange.safeParse({ v: 1, type: 'status', status, hints: Array(32).fill(hint) }).success).toBe(true);
    expect(StatusExchange.safeParse({ v: 1, type: 'status', status, hints: Array(33).fill(hint) }).success).toBe(false);
    expect(StatusExchange.safeParse({ v: 1, type: 'status', status, hints: [{ ...hint, addrs: Array(9).fill('/ip4/1.2.3.4/tcp/1') }] }).success).toBe(false);
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
  const st = (active: number, queue: number) => ({ peerId: 'x', networkId: 'n', protocolVersion: 1 as const, softwareVersion: '', state: 'ready' as const, inferenceReady: true, models: [], activeJobs: active, queueLength: queue, maxConcurrency: 1, maxQueue: 8, addrs: [], sentAt: 0 });
  it('prefers idle local, spills to the least-loaded remote, and honours exclusions', () => {
    const remotes = [
      { peerId: 'B', status: st(0, 0), rttMs: 5 },
      { peerId: 'C', status: st(1, 3), rttMs: 1 },
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

