/**
 * Admission and protocol robustness: unauthorised peers, malformed / oversized /
 * wrong-version frames, identity spoofing, wrong model fingerprints, untrusted
 * peer-exchange hints, stale status, and oversized HTTP requests.
 *
 * A raw libp2p host inside the test process plays the misbehaving peer.
 */
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { identify } from '@libp2p/identify';
import type { Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { tcp } from '@libp2p/tcp';
import { lpStream } from '@libp2p/utils';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_FINGERPRINT } from '../../apps/node/src/runtime/fake.js';
import { INFER_PROTOCOL, STATUS_PROTOCOL } from '@werewolf-mesh/protocol';
import { admin, makeCluster, peerView, sleep, startNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: { subarray(): Uint8Array }) => JSON.parse(new TextDecoder().decode(b.subarray()));

async function host(privateKey?: Awaited<ReturnType<typeof generateKeyPair>>): Promise<Libp2p> {
  return createLibp2p({
    privateKey: privateKey ?? (await generateKeyPair('Ed25519')),
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

/** Read frames until the stream ends; returns decoded frames. */
async function readAll(s: Stream, timeoutMs = 3000): Promise<any[]> {
  const lp = lpStream(s);
  const frames: any[] = [];
  try {
    while (true) frames.push(dec(await lp.read({ signal: AbortSignal.timeout(timeoutMs) })));
  } catch {
    /* ended */
  }
  return frames;
}

describe('admission & protocol robustness', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode;
  let impostor: Libp2p; // holds node3's (authorised) key; node3 itself is never started
  let n1Addr: ReturnType<typeof multiaddr>;
  const validReq = (over: object = {}) => ({
    v: 1,
    type: 'infer',
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    attemptId: 'a1',
    originPeerId: n3.peerId,
    model: FAKE_FINGERPRINT,
    messages: [{ role: 'user', content: 'hi [[fake:tokens=3]]' }],
    settings: { maxTokens: 8 },
    deadlineMs: 10_000,
    ...over,
  });

  beforeAll(async () => {
    c = await makeCluster({ nodes: 3, patch: (i) => (i === 2 ? { http: { trustLoopback: false } } : {}) });
    [n1, n2, n3] = c.nodes as [TestNode, TestNode, TestNode];
    await startNode(n1);
    await startNode(n2);
    await waitAvailable(n2, [n1]);
    n1Addr = multiaddr(`/ip4/127.0.0.1/tcp/${n1.p2pPort}/p2p/${n1.peerId}`);
    const key = privateKeyFromProtobuf(new Uint8Array(await readFile(join(n3.dir, 'identity.key'))));
    impostor = await host(key as any);
    await impostor.start();
  });
  afterAll(async () => {
    await impostor?.stop();
    await c?.cleanup();
  });

  it('refuses connections from peers that are not in authorized-peers.json', async () => {
    const stranger = await host();
    await stranger.start();
    try {
      let opened = false;
      try {
        const s = await stranger.dialProtocol(n1Addr, INFER_PROTOCOL, { signal: AbortSignal.timeout(3000) });
        const lp = lpStream(s);
        await lp.write(enc(validReq({ originPeerId: stranger.peerId.toString() })));
        await lp.read({ signal: AbortSignal.timeout(2000) });
        opened = true;
      } catch {
        /* expected */
      }
      expect(opened).toBe(false);
      const m = await admin(n1, '/admin/metrics');
      expect(m.counters.p2p_denied_unauthorized).toBeGreaterThanOrEqual(1);
      const peers = (await admin(n1, '/admin/peers')).peers.map((p: any) => p.peerId);
      expect(peers).not.toContain(stranger.peerId.toString());
      expect(m.counters.p2p_infer_accepted ?? 0).toBe(0);
    } finally {
      await stranger.stop();
    }
  });

  it('serves a well-formed request from an authorised peer (control case)', async () => {
    const s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
    const lp = lpStream(s);
    await lp.write(enc(validReq()));
    const frames = await readAll(s);
    expect(frames[0].type).toBe('accepted');
    expect(frames.filter((f) => f.type === 'token').map((f) => f.text).join('')).toBe('t0 t1 t2 ');
    expect(frames.at(-1).type).toBe('completed');
  });

  it('reassembles frames split across many tiny writes (TCP chunks != messages)', async () => {
    const s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
    const body = enc(validReq());
    const len: number[] = [];
    let n = body.length;
    while (n >= 0x80) {
      len.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    len.push(n);
    const all = new Uint8Array([...len, ...body]);
    for (let i = 0; i < all.length; i += 7) {
      s.send(all.subarray(i, i + 7));
      await sleep(1);
    }
    const frames = await readAll(s);
    expect(frames[0].type).toBe('accepted');
    expect(frames.at(-1).type).toBe('completed');
  });

  it.each([
    ['malformed JSON', () => new TextEncoder().encode('{"v":1,"type":"infer",')],
    ['wrong protocol version', () => enc({ ...validReq(), v: 2 })],
    ['unknown field', () => enc({ ...validReq(), shell: 'rm -rf /' })],
    ['too many messages', () => enc(validReq({ messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) }))],
    ['max tokens above limit', () => enc(validReq({ settings: { maxTokens: 100000 } }))],
    ['tool role message', () => enc(validReq({ messages: [{ role: 'tool', content: 'x' }] }))],
  ])('drops the stream on %s without executing', async (_name, payload) => {
    const before = (await admin(n1, '/admin/metrics')).counters.worker_jobs_started ?? 0;
    const s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
    await lpStream(s).write(payload());
    const frames = await readAll(s, 2000);
    expect(frames.filter((f) => f.type === 'accepted' || f.type === 'token')).toEqual([]);
    const after = (await admin(n1, '/admin/metrics')).counters.worker_jobs_started ?? 0;
    expect(after).toBe(before);
    expect((await fetch(`${n1.url}/health/live`)).ok).toBe(true);
  });

  it('drops oversized frames before buffering them', async () => {
    const s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
    // varint for 10 MiB followed by a little data
    const size = 10 * 1024 * 1024;
    const v: number[] = [];
    let n = size;
    while (n >= 0x80) {
      v.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    v.push(n);
    s.send(new Uint8Array([...v, 1, 2, 3]));
    const frames = await readAll(s, 2000);
    expect(frames).toEqual([]);
    expect((await admin(n1, '/admin/metrics')).counters.p2p_malformed_infer).toBeGreaterThanOrEqual(1);
  });

  it('rejects a wrong model fingerprint and a spoofed origin (no forwarding)', async () => {
    let s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
    await lpStream(s).write(enc(validReq({ model: 'other-model:sha256:' + 'a'.repeat(64) })));
    let frames = await readAll(s);
    expect(frames[0]).toMatchObject({ type: 'rejected', code: 'model_mismatch' });

    s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
    await lpStream(s).write(enc(validReq({ originPeerId: n2.peerId })));
    frames = await readAll(s);
    expect(frames[0]).toMatchObject({ type: 'rejected', code: 'forbidden' });
  });

  it('rejects duplicate request IDs from the same origin (dedup cache)', async () => {
    const req = validReq();
    for (const expected of ['accepted', 'rejected']) {
      const s = await impostor.dialProtocol(n1Addr, INFER_PROTOCOL);
      await lpStream(s).write(enc(req));
      const frames = await readAll(s);
      expect(frames[0].type).toBe(expected);
      if (expected === 'rejected') expect(frames[0].code).toBe('duplicate');
    }
  });

  it('ignores status claims about another peer and hints for unauthorised peers; status expires', async () => {
    const stranger = (await generateKeyPair('Ed25519')).publicKey;
    const strangerId = peerIdFromString((await import('@libp2p/peer-id')).peerIdFromPublicKey(stranger).toString()).toString();
    const status = (peerId: string) => ({
      peerId,
      networkId: 'test-net',
      protocolVersion: 1,
      softwareVersion: 'x',
      state: 'ready',
      inferenceReady: true,
      models: [FAKE_FINGERPRINT],
      activeJobs: 0,
      queueLength: 0,
      maxConcurrency: 1,
      maxQueue: 8,
      addrs: [],
      sentAt: Date.now(),
    });
    // 1) Claim to be node2 → rejected, node2's entry unaffected.
    let s = await impostor.dialProtocol(n1Addr, STATUS_PROTOCOL);
    await lpStream(s).write(enc({ v: 1, type: 'status', status: status(n2.peerId), hints: [] }));
    expect(await readAll(s, 1000)).toEqual([]);
    // 2) Honest status + hints: one for an unauthorised peer, one bogus address for node2.
    s = await impostor.dialProtocol(n1Addr, STATUS_PROTOCOL);
    await lpStream(s).write(
      enc({
        v: 1,
        type: 'status',
        status: status(n3.peerId),
        hints: [
          { peerId: strangerId, addrs: ['/ip4/10.9.9.9/tcp/4001'] },
          { peerId: n2.peerId, addrs: ['/ip4/10.9.9.9/tcp/4001'] },
        ],
      }),
    );
    const reply = await readAll(s, 1000);
    expect(reply[0].type).toBe('status');
    expect(reply[0].status.peerId).toBe(n1.peerId);
    const m = await admin(n1, '/admin/metrics');
    expect(m.counters.p2p_hints_ignored_unauthorized).toBeGreaterThanOrEqual(1);
    expect((await admin(n1, '/admin/peers')).peers.map((p: any) => p.peerId)).not.toContain(strangerId);
    // node2 stays available: a bogus hint address never overrides authenticated state
    expect((await peerView(n1, n2)).available).toBe(true);
    // node3 (impostor host) looked ready, but it cannot answer n1's probes → expires/unavailable.
    await waitFor(async () => (await peerView(n1, n3))?.available === false, 8000, 'impostor status expired');
  });

  it('rejects oversized and unsupported HTTP requests', async () => {
    const big = 'x'.repeat(300 * 1024);
    let r = await fetch(`${n1.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${n1.clientToken}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: big }] }),
    });
    expect(r.status).toBe(413);
    r = await fetch(`${n1.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${n1.clientToken}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function' }] }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('unsupported');
  });

  it('enforces HTTP credentials: invalid token 401, client token cannot use admin, strict node needs a token', async () => {
    const bad = await fetch(`${n1.url}/admin/status`, { headers: { authorization: 'Bearer wrong-token-000000000000000000' } });
    expect(bad.status).toBe(401);
    const client = await fetch(`${n1.url}/admin/status`, { headers: { authorization: `Bearer ${n1.clientToken}` } });
    expect(client.status).toBe(403);
    // node2 runs with trustLoopback=false (container/remote style): no token → 401 even on loopback
    expect((await fetch(`${n2.url}/v1/models`)).status).toBe(401);
    expect((await fetch(`${n2.url}/v1/models`, { headers: { authorization: `Bearer ${n2.clientToken}` } })).status).toBe(200);
    expect((await fetch(`${n2.url}/admin/peers`, { headers: { authorization: `Bearer ${n2.adminToken}` } })).status).toBe(200);
    // health stays anonymous and minimal
    const ready = await (await fetch(`${n2.url}/health/ready`)).json();
    expect(Object.keys(ready).sort()).toEqual(['canServe', 'model', 'ready', 'serving']);
  });
});
