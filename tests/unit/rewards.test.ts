/**
 * WLF settlement under attack: real Ed25519 keys and signatures, and the
 * farming strategies from docs/rewards.md.
 */
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Receipt, RewardsBundle, StoredReceipt } from '@werewolf-mesh/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { sameNetwork, signBody, verifyBody } from '../../apps/node/src/rewards/ledger.js';
import { computeTrust, DEFAULT_PARAMS, settle, type SettleInput } from '../../apps/node/src/rewards/settle.js';

const EPOCH = '2026-09-29';
const MODEL = 'qwen3-4b-q4_k_m:sha256:' + 'a'.repeat(64);
const FAKE_MODEL = 'fake-a:sha256:' + '0'.repeat(64);

interface Who {
  key: PrivateKey;
  id: string;
}
async function who(): Promise<Who> {
  const key = await generateKeyPair('Ed25519');
  return { key, id: peerIdFromPrivateKey(key).toString() };
}

let n = 0;
async function receipt(req: Who, worker: Who, over: Partial<Receipt> = {}, stored: Partial<StoredReceipt> = {}): Promise<StoredReceipt> {
  const r: Receipt = {
    v: 1,
    id: `req-${++n}/a1`,
    epoch: EPOCH,
    requester: req.id,
    worker: worker.id,
    model: MODEL,
    promptTokens: 400,
    completionTokens: 300,
    completedAt: Date.parse(EPOCH) + n,
    sameNetwork: false,
    ...over,
  };
  return { receipt: r, sig: await signBody(req.key, 'receipt', r), workerSameNetwork: false, workerCompletionTokens: r.completionTokens, ...stored };
}

async function bundle(node: Who, receipts: StoredReceipt[], approved: string[] = [], at = 1): Promise<RewardsBundle> {
  const body = { v: 1 as const, peer: node.id, epochs: [EPOCH], receipts, vouches: { v: 1 as const, peer: node.id, approved, at } };
  return { ...body, sig: await signBody(node.key, 'bundle', body) };
}

const base = (bundles: RewardsBundle[], seeds: string[], params = {}): SettleInput => ({
  epoch: EPOCH,
  bundles,
  seeds,
  params,
  verifyBundle: (b) => verifyBody(b.peer, 'bundle', { v: b.v, peer: b.peer, epochs: b.epochs, receipts: b.receipts, vouches: b.vouches }, b.sig),
  verifyReceipt: (s) => verifyBody(s.receipt.requester, 'receipt', s.receipt, s.sig),
  modelWeight: (fp) => (fp === FAKE_MODEL ? null : 1),
});

/** n receipts from `req` to `worker`. */
const many = async (req: Who, worker: Who, count: number, over: Partial<Receipt> = {}) => Promise.all(Array.from({ length: count }, () => receipt(req, worker, over)));

describe('WLF settlement', () => {
  // The seed (the settler) approved alice, bob and carol: real people.
  let seed: Who, alice: Who, bob: Who, carol: Who, w1: Who, w2: Who;
  let seedBundle: RewardsBundle;
  beforeAll(async () => {
    [seed, alice, bob, carol, w1, w2] = await Promise.all([who(), who(), who(), who(), who(), who()]);
    seedBundle = await bundle(seed, [], [alice.id, bob.id, carol.id, w1.id, w2.id]);
  });

  it('pays workers that served several trusted people, pro-rata, from a pool of 100 WLF per qualified node', async () => {
    // Each answer: 300 + 0.25 × 400 = 400 work units, × 0.5 trust = 200 credit (1,000 needed to qualify).
    const b1 = await bundle(w1, [...(await many(alice, w1, 4)), ...(await many(bob, w1, 4))]);
    const b2 = await bundle(w2, [...(await many(bob, w2, 3)), ...(await many(carol, w2, 3))]);
    const s = await settle(base([seedBundle, b1, b2], [seed.id]));
    expect(s.qualifiedNodes).toBe(2);
    expect(s.halvings).toBe(0);
    expect(s.pool).toBe(200);
    const w1a = s.allocations.find((x) => x.peer === w1.id)!;
    const w2a = s.allocations.find((x) => x.peer === w2.id)!;
    expect(w1a.wlf).toBeCloseTo((200 * 8) / 14, 3); // 8 of the 14 equal answers
    expect(w2a.wlf).toBeCloseTo((200 * 6) / 14, 3);
    expect(w1a.wlf + w2a.wlf).toBeLessThanOrEqual(200);
  });

  it('never pays for self-use, same-network work, test runtimes, short answers or duplicates', async () => {
    const dup = await receipt(alice, w1);
    const b1 = await bundle(w1, [
      ...(await many(alice, w1, 3)),
      ...(await many(bob, w1, 3)),
      await receipt(w1, w1), // self-use
      await receipt(alice, w1, { sameNetwork: true }), // requester says: same network
      await receipt(bob, w1, {}, { workerSameNetwork: true }), // worker says: same network
      await receipt(alice, w1, { model: FAKE_MODEL }),
      await receipt(bob, w1, { completionTokens: 3 }),
      dup,
      dup,
    ]);
    const s = await settle(base([seedBundle, b1], [seed.id], { qualifyMinRequesters: 2 }));
    expect(s.excluded).toMatchObject({
      'self-use': 1,
      'same network or machine': 2,
      'test runtime / unknown model': 1,
      'answer too short': 1,
      'duplicate receipt': 1,
    });
    expect(s.allocations.find((x) => x.peer === w1.id)!.receipts).toBe(7); // 6 + the first copy of dup
  });

  it('a ring of fake nodes vouching for each other earns nothing and does not count as nodes', async () => {
    const fakes = await Promise.all(Array.from({ length: 6 }, () => who()));
    const ids = fakes.map((f) => f.id);
    const bundles = [seedBundle];
    // Each fake "serves" the others plenty, all signed and consistent.
    for (const f of fakes) {
      const rs = [];
      for (const g of fakes) if (g !== f) rs.push(...(await many(g, f, 5)));
      bundles.push(await bundle(f, rs, ids));
    }
    const s = await settle(base(bundles, [seed.id]));
    expect(s.qualifiedNodes).toBe(0);
    expect(s.pool).toBe(0);
    expect(s.excluded['requester not trusted']).toBe(6 * 5 * 5);
  });

  it('one trusted person vouching for a thousand fake accounts gives each almost no trust', async () => {
    const fakeIds = await Promise.all(Array.from({ length: 1000 }, async () => (await who()).id));
    const vouches = new Map([
      [seed.id, [alice.id]],
      [alice.id, fakeIds],
    ]);
    const t = computeTrust([seed.id], vouches, DEFAULT_PARAMS);
    expect(t.get(alice.id)).toBe(0.5);
    expect(t.get(fakeIds[0]!)!).toBeLessThan(DEFAULT_PARAMS.minTrust);
    // A seed approving many peers (a founding/bootstrap node) is not diluted.
    const t3 = computeTrust([seed.id], new Map([[seed.id, fakeIds.slice(0, 50)]]), DEFAULT_PARAMS);
    expect(t3.get(fakeIds[0]!)).toBe(0.5);
    // An honest operator vouching for a few friends passes real trust.
    const t2 = computeTrust([seed.id], new Map([[seed.id, [alice.id]], [alice.id, [bob.id, carol.id]]]), DEFAULT_PARAMS);
    expect(t2.get(bob.id)).toBe(0.125); // alice splits half of her 0.5 between two friends
  });

  it('a trusted person colluding with one farm node cannot make it qualify alone, and is capped', async () => {
    const farm = await who();
    const seedB = await bundle(seed, [], [alice.id, farm.id]);
    // alice "requests" 5,000 fake answers from farm (colluding signatures are valid!).
    const bf = await bundle(farm, await many(alice, farm, 5000));
    const s = await settle(base([seedB, bf], [seed.id]));
    expect(s.qualifiedNodes).toBe(0); // one requester is not enough
    expect(s.allocations).toEqual([]);
    expect(s.excluded['work above a requester’s daily cap (scaled down)']).toBe(5000);
  });

  it('two colluders feeding one farm node: qualifies, but capped at 2 × daily cap × trust', async () => {
    const farm = await who();
    const seedB = await bundle(seed, [], [alice.id, bob.id, farm.id]);
    const honest = await bundle(w1, [...(await many(carol, w1, 10)), ...(await many(bob, w1, 10))]);
    const bf = await bundle(farm, [...(await many(alice, farm, 3000)), ...(await many(bob, farm, 3000))]);
    const s = await settle(base([seedB, honest, bf], [seed.id]));
    const f = s.allocations.find((x) => x.peer === farm.id)!;
    // Credit is bounded by the requesters' caps and trust, whatever they sign.
    expect(f.credit).toBeLessThanOrEqual(2 * DEFAULT_PARAMS.requesterDailyCap * 0.5 + 1e-6);
  });

  it('fake users vouched by one trusted person cannot inflate the node-count pool', async () => {
    // mallory is vouched by the seed; she vouches 8 fake "users", who feed 8 farm nodes (2 users each).
    const mallory = await who();
    const fakes = await Promise.all(Array.from({ length: 8 }, () => who()));
    const farms = await Promise.all(Array.from({ length: 8 }, () => who()));
    const seedB = await bundle(seed, [], [mallory.id]);
    const malB = await bundle(mallory, [], fakes.map((f) => f.id));
    const bundles = [seedB, malB];
    for (let i = 0; i < farms.length; i++) {
      bundles.push(await bundle(farms[i]!, [...(await many(fakes[i]!, farms[i]!, 400)), ...(await many(fakes[(i + 1) % 8]!, farms[i]!, 400))]));
    }
    const s = await settle(base(bundles, [seed.id], { qualifyMinCredit: 1 }));
    // Even if every farm node qualifies, their pool weight comes from the fakes' trust:
    // 8 fakes × (0.5 × 0.5 / 8) = 0.25 in total → at most 2 × 0.25 × 100 = 50 WLF, not 8 × 100.
    expect(s.pool).toBeLessThanOrEqual(50 + 1e-6);
  });

  it('trust is conserved down a chain of vouches', async () => {
    const chain = await Promise.all(Array.from({ length: 6 }, async () => (await who()).id));
    const v = new Map<string, string[]>([[seed.id, [chain[0]!]]]);
    // Each level vouches for 8 more new accounts: the total below chain[0] never exceeds chain[0]'s own trust.
    const all: string[] = [];
    let level = [chain[0]!];
    for (let d = 0; d < 3; d++) {
      const next: string[] = [];
      for (const x of level) {
        const kids = await Promise.all(Array.from({ length: 8 }, async () => (await who()).id));
        v.set(x, kids);
        next.push(...kids);
      }
      all.push(...next);
      level = next;
    }
    const t = computeTrust([seed.id], v, DEFAULT_PARAMS);
    const below = all.reduce((n, x) => n + (t.get(x) ?? 0), 0);
    expect(below).toBeLessThanOrEqual(t.get(chain[0]!)! + 1e-9);
  });

  it('forged receipts and bundles are rejected', async () => {
    const good = await receipt(alice, w1);
    const forged: StoredReceipt = { ...good, receipt: { ...good.receipt, completionTokens: 999_999 } }; // tampered after signing
    const byOther = await receipt(bob, w2); // w2's receipt submitted by w1
    const b1 = await bundle(w1, [forged, byOther, ...(await many(alice, w1, 2)), ...(await many(bob, w1, 2))]);
    const tamperedBundle = { ...(await bundle(w2, await many(carol, w2, 3))), peer: w1.id };
    const s = await settle(base([seedBundle, b1, tamperedBundle], [seed.id]));
    expect(s.excluded['receipt with a bad signature']).toBe(1);
    expect(s.excluded['receipt submitted by a node that did not do the work']).toBe(1);
    expect(s.excluded['bundle with a bad signature']).toBe(1);
  });

  it('empty nodes do not shrink the pool; halving starts at 16 qualified nodes', async () => {
    const empties = await Promise.all(Array.from({ length: 20 }, async () => bundle(await who(), [])));
    const b1 = await bundle(w1, [...(await many(alice, w1, 3)), ...(await many(bob, w1, 3))]);
    const s = await settle(base([seedBundle, b1, ...empties], [seed.id]));
    expect(s.qualifiedNodes).toBe(1);
    expect(s.pool).toBe(100);

    // 16 real workers, each used by two different trusted people: one halving → 50 WLF per node.
    const workers = await Promise.all(Array.from({ length: 16 }, () => who()));
    const users = await Promise.all(Array.from({ length: 32 }, () => who()));
    const seed16 = await bundle(seed, [], users.map((u) => u.id));
    const bs = await Promise.all(workers.map(async (w, i) => bundle(w, [...(await many(users[2 * i]!, w, 3)), ...(await many(users[2 * i + 1]!, w, 3))])));
    const s16 = await settle(base([seed16, ...bs], [seed.id]));
    expect(s16.qualifiedNodes).toBe(16);
    expect(s16.halvings).toBe(1);
    expect(s16.pool).toBe(800);
    // The same 16 nodes used by only two people: the pool follows real use, not the node count.
    const two = await Promise.all(workers.map(async (w) => bundle(w, [...(await many(alice, w, 3)), ...(await many(bob, w, 3))])));
    const s2 = await settle(base([seedBundle, ...two], [seed.id], { requesterDailyCap: 1e9 }));
    expect(s2.pool).toBeLessThanOrEqual(100);
  });

  it('is deterministic: the same inputs in any order give the same result', async () => {
    const b1 = await bundle(w1, [...(await many(alice, w1, 2)), ...(await many(bob, w1, 2))]);
    const b2 = await bundle(w2, [...(await many(bob, w2, 2)), ...(await many(carol, w2, 2))]);
    const a = await settle(base([seedBundle, b1, b2], [seed.id]));
    const b = await settle(base([b2, b1, seedBundle], [seed.id]));
    expect(b).toEqual(a);
  });
});

describe('same-network detection', () => {
  const own = [multiaddr('/ip4/192.168.1.10/tcp/4001'), multiaddr('/ip4/203.0.113.7/tcp/4001'), multiaddr('/ip6/2a02:8070:1234:5600::1/tcp/4001')];
  it.each([
    ['/ip4/192.168.1.20/tcp/4001', true], // same LAN
    ['/ip4/127.0.0.1/tcp/4001', true], // same machine
    ['/ip4/100.64.3.4/tcp/4001', true], // CGNAT: cannot tell households apart
    ['/ip6/2a02:8070:1234:56ff::9/tcp/4001', true], // same /56
    ['/ip4/198.51.99.1/tcp/4001', false], // someone else
    ['/ip6/2a02:8070:1234:5700::9/tcp/4001', false],
    ['/ip4/198.51.99.1/tcp/4001/p2p/12D3KooWKsxQAVaFXYfd8ekvNZYTffvnPyy6vFjV2gmqNndpL3dn/p2p-circuit', false], // relayed
  ])('%s → same network: %s', (addr, expected) => {
    expect(sameNetwork([multiaddr(addr)], own)).toBe(expected);
  });

  it('behind a reverse proxy, WebSocket peers from loopback are not "this machine"', () => {
    const viaNginx = [multiaddr('/ip4/127.0.0.1/tcp/51234/ws')];
    expect(sameNetwork(viaNginx, own)).toBe(true);
    expect(sameNetwork(viaNginx, own, { wsBehindProxy: true })).toBe(false);
    // Plain TCP from loopback is still the same machine.
    expect(sameNetwork([multiaddr('/ip4/127.0.0.1/tcp/4001')], own, { wsBehindProxy: true })).toBe(true);
  });
});
