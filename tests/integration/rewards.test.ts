/**
 * WLF rewards end to end, with real node processes (fake runtime in rewards
 * test mode, so loopback peers count as different networks):
 * receipts only for serving others, forged receipts refused, settlement
 * signed by the settler, and imported only from the configured settler.
 */
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { RewardsBundle } from '@werewolf-mesh/protocol';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signBody, verifyBody } from '../../apps/node/src/rewards/ledger.js';
import { settle } from '../../apps/node/src/rewards/settle.js';
import { admin, chat, makeCluster, startNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

describe('WLF rewards across real nodes', () => {
  let c: TestCluster;
  let n1: TestNode, n2: TestNode, n3: TestNode;
  beforeAll(async () => {
    c = await makeCluster({
      nodes: 3,
      patch: (i) => ({ runtime: { fakeTokenDelayMs: 1 }, rewards: { unsafeTestMode: true }, model: { host: i === 0 ? ['fake-test-model'] : [] } }),
    });
    [n1, n2, n3] = c.nodes as [TestNode, TestNode, TestNode];
    // n3 is the settler: n1 accepts settlements signed by it.
    const cfgPath = join(n1.dir, 'node.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    cfg.rewards = { ...cfg.rewards, settler: n3.peerId };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    for (const n of c.nodes) await startNode(n);
    await waitAvailable(n2, [n1]);
    await waitAvailable(n3, [n1]);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  const today = () => new Date().toISOString().slice(0, 10);

  it('earns nothing for its own use', async () => {
    const r = await chat(n1, 'my own question [[fake:tokens=40]]', { token: n1.adminToken, extra: { mesh: { target: 'local' } } });
    expect(r.done).toBe(true);
    await new Promise((res) => setTimeout(res, 500));
    const s = await admin(n1, '/admin/rewards');
    expect(s.epochs).toEqual([]);
  });

  it('earns a verified receipt for each answer served to another node', async () => {
    for (const n of [n2, n2, n3]) {
      const r = await chat(n, 'question from elsewhere [[fake:tokens=40]]', { extra: { mesh: { target: n1.peerId } } });
      expect(r.done).toBe(true);
    }
    await waitFor(async () => (await admin(n1, '/admin/rewards')).epochs[0]?.received === 3, 10_000, 'three receipts');
    const s = await admin(n1, '/admin/rewards');
    expect(s.epochs[0]).toMatchObject({ epoch: today(), received: 3, requesters: 2, sameNetwork: 0 });
    expect(s.epochs[0].creditableTokens).toBe(120);
    expect((await admin(n2, '/admin/rewards')).sent.today).toBe(2);
  });

  it('refuses a correctly signed receipt for a job it never ran', async () => {
    // Speak as n2 (its own key, so n1 admits the connection) and claim an answer n1 never gave.
    const { createLibp2p } = await import('libp2p');
    const { tcp } = await import('@libp2p/tcp');
    const { noise } = await import('@chainsafe/libp2p-noise');
    const { yamux } = await import('@chainsafe/libp2p-yamux');
    const { multiaddr } = await import('@multiformats/multiaddr');
    const { RECEIPT_PROTOCOL } = await import('@werewolf-mesh/protocol');
    const { FrameStream } = await import('../../apps/node/src/p2p/framing.js');
    const identity = await import('../../apps/node/src/identity.js');
    const key = (await identity.loadIdentity(n2.dir)).privateKey;
    const impostor = await createLibp2p({ privateKey: key, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()] });
    try {
      const receipt = {
        v: 1 as const,
        id: 'never-happened/a1',
        epoch: today(),
        requester: n2.peerId,
        worker: n1.peerId,
        model: 'fake-test-model:sha256:' + '0'.repeat(64),
        promptTokens: 10,
        completionTokens: 5000,
        completedAt: Date.now(),
        sameNetwork: false,
      };
      const stream = await impostor.dialProtocol(multiaddr(`/ip4/127.0.0.1/tcp/${n1.p2pPort}/p2p/${n1.peerId}`), RECEIPT_PROTOCOL);
      await new FrameStream(stream, 16 * 1024, 1).write({ v: 1, type: 'receipt', signed: { receipt, sig: await signBody(key, 'receipt', receipt) } });
      await waitFor(async () => ((await admin(n1, '/admin/rewards')).rejected['no such job'] ?? 0) >= 1, 5_000, 'refused');
      expect((await admin(n1, '/admin/rewards')).epochs[0].received).toBe(3);
    } finally {
      await impostor.stop();
    }
  });

  it('settles: the settler signs the day, and the worker imports only the settler’s signature', async () => {
    const b1 = RewardsBundle.parse(await admin(n1, '/admin/rewards/bundle'));
    const b3 = RewardsBundle.parse(await admin(n3, '/admin/rewards/bundle'));
    const body = await settle({
      epoch: today(),
      bundles: [b1, b3],
      seeds: [n3.peerId],
      params: { qualifyMinCredit: 1 },
      verifyBundle: (b) => verifyBody(b.peer, 'bundle', { v: b.v, peer: b.peer, epochs: b.epochs, receipts: b.receipts, vouches: b.vouches }, b.sig),
      verifyReceipt: (s) => verifyBody(s.receipt.requester, 'receipt', s.receipt, s.sig),
      modelWeight: () => 1, // test runtime counted on purpose here
    });
    // n3 (seed) vouches n1 and n2 → both requesters trusted; n1 served two of them.
    expect(body.qualifiedNodes).toBe(1);
    expect(body.allocations[0]).toMatchObject({ peer: n1.peerId, receipts: 3, requesters: 2 });
    expect(body.allocations[0]!.wlf).toBeGreaterThan(0);

    // Signed by someone else: refused.
    const mallory = await generateKeyPair('Ed25519');
    const fake = { body, settler: peerIdFromPrivateKey(mallory).toString(), sig: await signBody(mallory, 'settlement', body) };
    const bad = await fetch(`${n1.url}/admin/rewards/settlement`, { method: 'POST', headers: { authorization: `Bearer ${n1.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(fake) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/accepts settlements from/);

    // Tampered after the settler signed: refused.
    const identity = await import('../../apps/node/src/identity.js');
    const settlerKey = (await identity.loadIdentity(n3.dir)).privateKey;
    const good = { body, settler: n3.peerId, sig: await signBody(settlerKey, 'settlement', body) };
    const tampered = { ...good, body: { ...body, allocations: body.allocations.map((a) => ({ ...a, wlf: a.wlf * 10 })) } };
    const t = await fetch(`${n1.url}/admin/rewards/settlement`, { method: 'POST', headers: { authorization: `Bearer ${n1.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(tampered) });
    expect(t.status).toBe(400);

    const ok = await fetch(`${n1.url}/admin/rewards/settlement`, { method: 'POST', headers: { authorization: `Bearer ${n1.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(good) });
    expect(ok.status).toBe(200);
    const bal = (await admin(n1, '/admin/rewards')).balance;
    expect(bal.total).toBe(body.allocations[0]!.wlf);
  });

  it('only the operator sees or changes rewards', async () => {
    const r = await fetch(`${n1.url}/admin/rewards`, { headers: { authorization: `Bearer ${n1.clientToken}` } });
    expect(r.status).toBe(403);
  });
});
