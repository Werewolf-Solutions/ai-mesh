import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { FarmClient } from '@werewolf-mesh/client';
import { FarmPackage } from '@werewolf-mesh/protocol';
import { DEFAULT_FARM_IMAGE } from '../../apps/node/src/farm/service.js';
import { sha256, sourceDigest } from '../../apps/node/src/farm/source.js';
import { admin, makeCluster, stopNode, waitAvailable, waitFor, type TestCluster, type TestNode } from '../harness.js';

describe('trusted farm over authenticated peer transport with real Docker execution', () => {
  let cluster: TestCluster, a: TestNode, b: TestNode, client: FarmClient;
  beforeAll(async () => {
    cluster = await makeCluster({ nodes: 2 }); [a, b] = cluster.nodes as [TestNode, TestNode];
    await Promise.all(cluster.nodes.map((n) => cluster.start(n))); await waitAvailable(a, [b]);
    client = new FarmClient({ url: a.url, token: a.adminToken });
  });
  afterAll(async () => { await cluster?.cleanup(); });
  const policy = async (enabled: boolean, requesters = [a.peerId]) => {
    const r = await fetch(`${b.url}/admin/farm/policy`, { method: 'POST', headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, requesters, images: [DEFAULT_FARM_IMAGE], timeoutMs: 60000 }) });
    expect(r.status).toBe(200);
  };
  const job = (name: string, commands: string[]) => {
    const data = Buffer.from('private source\n'), source = { files: [{ path: 'input.txt', data: data.toString('base64'), sha256: sha256(data) }] };
    return FarmPackage.parse({ spec: { v: 1, kind: 'routine', jobId: name, attemptId: 'one', fence: 1, requesterPeerId: a.peerId, targetPeerId: b.peerId,
      projectId: 'project', workspaceId: 'personal', title: 'Verification', source: { baseCommit: 'b'.repeat(40), digest: sourceDigest(source) }, image: DEFAULT_FARM_IMAGE,
      architecture: process.arch, steps: commands.map((command, i) => ({ name: `step${i}`, command })), network: 'none', retry: 'isolated', limits: { timeoutMs: 20000 } }, source });
  };
  const completed = async (pkg: ReturnType<typeof job>) => {
    await waitFor(async () => !!(await client.status(pkg.spec)).result, 30000, 'encrypted result collected');
    return client.status(pkg.spec);
  };
  it('is off by default and rejects ordinary inference client credentials', async () => {
    expect((await client.discover(b.peerId)).permitted).toBe(false);
    const ordinary = new FarmClient({ url: a.url, token: a.clientToken });
    await expect(ordinary.discover(b.peerId)).rejects.toThrow(/admin/);
    await expect(client.submit({ targetPeerId: b.peerId, package: job('disabled', ['true']) })).rejects.toThrow(/not granted/);
  });
  it('runs test/typecheck/build routines without a model, returns encrypted evidence and survives requester restart', async () => {
    await policy(true);
    const pkg = job('verify', [
      'node -e "const fs=require(\'fs\');if(fs.readFileSync(\'input.txt\',\'utf8\')!==\'private source\\n\')process.exit(1);console.log(\'test passed\')"',
      'node --check /dev/null', 'node -e "require(\'fs\').writeFileSync(\'output.txt\',\'build\');console.log(\'build passed\')"',
    ]);
    pkg.spec.outputs = ['output.txt'];
    expect((await client.submit({ targetPeerId: b.peerId, package: pkg })).state).toBe('accepted');
    const result = await completed(pkg); expect(result.state).toBe('completed'); expect(result.result?.steps).toHaveLength(3);
    expect(result.result?.steps[0]?.stdout).toContain('test passed'); expect(result.result?.steps[2]?.stdout).toContain('build passed');
    expect(result.result?.artifacts).toEqual([{ path: 'output.txt', data: Buffer.from('build').toString('base64'), sha256: sha256('build') }]);
    await stopNode(a); await cluster.start(a); await waitAvailable(a, [b]);
    expect((await client.status(pkg.spec)).result).toEqual(result.result);
    expect((await client.submit({ targetPeerId: b.peerId, package: pkg })).result).toEqual(result.result);
    const worker = await admin(b, '/admin/farm'); expect(worker.jobs[0]?.cleanup).toBe('done');
    const path = join(b.dir, 'farm/worker');
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(path)) expect((await readFile(join(path, file))).toString()).not.toContain('private source');
    expect((await client.acknowledge(pkg.spec)).status?.acknowledged).toBe(true);
  });
  it('keeps commands offline, excludes host files and enforces owner caps', async () => {
    const pkg = job('isolation', [
      'test ! -e /var/run/docker.sock && test ! -e /home/oznerol && node -e "const n=require(\'net\').connect(443,\'1.1.1.1\');n.on(\'connect\',()=>process.exit(1));n.on(\'error\',()=>process.exit(0));setTimeout(()=>process.exit(0),300)"',
    ]);
    await client.submit({ targetPeerId: b.peerId, package: pkg }); expect((await completed(pkg)).state).toBe('completed');
    const excessive = job('excessive', ['true']); excessive.spec.limits.cpus = 2;
    expect((await client.submit({ targetPeerId: b.peerId, package: excessive })).state).toBe('rejected');
  });
  it('cancels on owner disable and accepts a fresh routine after cleanup', async () => {
    const pkg = job('cancel', ['sleep 20']);
    await client.submit({ targetPeerId: b.peerId, package: pkg });
    await waitFor(async () => (await client.status(pkg.spec)).state === 'running', 5000);
    await policy(false);
    await waitFor(async () => (await client.status(pkg.spec)).state === 'cancelled', 15000);
    await waitFor(async () => !(await admin(b, '/admin/farm')).active, 15000);
    expect((await admin(b, '/admin/farm')).jobs.find((j: any) => j.jobId === 'cancel').cleanup).toBe('done');
    await policy(true);
    const next = job('after_cancel', ['true']); await client.submit({ targetPeerId: b.peerId, package: next }); expect((await completed(next)).state).toBe('completed');
  });
  it('reports failed checks, bounded output and work-disk exhaustion', async () => {
    const failed = job('failed_check', ['printf "failure"; exit 7', 'echo must-not-run']);
    await client.submit({ targetPeerId: b.peerId, package: failed });
    const result = await completed(failed); expect(result.state).toBe('failed'); expect(result.result?.steps).toHaveLength(1); expect(result.result?.steps[0]?.exitCode).toBe(7);
    const noisy = job('output_limit', ['node -e "process.stdout.write(\'x\'.repeat(100000))"']); noisy.spec.limits.outputBytes = 1024;
    await client.submit({ targetPeerId: b.peerId, package: noisy });
    const output = await completed(noisy); expect(output.state).toBe('failed'); expect(output.result?.truncated).toBe(true);
    expect(Buffer.byteLength(output.result?.steps[0]?.stdout ?? '')).toBeLessThanOrEqual(1024);
    const disk = job('disk_limit', ['dd if=/dev/zero of=large bs=1M count=20']); disk.spec.limits.diskMb = 8;
    await client.submit({ targetPeerId: b.peerId, package: disk });
    const exhausted = await completed(disk); expect(exhausted.state).toBe('failed'); expect(exhausted.result?.steps[0]?.stderr).toContain('No space left');
  });
  it('rejects absent pinned images without pulling or starting an attempt', async () => {
    const image = `node:22-bookworm-slim@sha256:${'0'.repeat(64)}`;
    const response = await fetch(`${b.url}/admin/farm/policy`, { method: 'POST', headers: { authorization: `Bearer ${b.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, requesters: [a.peerId], images: [image] }) });
    expect(response.status).toBe(200);
    const pkg = job('missing_image', ['true']); pkg.spec.image = image;
    expect((await client.submit({ targetPeerId: b.peerId, package: pkg })).state).toBe('rejected');
    expect((await admin(b, '/admin/farm')).jobs.some((j: any) => j.jobId === 'missing_image')).toBe(false);
    await policy(true);
  });
  it('refuses symlink artifacts and can acknowledge failure without a result', async () => {
    const pkg = job('artifact_symlink', ['ln -s /etc/hostname output.txt']); pkg.spec.outputs = ['output.txt'];
    await client.submit({ targetPeerId: b.peerId, package: pkg });
    await waitFor(async () => (await client.status(pkg.spec)).state === 'failed', 15000);
    const result = await client.status(pkg.spec); expect(result.status?.resultAvailable).toBe(false); expect(result.result).toBeUndefined();
    expect((await client.acknowledge(pkg.spec)).status?.acknowledged).toBe(true);
  });
  it('recovers a killed worker by cleaning its containers and never replaying the routine', async () => {
    const pkg = job('worker_crash', ['sleep 20']);
    await client.submit({ targetPeerId: b.peerId, package: pkg });
    await waitFor(async () => {
      const r = spawnSync('docker', ['ps', '-q', '--filter', `label=werewolf.farm=${b.peerId}`], { encoding: 'utf8' });
      return r.status === 0 && r.stdout.trim().length > 0;
    }, 10000);
    await stopNode(b, 'SIGKILL'); await cluster.start(b); await waitAvailable(a, [b]);
    await waitFor(async () => (await client.status(pkg.spec)).state === 'interrupted', 15000);
    const containers = spawnSync('docker', ['ps', '-q', '--filter', `label=werewolf.farm=${b.peerId}`], { encoding: 'utf8' });
    expect(containers.stdout.trim()).toBe('');
    const worker = await admin(b, '/admin/farm'); expect(worker.jobs.find((j: any) => j.jobId === 'worker_crash').cleanup).toBe('done');
  });
  it('stops work after requester loss expires its lease', async () => {
    const pkg = job('lease_loss', ['sleep 55']); pkg.spec.limits.timeoutMs = 60000;
    await client.submit({ targetPeerId: b.peerId, package: pkg });
    await waitFor(async () => (await client.status(pkg.spec)).state === 'running', 5000);
    await stopNode(a, 'SIGKILL');
    await waitFor(async () => (await admin(b, '/admin/farm')).jobs.find((j: any) => j.jobId === 'lease_loss')?.state === 'cancelled', 40000);
    await waitFor(async () => !(await admin(b, '/admin/farm')).active, 10000);
    await cluster.start(a); await waitAvailable(a, [b]);
    await waitFor(async () => (await client.status(pkg.spec)).state === 'cancelled', 10000);
  });
});
