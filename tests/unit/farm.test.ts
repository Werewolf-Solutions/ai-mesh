import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { streamPair } from '@libp2p/utils';
import { FarmPackage, FarmPath, FarmSpec, FARM_LIMITS } from '@werewolf-mesh/protocol';
import { ensureIdentity } from '../../apps/node/src/identity.js';
import { FarmCrypto, encryptFor, verifyFarmKey } from '../../apps/node/src/farm/crypto.js';
import { packageSource, sha256, sourceDigest, validateSource } from '../../apps/node/src/farm/source.js';
import { FarmService, DEFAULT_FARM_IMAGE, farmContext } from '../../apps/node/src/farm/service.js';
import { readTransfer, writeTransfer } from '../../apps/node/src/farm/transport.js';
import { FrameStream } from '../../apps/node/src/p2p/framing.js';
import { farmSandboxArgs } from '../../apps/node/src/farm/sandbox.js';

async function identities() {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-farm-unit-'));
  const a = (await ensureIdentity(join(dir, 'a'))).identity;
  const b = (await ensureIdentity(join(dir, 'b'))).identity;
  return { dir, a, b };
}
const source = { files: [{ path: 'hello.txt', data: Buffer.from('private source').toString('base64'), sha256: sha256('private source') }] };
function pkg(a: string, b: string) {
  return FarmPackage.parse({ spec: { v: 1, kind: 'routine', jobId: 'job1', attemptId: 'attempt1', fence: 1, requesterPeerId: a, targetPeerId: b,
    projectId: 'project', workspaceId: 'personal', title: 'Verification', source: { baseCommit: 'a'.repeat(40), digest: sourceDigest(source) },
    image: DEFAULT_FARM_IMAGE, architecture: process.arch, steps: [{ name: 'check', command: 'node --version' }], network: 'none', retry: 'isolated' }, source });
}

describe('farm contract and source safety', () => {
  it('refuses paths, credential exports, content tampering and conflicting files', async () => {
    for (const p of ['/etc/passwd', '../foo', 'foo/../bar', 'C:/foo', 'a\\b', 'a//b', 'foo\0bar']) expect(FarmPath.safeParse(p).success).toBe(false);
    expect(() => validateSource({ files: [{ ...source.files[0], path: '.env.production' }] })).toThrow(/excluded/);
    expect(() => validateSource({ files: [{ ...source.files[0], data: Buffer.from('tampered').toString('base64') }] })).toThrow(/digest/);
    expect(() => validateSource({ files: [source.files[0], source.files[0]] })).toThrow(/duplicate/);
    expect(() => validateSource({ files: [source.files[0], { ...source.files[0], path: 'hello.txt/child' }] })).toThrow(/conflict/);
    expect(() => validateSource(source, '0'.repeat(64))).toThrow(/snapshot/);
    const dir = await mkdtemp(join(tmpdir(), 'mesh-source-'));
    try {
      await writeFile(join(dir, '.env'), 'secret'); await writeFile(join(dir, 'readme.md'), 'okay');
      expect((await packageSource(dir)).files.map((f) => f.path)).toEqual(['readme.md']);
      await symlink('/etc/passwd', join(dir, 'escape')); await expect(packageSource(dir)).rejects.toThrow(/symlink/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects unsupported versions, remote networking, arbitrary image tags and resource excess', async () => {
    const { dir, a, b } = await identities();
    try {
      const spec = pkg(a.peerId, b.peerId).spec;
      for (const changed of [{ v: 2 }, { kind: 'agent' }, { network: 'egress' }, { image: 'node:latest' }, { surprise: true }, { limits: { memoryMb: 999999 } }]) expect(FarmSpec.safeParse({ ...spec, ...changed }).success).toBe(false);
      const args = farmSandboxArgs('farm-test', pkg(a.peerId, b.peerId), b.peerId);
      expect(args).toContain('--read-only'); expect(args).toContain('none'); expect(args).toContain('--pull'); expect(args).toContain('never');
      expect(args.join(' ')).not.toMatch(/--privileged|--volume|--mount|docker.sock/);
      expect(args).toContain('/work:rw,nosuid,nodev,size=64m,mode=1777');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('farm encryption and framing', () => {
  it('binds encryption keys to peer identity and refuses wrong recipient/context/tampering', async () => {
    const { dir, a, b } = await identities();
    try {
      const ca = await FarmCrypto.load(join(dir, 'a'), a), cb = await FarmCrypto.load(join(dir, 'b'), b);
      await verifyFarmKey(cb.announcement, b.peerId);
      await expect(verifyFarmKey({ ...cb.announcement, peerId: a.peerId }, a.peerId)).rejects.toThrow(/signature/);
      const e = encryptFor(cb.announcement, Buffer.from('secret'), 'job/source');
      expect(cb.decrypt(e, 'job/source').toString()).toBe('secret');
      expect(() => ca.decrypt(e, 'job/source')).toThrow(/binding/);
      expect(() => cb.decrypt(e, 'other')).toThrow(/binding/);
      const bytes = Buffer.from(e.data, 'base64'); bytes[0] = bytes[0]! ^ 1;
      expect(() => cb.decrypt({ ...e, data: bytes.toString('base64') }, 'job/source')).toThrow();
      const saved = cb.sealRecord({ private: 'source' }, 'record/one');
      expect(saved.toString()).not.toContain('source');
      expect(() => cb.openRecord(saved, 'record/two')).toThrow();
      const restarted = await FarmCrypto.load(join(dir, 'b'), b);
      expect(restarted.openRecord(saved, 'record/one')).toEqual({ private: 'source' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('transfers bounded chunks and rejects reordered/oversized payloads', async () => {
    const [a, b] = await streamPair();
    const fa = new FrameStream(a, 128 * 1024, 1), fb = new FrameStream(b, 128 * 1024, 1);
    const value = { content: 'x'.repeat(200000) };
    const read = readTransfer(fb, AbortSignal.timeout(2000));
    await writeTransfer(fa, value, AbortSignal.timeout(2000)); expect(await read).toEqual(value);
    await fa.write({ v: 1, type: 'farm-transfer', bytes: 3 });
    await fa.write({ v: 1, type: 'farm-chunk', seq: 1, data: 'YWJj' });
    await expect(readTransfer(fb, AbortSignal.timeout(2000))).rejects.toThrow(/chunk/);
    await expect(writeTransfer(fa, { content: 'x'.repeat(FARM_LIMITS.transferBytes) }, AbortSignal.timeout(2000))).rejects.toThrow(/large/);
    a.abort(new Error('done')); b.abort(new Error('done'));
  });
});

describe('farm permission and durable lifecycle', () => {
  it('separates membership from execution, persists deduplication and prevents fenced replay', async () => {
    const { dir, a, b } = await identities();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const worker = new FarmService({ dataDir: join(dir, 'b'), identity: b, authorized: (p) => p === a.peerId, cleanup: async () => {}, imageAvailable: async () => true, executor: async (p) => {
      runs++; await gate;
      return { jobId: p.spec.jobId, attemptId: p.spec.attemptId, fence: p.spec.fence, sourceDigest: p.spec.source.digest, image: p.spec.image,
        steps: [{ name: 'check', exitCode: 0, stdout: 'okay', stderr: '' }], truncated: false, timedOut: false, durationMs: 1 };
    } });
    await worker.init();
    const ca = await FarmCrypto.load(join(dir, 'a'), a), cb = await FarmCrypto.load(join(dir, 'b'), b);
    const p = pkg(a.peerId, b.peerId);
    const request = { op: 'submit' as const, envelope: encryptFor(cb.announcement, Buffer.from(JSON.stringify(p)), farmContext(p.spec, 'source')), resultKey: ca.announcement };
    try {
      expect((await worker.handle(a.peerId, request)).type).toBe('error');
      await worker.setPolicy({ enabled: true, requesters: [a.peerId], images: [DEFAULT_FARM_IMAGE] });
      const accepted = await worker.handle(a.peerId, request); expect(accepted.type).toBe('status');
      expect((await worker.handle(a.peerId, request)).type).toBe('status');
      release();
      for (let i = 0; i < 30 && !worker.localView().jobs.every((j) => j.cleanup === 'done'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(runs).toBe(1); expect(worker.localView().jobs[0]?.state).toBe('completed');
      for (const file of await readdir(join(dir, 'b/farm/worker'))) expect((await readFile(join(dir, 'b/farm/worker', file))).toString()).not.toContain('private source');
      const lower = { ...p, spec: { ...p.spec, attemptId: 'different' } };
      const reply = await worker.handle(a.peerId, { ...request, envelope: encryptFor(cb.announcement, Buffer.from(JSON.stringify(lower)), farmContext(lower.spec, 'source')) });
      expect(reply).toMatchObject({ type: 'error', code: 'conflict' });
      await worker.stop();
      const restarted = new FarmService({ dataDir: join(dir, 'b'), identity: b, authorized: () => true, cleanup: async () => {}, executor: async () => { throw new Error('must not replay'); } });
      await restarted.init();
      expect(await restarted.handle(a.peerId, request)).toMatchObject({ type: 'status', value: { state: 'completed' } });
      expect(await restarted.handle(a.peerId, { op: 'ack', ref: p.spec })).toMatchObject({ type: 'status', value: { acknowledged: true } });
      expect(await restarted.handle(a.peerId, { op: 'result', ref: p.spec })).toMatchObject({ type: 'error', code: 'not_found' });
      await restarted.stop();
    } finally { release(); await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});
