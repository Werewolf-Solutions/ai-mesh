/**
 * Local cluster generator. Creates N distinct nodes (own identity, secrets,
 * config and state), cross-approves them in every node's authorized-peers.json
 * (simulating N operators each approving the others), and for Docker mode
 * writes a Compose file with one runtime container per node.
 *
 * Nodes 1 and 2 are configured as bootstrap + relay servers ("public" role);
 * every other node lists both as bootstrap addresses. This is for local
 * testing: all addresses are private Docker-network or loopback addresses.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeAuthorized } from './admission.js';
import type { NodeConfigInput } from './config.js';
import { loadManifest, type Manifest } from './model.js';
import { initNode } from './onboarding.js';
import { atomicWriteFile, exists } from './util/fs.js';
import { REPO_ROOT } from './version.js';

export interface ClusterOptions {
  nodes: number;
  mode: 'docker' | 'native';
  out: string;
  networkId: string;
  fake: boolean;
  modelsDir: string;
  threads: number;
  basePort: number;
  image: string;
  cpus: number;
  memLimit: string;
}

export interface ClusterNode {
  index: number;
  name: string;
  dir: string;
  peerId: string;
  httpPort: number;
  p2pPort: number;
}

export async function generateCluster(o: ClusterOptions): Promise<ClusterNode[]> {
  if (o.nodes < 2 || o.nodes > 10) throw new Error('--nodes must be between 2 and 10');
  const out = resolve(o.out);
  if (await exists(join(out, 'cluster.json'))) {
    throw new Error(`${out} already contains a cluster; identities are never regenerated. Use a new --out or run: ./mesh reset --data ${out} --yes`);
  }
  await mkdir(out, { recursive: true, mode: 0o700 });
  const manifest = await loadManifest(join(REPO_ROOT, 'models/manifest.json'));
  const nodes: ClusterNode[] = [];
  const bootstrapCount = Math.min(2, o.nodes);

  // Pass 1: identities.
  for (let i = 1; i <= o.nodes; i++) {
    const name = `node${i}`;
    const dir = join(out, name);
    const httpPort = o.mode === 'docker' ? o.basePort + i : o.basePort + i;
    const p2pPort = o.mode === 'docker' ? 4001 : o.basePort + 100 + i;
    const { peerId } = await initNode(dir, { networkId: o.networkId, label: name, config: nodeConfig(o, i, httpPort, p2pPort, []) });
    nodes.push({ index: i, name, dir, peerId, httpPort, p2pPort });
  }

  // Pass 2: bootstrap lists + mutual approval (what each operator would do by hand).
  const addrOf = (n: ClusterNode) =>
    o.mode === 'docker' ? `/dns4/${n.name}/tcp/4001/p2p/${n.peerId}` : `/ip4/127.0.0.1/tcp/${n.p2pPort}/p2p/${n.peerId}`;
  for (const n of nodes) {
    const bootstrap = nodes.filter((b) => b.index <= bootstrapCount && b.index !== n.index).map(addrOf);
    const cfg = nodeConfig(o, n.index, n.httpPort, n.p2pPort, bootstrap);
    cfg.networkId = o.networkId;
    cfg.label = n.name;
    await atomicWriteFile(join(n.dir, 'node.json'), JSON.stringify(cfg, null, 2) + '\n');
    // Approve every other node. Only bootstrap nodes get addresses; the rest are found via peer exchange.
    await writeAuthorized(n.dir, {
      networkId: o.networkId,
      peers: nodes.filter((p) => p.index !== n.index).map((p) => ({ peerId: p.peerId, label: p.name })),
    });
    if (o.mode === 'docker') await atomicWriteFile(join(n.dir, 'runtime.key'), randomBytes(24).toString('base64url') + '\n', 0o600);
  }

  await writeFile(
    join(out, 'cluster.json'),
    JSON.stringify({ networkId: o.networkId, mode: o.mode, fake: o.fake, nodes: nodes.map(({ dir, ...n }) => ({ ...n, dir })) }, null, 2) + '\n',
    { mode: 0o600 },
  );
  if (o.mode === 'docker') await writeFile(join(out, 'compose.yaml'), composeFile(o, nodes, manifest));
  return nodes;
}

function nodeConfig(o: ClusterOptions, i: number, httpPort: number, p2pPort: number, bootstrap: string[]): NodeConfigInput {
  const isPublic = i <= 2;
  const docker = o.mode === 'docker';
  return {
    networkId: o.networkId,
    label: `node${i}`,
    p2p: {
      listen: [docker ? '/ip4/0.0.0.0/tcp/4001' : `/ip4/127.0.0.1/tcp/${p2pPort}`],
      announce: docker ? [`/dns4/node${i}/tcp/4001`] : [],
      bootstrap,
      relayServer: isPublic,
      useRelays: !isPublic,
      relayReservations: 2,
    },
    http: docker
      ? { host: '0.0.0.0', port: 8080, trustLoopback: false, allowedHosts: ['localhost', '127.0.0.1'] }
      : { host: '127.0.0.1', port: httpPort, trustLoopback: true },
    runtime: {
      kind: o.fake ? 'fake' : 'llama.cpp',
      mode: docker ? 'external' : 'spawn',
      ...(docker ? { url: `http://runtime${i}:8080`, apiKeyFile: '/data/runtime.key' } : {}),
      threads: o.threads,
      batchThreads: o.threads,
    },
    model: docker ? { dir: '/models', manifest: '/app/models/manifest.json' } : { dir: resolve(o.modelsDir) },
    shutdown: { graceMs: 10_000 },
  };
}

function composeFile(o: ClusterOptions, nodes: ClusterNode[], m: Manifest): string {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const models = resolve(o.modelsDir);
  const lines: string[] = [];
  lines.push(`# Generated by: ./mesh cluster generate --nodes ${o.nodes} --mode docker`);
  lines.push('# Each node has its own identity, state directory, runtime container and private runtime network.');
  lines.push('# Model bytes are shared READ-ONLY. Runtime ports are never published. Addresses are Docker-internal.');
  lines.push(`name: wam-${o.networkId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
  lines.push('');
  lines.push('x-hardening: &hardening');
  lines.push(`  user: "${uid}:${gid}"`);
  lines.push('  read_only: true');
  lines.push('  cap_drop: [ALL]');
  lines.push('  security_opt: ["no-new-privileges:true"]');
  lines.push('  tmpfs: ["/tmp:size=16m"]');
  lines.push('');
  lines.push('services:');
  lines.push('  model-verify:');
  lines.push('    <<: *hardening');
  lines.push(`    image: ${o.image}`);
  lines.push('    command: ["model", "verify", "--dir", "/models"]');
  lines.push('    network_mode: none');
  lines.push('    restart: "no"');
  lines.push(`    volumes: ["${models}:/models:ro"]`);
  for (const n of nodes) {
    lines.push('');
    lines.push(`  runtime${n.index}:`);
    lines.push('    <<: *hardening');
    lines.push(`    image: ${m.runtime.image}`);
    if (o.fake) {
      lines.push('    profiles: ["real-runtime"]  # fake cluster: runtime containers not started');
    }
    lines.push('    command:');
    for (const a of [
      '-m', `/models/${m.artifact.filename}`, '--host', '0.0.0.0', '--port', '8080',
      '-c', '2048', '-np', '1', '-t', String(o.threads), '-tb', String(o.threads), '-n', '256',
      '--api-key-file', '/keys/runtime.key', '--no-webui', '--offline', '--no-slots',
    ]) lines.push(`      - "${a}"`);
    lines.push('    volumes:');
    lines.push(`      - "${models}:/models:ro"`);
    lines.push(`      - "./${n.name}/runtime.key:/keys/runtime.key:ro"`);
    lines.push(`    networks: [rt${n.index}]`);
    lines.push('    restart: unless-stopped');
    lines.push(`    cpus: ${o.cpus}`);
    lines.push(`    mem_limit: ${o.memLimit}`);
    lines.push('    depends_on:');
    lines.push('      model-verify: { condition: service_completed_successfully }');
    lines.push('');
    lines.push(`  ${n.name}:`);
    lines.push('    <<: *hardening');
    lines.push(`    image: ${o.image}`);
    lines.push('    command: ["start", "--data", "/data"]');
    lines.push('    environment:');
    lines.push('      MESH_DATA_DIR: /data');
    lines.push('      MESH_LOG_LEVEL: info');
    if (o.fake) lines.push('      MESH_ALLOW_FAKE_RUNTIME: "1"');
    lines.push('    volumes:');
    lines.push(`      - "./${n.name}:/data"`);
    lines.push(`      - "${models}:/models:ro"`);
    lines.push(`    networks: [mesh${o.fake ? '' : `, rt${n.index}`}]`);
    lines.push(`    ports: ["127.0.0.1:${n.httpPort}:8080"]`);
    lines.push('    restart: unless-stopped');
    lines.push('    stop_grace_period: 20s');
    lines.push('    cpus: 1');
    lines.push('    mem_limit: 512m');
    if (!o.fake) {
      lines.push('    depends_on:');
      lines.push(`      runtime${n.index}: { condition: service_started }`);
    }
  }
  lines.push('');
  lines.push('networks:');
  lines.push('  mesh: {}');
  for (const n of nodes) lines.push(`  rt${n.index}: { internal: true }`);
  lines.push('');
  return lines.join('\n');
}
