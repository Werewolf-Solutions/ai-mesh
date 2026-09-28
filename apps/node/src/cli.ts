#!/usr/bin/env node
/**
 * `./mesh` — operator CLI for Werewolf AI Mesh. Run `./mesh help`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { SseParser } from '@werewolf-mesh/protocol';
import { readAuthorized } from './admission.js';
import { parseArgs, type Args } from './cli/args.js';
import { generateCluster } from './cluster.js';
import { FILES, loadConfig, NodeConfigSchema, resolveDataDir, type NodeConfigInput } from './config.js';
import { DEFAULT_MODEL_ID, downloadVerified, importModel, loadCatalog, loadRuntimePin, platformKey, sha256File, verifyModel, type Manifest, type RuntimePin } from './model.js';
import { approveFromJoinFile, approvePeer, initNode, joinInfo, revokePeer } from './onboarding.js';
import { ScorerManifestSchema } from './scoring/scorer.js';
import { loadSecrets } from './secrets.js';
import { atomicWriteFile, exists, looseModeWarning, readJsonIfExists } from './util/fs.js';
import { REPO_ROOT, SOFTWARE_VERSION } from './version.js';

const HELP = `Werewolf AI Mesh ${SOFTWARE_VERSION} — self-hosted replicated inference network

Usage: ./mesh <command> [options]        (default data dir: ./data/node or $MESH_DATA_DIR)

Setup
  doctor                                Check prerequisites (Node, CPU/RAM/disk, Docker, model, runtime)
  runtime install                       Download the pinned llama.cpp build for this platform (SHA-256 verified)
  model download [--dir DIR]            Download the pinned GGUF once (SHA-256 verified)
  model import <file.gguf> [--dir DIR]  Import an existing local GGUF (no network), verify, copy into DIR
  model verify [--dir DIR]              Re-hash the model file against its catalog manifest
                                        (model commands take --model ID; default: the small default model)
  models [list]                         The model catalog: size, RAM, thinking, installed/served here
  models install ID [--data DIR]        Download (verified) and host a catalog model on this node
  models unhost ID [--data DIR]         Stop serving a model on this node (keeps the file)
  models remove ID                      Delete a model file that is not being served
  gpu [status|on [cuda|vulkan]|off]     Run this node's models on its GPU (shares it with the pack) or on the CPU
  model download|import|verify --scorer Same, for the optional embedding model that scores summaries in the UI

Node
  init [--data DIR] --network ID [--label NAME] [--http-host H] [--http-port N] [--p2p-port N]
       [--announce MULTIADDR]... [--bootstrap MULTIADDR]... [--relay-server] [--no-relays]
       [--threads N] [--docker]         Create config, identity and HTTP tokens (never overwrites)
  join-info [--data DIR] [--out FILE]   Print PUBLIC join info (peer ID + advertised addresses)
  peers approve <join.json|PEER_ID> [--label L] [--addr MULTIADDR]...   Authorise a peer
  peers revoke <PEER_ID>                Remove a peer from this node's authorised list
  peers list                            Show this node's authorised list (local file)
  peers status                          Live peer view from the running node (local, partial)
  start [--data DIR] [--detach]         Run the node (foreground unless --detach)
  stop [--data DIR]                     Graceful stop of a detached node (keeps all data)
  status [--data DIR]                   Node status from the running node
  ui-url [--data DIR]                   Print the local UI URL with credentials in the URL fragment
  chat "PROMPT" [--data DIR] [--url URL --token T] [--target local|PEER_ID] [--prefer PEER_ID] [--no-stream]
  reset --data DIR --yes                DELETE a node's identity, tokens and state (explicit, destructive)

Local clusters
  cluster generate --nodes N [--mode docker|native] [--out DIR] [--network ID] [--models ID,ID] [--fake] [--threads N]
  cluster up|down|ps|logs --dir DIR     Docker Compose wrapper for a generated docker cluster
  cluster start|stop --dir DIR          Start/stop a generated NATIVE cluster (background processes)
  demo failover --dir DIR               Scripted failover/interruption/bootstrap-loss demonstration
`;

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
});
const out = (s = '') => process.stdout.write(s + '\n');

const CATALOG_DIR = () => process.env.MESH_MODEL_CATALOG ?? join(REPO_ROOT, 'models/catalog');

/** A catalog entry by ID (default: the small default model). */
async function manifest(id: string = DEFAULT_MODEL_ID): Promise<Manifest> {
  const all = await loadCatalog(CATALOG_DIR());
  const m = all.find((e) => e.id === id);
  if (!m) fail(`"${id}" is not in the catalog. Available: ${all.map((e) => e.id).join(', ')}`);
  return m;
}
async function runtimePin(): Promise<RuntimePin> {
  return loadRuntimePin(join(REPO_ROOT, 'models/runtime.json'));
}
function modelsDir(a: Args): string {
  return resolve(a.get('dir') ?? process.env.MESH_MODEL_DIR ?? join(REPO_ROOT, 'models'));
}
function dataDir(a: Args): string {
  return resolveDataDir(a.get('data'));
}

// ------------------------------------------------------------------ doctor
async function doctor(a: Args): Promise<void> {
  let bad = 0;
  const line = (ok: boolean | 'warn', what: string, detail = '') => {
    if (ok === false) bad++;
    out(`${ok === true ? ' ok ' : ok === 'warn' ? 'warn' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  };
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  line(maj > 22 || (maj === 22 && min >= 12), 'Node.js >= 22.12', process.versions.node);
  const plat = platformKey();
  line(plat === 'linux-x64' ? true : 'warn', 'platform', `${plat}${plat === 'linux-x64' ? ' (tested)' : ' (NOT tested; linux-x64 is the verified baseline)'}`);
  const cores = cpus().length;
  line(cores >= 2 ? true : 'warn', 'CPU cores', `${cores} (initial target: 2 vCPU per node)`);
  const ram = totalmem() / 2 ** 30;
  line(ram >= 1.9 ? true : 'warn', 'RAM', `${ram.toFixed(1)} GiB total, ${(freemem() / 2 ** 30).toFixed(1)} GiB free (initial target: 2 GiB per node)`);
  try {
    const s = await statfs(REPO_ROOT);
    const free = (s.bavail * s.bsize) / 2 ** 30;
    line(free >= 1 ? true : false, 'disk free', `${free.toFixed(1)} GiB at ${REPO_ROOT} (model ~0.1 GiB, runtime ~0.1 GiB, image ~0.5 GiB)`);
  } catch {
    line('warn', 'disk free', 'unknown');
  }
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  line(docker.status === 0 ? true : 'warn', 'Docker engine', docker.status === 0 ? docker.stdout.trim() : 'not available (native mode still works)');
  const compose = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  line(compose.status === 0 ? true : 'warn', 'Docker Compose', compose.status === 0 ? compose.stdout.trim() : 'not available');
  const rt = await runtimePin();
  const hostedIds = await (async () => {
    const st = (await readJsonIfExists(join(dataDir(a), 'models-state.json'))) as { hosted?: string[] } | undefined;
    if (st?.hosted) return st.hosted;
    const cfg = await loadConfig(dataDir(a)).catch(() => null);
    return cfg?.model.host ?? [DEFAULT_MODEL_ID];
  })();
  for (const id of hostedIds) {
    const m = await manifest(id);
    const v = await verifyModel(m, modelsDir(a));
    line(v.ok, `model ${id}`, v.ok ? `${m.artifact.filename} sha256 verified (${v.ms} ms)` : `${v.detail} — run ./mesh model download --model ${id}`);
  }
  const bin = join(REPO_ROOT, '.cache/runtime', rt.binaries[plat]?.dir ?? 'x', 'llama-server');
  if (await exists(bin)) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    const txt = `${r.stdout}${r.stderr}`;
    const want = rt.release.replace('b', '');
    line(txt.includes(`build ${want}`), 'llama.cpp runtime (native)', txt.split('\n').find((l) => l.startsWith('version')) ?? 'unknown');
  } else {
    line('warn', 'llama.cpp runtime (native)', 'not installed — run ./mesh runtime install (not needed for Docker)');
  }
  const img = spawnSync('docker', ['image', 'inspect', `werewolf-mesh/node:${SOFTWARE_VERSION}`, '--format', 'present'], { encoding: 'utf8' });
  if (docker.status === 0) line(img.status === 0 ? true : 'warn', 'node image', img.status === 0 ? `werewolf-mesh/node:${SOFTWARE_VERSION}` : 'not built: docker build -f deploy/Dockerfile -t werewolf-mesh/node:' + SOFTWARE_VERSION + ' .');
  const dd = dataDir(a);
  if (await exists(join(dd, FILES.config))) {
    for (const f of [FILES.identity, FILES.secrets]) {
      const w = await looseModeWarning(join(dd, f));
      line(w ? false : true, `permissions ${f}`, w ?? '0600');
    }
    const cfg = await loadConfig(dd).catch(() => null);
    if (cfg) {
      for (const [what, port] of [['HTTP port', cfg.http.port], ['p2p port', Number(/tcp\/(\d+)/.exec(cfg.p2p.listen[0] ?? '')?.[1] ?? 0)]] as const) {
        if (!port) continue;
        const free = await portFree(port);
        line(free ? true : 'warn', `${what} ${port}`, free ? 'free' : 'in use (node already running?)');
      }
    }
  } else {
    line('warn', 'node data', `${dd} not initialised — run ./mesh init --network <id>`);
  }
  out(bad ? `\n${bad} check(s) failed.` : '\nAll required checks passed.');
  if (bad) process.exitCode = 1;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '0.0.0.0', () => s.close(() => res(true)));
  });
}

// ------------------------------------------------------------------ runtime / model
async function runtimeInstall(): Promise<void> {
  const rt = await runtimePin();
  const key = platformKey();
  const b = rt.binaries[key];
  if (!b) fail(`no pinned llama.cpp binary for ${key}; use Docker or build llama.cpp ${rt.release} yourself`);
  if (!b.tested) out(`warning: the ${key} binary is pinned but has NOT been tested with this project`);
  const dir = join(REPO_ROOT, '.cache/runtime');
  const tarball = join(dir, basename(new URL(b.url).pathname));
  if (!(await exists(tarball)) || (await sha256File(tarball)) !== b.sha256) {
    out(`downloading ${b.url}`);
    await downloadVerified(b.url, tarball, { sha256: b.sha256 }, progress);
    out('');
  }
  out(`sha256 ok ${b.sha256}`);
  await mkdir(dir, { recursive: true });
  const r = spawnSync('tar', ['xzf', tarball, '-C', dir], { stdio: 'inherit' });
  if (r.status !== 0) fail('tar extraction failed');
  out(`installed: ${join(dir, b.dir, 'llama-server')}`);
}

function progress(done: number, total: number | null): void {
  const mb = (n: number) => (n / 2 ** 20).toFixed(1);
  process.stdout.write(`\r  ${mb(done)} MiB${total ? ` / ${mb(total)} MiB` : ''}   `);
}

async function modelCmd(a: Args): Promise<void> {
  const sub = a._[1];
  const dir = modelsDir(a);
  if (a.has('scorer')) return scorerModelCmd(sub, dir, a);
  const m = await manifest(a.get('model') ?? DEFAULT_MODEL_ID);
  if (sub === 'verify') {
    const v = await verifyModel(m, dir);
    if (!v.ok) fail(`${v.reason}: ${v.detail}`);
    out(`ok ${v.path}\n   sha256 ${v.sha256} matches manifest (${v.ms} ms)`);
    return;
  }
  if (sub === 'download') {
    const v = await verifyModel(m, dir);
    if (v.ok) {
      out(`already present and verified: ${v.path}`);
      return;
    }
    const dest = join(dir, m.artifact.filename);
    out(`downloading ${m.artifact.url}\n  -> ${dest}`);
    await downloadVerified(m.artifact.url, dest, { sha256: m.artifact.sha256, sizeBytes: m.artifact.sizeBytes }, progress);
    out(`\nverified sha256 ${m.artifact.sha256}`);
    out(`licence: ${m.source.license}. ${m.source.attribution}`);
    return;
  }
  if (sub === 'import') {
    const src = a._[2];
    if (!src) fail('usage: ./mesh model import <file.gguf>');
    const v = await importModel(m, resolve(src), dir);
    if (!v.ok) fail(`${v.reason}: ${v.detail}`);
    out(`imported and verified: ${v.path}`);
    return;
  }
  fail('usage: ./mesh model download|import|verify');
}

/** The optional embedding model used to score summaries in the UI's reading test. */
async function scorerModelCmd(sub: string | undefined, dir: string, a: Args): Promise<void> {
  const sm = ScorerManifestSchema.parse(JSON.parse(await readFile(process.env.MESH_SCORER_MANIFEST ?? join(REPO_ROOT, 'models/scorer-manifest.json'), 'utf8')));
  // verifyModel/importModel only use the artifact fields.
  const asManifest = { artifact: sm.artifact } as unknown as Manifest;
  if (sub === 'verify') {
    const v = await verifyModel(asManifest, dir);
    if (!v.ok) fail(`${v.reason}: ${v.detail}`);
    out(`ok ${v.path}\n   sha256 ${v.sha256} matches the scorer manifest (${v.ms} ms)`);
    return;
  }
  if (sub === 'download') {
    const v = await verifyModel(asManifest, dir);
    if (v.ok) {
      out(`already present and verified: ${v.path}`);
      return;
    }
    const dest = join(dir, sm.artifact.filename);
    out(`downloading ${sm.artifact.url}\n  -> ${dest}`);
    await downloadVerified(sm.artifact.url, dest, { sha256: sm.artifact.sha256, sizeBytes: sm.artifact.sizeBytes }, progress);
    out(`\nverified sha256 ${sm.artifact.sha256}`);
    out(`licence: ${sm.license}. ${sm.attribution}`);
    out('Restart the node to enable meaning-match scoring in the UI.');
    return;
  }
  if (sub === 'import') {
    const src = a._[2] ?? fail('usage: ./mesh model import --scorer <file.gguf>');
    const v = await importModel(asManifest, resolve(src), dir);
    if (!v.ok) fail(`${v.reason}: ${v.detail}`);
    out(`imported and verified: ${v.path}`);
    return;
  }
  fail('usage: ./mesh model download|import|verify --scorer');
}

// ------------------------------------------------------------------ models (catalog)
async function modelsCmd(a: Args): Promise<void> {
  const sub = a._[1] ?? 'list';
  const dir = modelsDir(a);
  const catalog = await loadCatalog(CATALOG_DIR());
  const dd = dataDir(a);
  const statePath = join(dd, 'models-state.json');
  const readHosted = async (): Promise<string[]> => {
    const st = (await readJsonIfExists(statePath)) as { hosted?: string[] } | undefined;
    if (st?.hosted) return st.hosted;
    return (await loadConfig(dd).catch(() => null))?.model.host ?? [DEFAULT_MODEL_ID];
  };
  const running = async () => {
    if (!(await exists(join(dd, FILES.config)))) return null;
    try {
      return (await adminFetch(a, '/admin/models')) as { models: Array<{ id: string; local?: { state: string; progress?: { done: number; total: number }; error?: string } }> };
    } catch {
      return null;
    }
  };
  if (sub === 'list') {
    const live = await running();
    const hosted = await readHosted();
    out('Vetted models (all run on the pinned llama.cpp build; RAM measured at 8k context):\n');
    for (const e of catalog) {
      const file = (await verifyModel(e, dir).then((v) => v.ok)) ? 'installed' : 'not installed';
      const state = live?.models.find((m) => m.id === e.id)?.local?.state ?? (hosted.includes(e.id) ? 'hosted (node not running)' : file);
      out(`  ${e.id.padEnd(38)} ${e.displayName.padEnd(16)} ${(e.artifact.sizeBytes / 2 ** 30).toFixed(1).padStart(4)} GB  ~${(e.resources.ramMB / 1024).toFixed(1)} GB RAM  ${e.capabilities.thinking === 'none' ? '          ' : 'thinking  '}${state}`);
    }
    out('\nInstall and host one: ./mesh models install <id>');
    return;
  }
  const id = a._[2] ?? fail(`usage: ./mesh models ${sub} <id>`);
  const e = catalog.find((x) => x.id === id) ?? fail(`"${id}" is not in the catalog (./mesh models)`);
  if (sub === 'install') {
    const live = await running();
    if (live) {
      await adminFetch(a, `/admin/models/${id}/install`, 'POST');
      out(`installing ${e.displayName} on the running node…`);
      while (true) {
        await new Promise((r) => setTimeout(r, 1000));
        const m = (await running())?.models.find((x) => x.id === id);
        const st = m?.local?.state ?? '?';
        if (m?.local?.progress) process.stdout.write(`\r  ${st} ${(m.local.progress.done / 2 ** 20).toFixed(0)} / ${(m.local.progress.total / 2 ** 20).toFixed(0)} MiB   `);
        else process.stdout.write(`\r  ${st}                         `);
        if (st === 'serving') {
          out(`\n${e.displayName} is now served by this node.`);
          return;
        }
        if (st === 'failed') fail(`\n${m?.local?.error ?? 'install failed'}`);
      }
    }
    const v = await verifyModel(e, dir);
    if (!v.ok) {
      out(`downloading ${e.artifact.url}`);
      await downloadVerified(e.artifact.url, join(dir, e.artifact.filename), { sha256: e.artifact.sha256, sizeBytes: e.artifact.sizeBytes }, progress);
      out('\nverified');
    }
    const hosted = await readHosted();
    if (!hosted.includes(id)) await atomicWriteFile(statePath, JSON.stringify({ version: 1, hosted: [...hosted, id] }, null, 2) + '\n');
    out(`${e.displayName} will be served when the node starts. Licence: ${e.source.license}. ${e.source.attribution}`);
    return;
  }
  if (sub === 'unhost') {
    if (await running()) await adminFetch(a, `/admin/models/${id}/unhost`, 'POST');
    else await atomicWriteFile(statePath, JSON.stringify({ version: 1, hosted: (await readHosted()).filter((x) => x !== id) }, null, 2) + '\n');
    out(`${e.displayName} is no longer served by this node (the file is kept).`);
    return;
  }
  if (sub === 'remove') {
    if ((await readHosted()).includes(id)) fail('the node still hosts this model; run: ./mesh models unhost ' + id);
    await unlink(join(dir, e.artifact.filename)).catch(() => undefined);
    out(`deleted ${e.artifact.filename}`);
    return;
  }
  fail('usage: ./mesh models [list|install|unhost|remove]');
}

async function gpuCmd(a: Args): Promise<void> {
  const sub = a._[1] ?? 'status';
  const dd = dataDir(a);
  if (!(await exists(join(dd, FILES.config)))) fail(`no node at ${dd}`);
  let live: any = null;
  try {
    live = await adminFetch(a, '/admin/runtime');
  } catch {
    /* node not running */
  }
  if (sub === 'status') {
    const { detectGpus } = await import('./models/gpu.js');
    const gpus = live?.gpus ?? (await detectGpus());
    out(gpus.length ? gpus.map((g: any) => `GPU: ${g.name}${g.vramMB ? ` (${(g.vramMB / 1024).toFixed(0)} GB)` : ''}; works with ${g.backends.join(', ')}`).join('\n') : 'No GPU found (NVIDIA needs its driver; AMD/Intel need a Vulkan driver).');
    if (live) out(`This node runs its models on: ${live.accel === 'cpu' ? 'the CPU' : `the GPU (${live.accel})`}`);
    else out('Node not running.');
    return;
  }
  const target = sub === 'off' ? 'cpu' : sub === 'on' ? (a._[2] ?? 'cuda') : fail('usage: ./mesh gpu [status|on [cuda|vulkan]|off]');
  if (!live) {
    // Not running: install the build now if needed and remember the choice.
    const { installGpuBuild, gpuBuildInstalled } = await import('./models/gpu.js');
    const pin = await runtimePin();
    if (target !== 'cpu' && !gpuBuildInstalled(pin, target as 'cuda' | 'vulkan')) {
      out(`downloading the pinned ${target} build of llama.cpp (verified by SHA-256)…`);
      await installGpuBuild(pin, target as 'cuda' | 'vulkan', progress);
      out('');
    }
    const statePath = join(dd, 'models-state.json');
    const st = ((await readJsonIfExists(statePath)) as { hosted?: string[] } | undefined) ?? {};
    const hosted = st.hosted ?? (await loadConfig(dd).catch(() => null))?.model.host ?? [DEFAULT_MODEL_ID];
    await atomicWriteFile(statePath, JSON.stringify({ version: 1, hosted, accel: target }, null, 2) + '\n');
    out(`The node will run its models on ${target === 'cpu' ? 'the CPU' : `the GPU (${target})`} when it starts.`);
    return;
  }
  const e = await endpoint(a);
  const r = await fetch(e.url + '/admin/runtime', { method: 'POST', headers: { authorization: `Bearer ${e.admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ accel: target }) });
  if (!r.ok) fail(((await r.json()) as any).error?.message ?? `HTTP ${r.status}`);
  out(`switching to ${target}…`);
  while (true) {
    await new Promise((res) => setTimeout(res, 1000));
    const v: any = await adminFetch(a, '/admin/runtime');
    if (v.job?.error) fail(v.job.error);
    if (v.job) process.stdout.write(v.job.phase === 'downloading' ? `\r  downloading ${(v.job.done / 2 ** 20).toFixed(0)} MiB   ` : '\r  restarting models on the new backend…   ');
    const st: any = await adminFetch(a, '/admin/status');
    if (!v.job && v.accel === target && st.models.every((m: any) => m.state === 'serving' || m.state === 'failed')) {
      out(`\nModels now run on ${target === 'cpu' ? 'the CPU' : `the GPU (${target})`}: ${st.models.map((m: any) => `${m.id} ${m.state}`).join(', ')}`);
      return;
    }
  }
}

async function adminFetch(a: Args, path: string, method = 'GET'): Promise<unknown> {
  const e = await endpoint(a);
  const r = await fetch(e.url + path, { method, headers: { authorization: `Bearer ${e.admin}` }, signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  if (!r.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ init / onboarding
async function init(a: Args): Promise<void> {
  const dir = dataDir(a);
  const network = a.get('network');
  const already = await exists(join(dir, FILES.config));
  if (!network && !already) fail('--network <id> is required (all nodes of one mesh share it; it is NOT a password)');
  const docker = a.has('docker');
  const httpPort = a.int('http-port', 8080);
  const p2pPort = a.int('p2p-port', 4001);
  const cfg: Partial<NodeConfigInput> = {
    p2p: {
      listen: [`/ip4/0.0.0.0/tcp/${p2pPort}`],
      announce: a.all('announce'),
      bootstrap: a.all('bootstrap'),
      relayServer: a.has('relay-server'),
      useRelays: !a.has('no-relays'),
    },
    http: docker
      ? { host: '0.0.0.0', port: 8080, trustLoopback: false }
      : { host: a.get('http-host') ?? '127.0.0.1', port: httpPort },
    runtime: docker
      ? { binary: '/opt/llama/llama-server', threads: a.int('threads', 2), batchThreads: a.int('threads', 2) }
      : { threads: a.int('threads', 2), batchThreads: a.int('threads', 2) },
    ...(docker ? { model: { dir: '/models', catalog: '/app/models/catalog', runtimePin: '/app/models/runtime.json' } } : {}),
    ...(docker ? { scorer: { manifest: '/app/models/scorer-manifest.json' } } : {}),
  };
  const r = await initNode(dir, { networkId: network ?? '', label: a.get('label') ?? 'node', config: cfg });
  out(r.createdConfig ? `created ${join(dir, FILES.config)}` : `kept existing ${join(dir, FILES.config)} (not overwritten)`);
  out(r.createdIdentity ? `created identity ${join(dir, FILES.identity)} (private, mode 600)` : 'kept existing identity');
  out(`\npeer ID: ${r.peerId}`);
  out(`\nNext:\n  ./mesh join-info --data ${dir} --out ${basename(dir)}-join.json   # give this PUBLIC file to other operators`);
  out(`  ./mesh peers approve <their-join.json> --data ${dir}          # approve each peer you trust`);
  out(`  ./mesh start --data ${dir}`);
}

async function peersCmd(a: Args): Promise<void> {
  const dir = dataDir(a);
  const sub = a._[1];
  if (sub === 'approve') {
    const x = a._[2];
    if (!x) fail('usage: ./mesh peers approve <join.json|PEER_ID>');
    if (x.endsWith('.json') || (await exists(x))) {
      const r = await approveFromJoinFile(dir, x);
      out(`${r.result} ${r.peerId}`);
    } else {
      const r = await approvePeer(dir, x, { label: a.get('label'), addrs: a.all('addr') });
      out(`${r} ${x}`);
    }
    out('A running node reloads authorized-peers.json within ~5 s (or send SIGHUP).');
    out('Remember: the OTHER operator must approve this node too — admission is mutual.');
    return;
  }
  if (sub === 'revoke') {
    const id = a._[2] ?? fail('usage: ./mesh peers revoke <PEER_ID>');
    out((await revokePeer(dir, id)) ? `revoked ${id}` : `${id} was not authorised`);
    return;
  }
  if (sub === 'list') {
    const l = await readAuthorized(dir);
    if (!l) fail('not initialised');
    out(`network ${l.networkId}; ${l.peers.length} authorised peer(s):`);
    for (const p of l.peers) out(`  ${p.peerId}  ${p.label ?? ''}  ${(p.addrs ?? []).join(' ')}`);
    return;
  }
  if (sub === 'status') {
    const r = (await adminGet(a, '/admin/peers')) as { peers: Array<Record<string, any>> };
    out('LOCAL, PARTIAL view from this node (not a global network view):');
    for (const p of r.peers) {
      out(
        `  ${(p.label ?? '').padEnd(8)} ${p.peerId.slice(-10)}  ${p.connected ? (p.relayed ? 'relayed ' : 'direct  ') : 'offline '}` +
          `${p.available ? 'available  ' : 'unavailable'} state=${p.state ?? '-'} jobs=${p.activeJobs ?? '-'}/${p.queueLength ?? '-'} rtt=${p.rttMs ?? '-'}ms fails=${p.consecutiveFailures}` +
          ` hw=${p.accel ?? '-'}${p.measuredTokPerS ? ` measured=${p.measuredTokPerS} tok/s` : ''} models=${(p.models ?? []).join(',') || '-'}`,
      );
    }
    return;
  }
  fail('usage: ./mesh peers approve|revoke|list|status');
}

// ------------------------------------------------------------------ talking to a running node
async function endpoint(a: Args): Promise<{ url: string; token: string; admin: string }> {
  if (a.get('url')) return { url: a.get('url')!.replace(/\/$/, ''), token: a.get('token') ?? '', admin: a.get('token') ?? '' };
  const dir = dataDir(a);
  const raw = (await readJsonIfExists(join(dir, FILES.config))) as NodeConfigInput | undefined;
  if (!raw) fail(`no node at ${dir}`);
  const cfg = NodeConfigSchema.parse(raw);
  const host = cfg.http.host === '0.0.0.0' || cfg.http.host === '::' ? '127.0.0.1' : cfg.http.host;
  // Nodes of a generated docker cluster are reached through their published host port.
  let port = a.get('port') ?? String(cfg.http.port);
  const cluster = (await readJsonIfExists(join(dir, '..', 'cluster.json'))) as { mode?: string; nodes?: Array<{ dir: string; httpPort: number }> } | undefined;
  const me = cluster?.mode === 'docker' ? cluster.nodes?.find((n) => resolve(n.dir) === resolve(dir)) : undefined;
  if (me && !a.get('port')) port = String(me.httpPort);
  const s = await loadSecrets(dir);
  return { url: `http://${host}:${port}`, token: s.clientTokens[0]!, admin: s.adminToken };
}

async function adminGet(a: Args, path: string): Promise<unknown> {
  const e = await endpoint(a);
  const r = await fetch(e.url + path, { headers: { authorization: `Bearer ${e.admin}` } }).catch((err) => fail(`cannot reach ${e.url}: ${err.message}`));
  if (!r.ok) fail(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function status(a: Args): Promise<void> {
  const s = (await adminGet(a, '/admin/status')) as Record<string, any>;
  const e = await endpoint(a);
  const ready = await fetch(e.url + '/health/ready').then((r) => r.json());
  out(JSON.stringify({ ...s, readiness: ready }, null, 2));
}

async function uiUrl(a: Args): Promise<void> {
  const e = await endpoint(a);
  out(`${e.url}/#gateway=${encodeURIComponent(e.url)}&token=${encodeURIComponent(e.token)}&admin=${encodeURIComponent(e.admin)}`);
  out('\nThe fragment (#...) is never sent to the server; the UI stores it in this browser and removes it from the address bar.');
}

async function chat(a: Args): Promise<void> {
  const prompt = a._.slice(1).join(' ');
  if (!prompt) fail('usage: ./mesh chat "your question"');
  const e = await endpoint(a);
  const stream = !a.has('no-stream');
  const target = a.get('target');
  const body = { messages: [{ role: 'user', content: prompt }], stream, max_tokens: a.int('max-tokens', 128), ...(target ? { mesh: { target } } : {}) };
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${e.token}` };
  if (a.get('prefer')) headers['x-mesh-prefer'] = a.get('prefer')!;
  const t0 = performance.now();
  const r = await fetch(`${e.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }).catch((err) => fail(`cannot reach ${e.url}: ${err.message}`));
  if (!r.ok) {
    out(`HTTP ${r.status}: ${await r.text()}`);
    process.exitCode = 1;
    return;
  }
  if (!stream) {
    const j = (await r.json()) as any;
    out(j.choices[0].message.content);
    out(`\n[worker ${j.mesh.workerPeerId} via ${j.mesh.route}; runtime ${j.mesh.runtime}; attempts ${j.mesh.attempts.map((x: any) => `${x.workerPeerId.slice(-6)}:${x.outcome}`).join(', ')}; ${Math.round(performance.now() - t0)} ms]`);
    return;
  }
  out(`[worker ${r.headers.get('x-mesh-worker')} route=${r.headers.get('x-mesh-route')} runtime=${r.headers.get('x-mesh-runtime')}]`);
  let done = false;
  let firstAt = 0;
  let tokens = 0;
  let final: any = null;
  const p = new SseParser((ev) => {
    if (ev.data === '[DONE]') {
      done = true;
      return;
    }
    const j = JSON.parse(ev.data);
    if (j.error) {
      process.stdout.write(`\n\n[${j.error.code}] ${j.error.message}\n`);
      return;
    }
    const t = j.choices?.[0]?.delta?.content;
    if (t) {
      if (!firstAt) firstAt = performance.now();
      tokens++;
      process.stdout.write(t);
    }
    if (j.choices?.[0]?.finish_reason) final = j;
  });
  const dec = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) p.push(dec.decode(chunk, { stream: true }));
  if (!done) {
    out('\n\n[INTERRUPTED: stream ended without a completion marker; partial text above. Retry to generate a new answer.]');
    process.exitCode = 2;
    return;
  }
  out(`\n\n[${final?.choices?.[0]?.finish_reason}; ttft ${Math.round(firstAt - t0)} ms; ${tokens} chunks; total ${Math.round(performance.now() - t0)} ms; attempts ${final?.mesh?.attempts?.map((x: any) => `${x.workerPeerId.slice(-6)}:${x.outcome}`).join(', ')}]`);
}

// ------------------------------------------------------------------ start / stop
async function start(a: Args): Promise<void> {
  const dir = dataDir(a);
  await loadConfig(dir); // validate early with a clear error
  const main = join(REPO_ROOT, 'apps/node/dist/main.js');
  if (!a.has('detach')) {
    const child = spawn(process.execPath, [main, '--data', dir], { stdio: 'inherit' });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const pidFile = join(dir, 'node.pid');
  if (await exists(pidFile)) {
    const pid = Number(await readFile(pidFile, 'utf8'));
    if (isAlive(pid)) fail(`already running (pid ${pid})`);
  }
  const log = openSync(join(dir, 'node.log'), 'a', 0o600);
  const child = spawn(process.execPath, [main, '--data', dir], { stdio: ['ignore', log, log], detached: true, env: process.env });
  closeSync(log);
  child.unref();
  await writeFile(pidFile, String(child.pid), { mode: 0o600 });
  out(`started pid ${child.pid}; log: ${join(dir, 'node.log')}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop(a: Args): Promise<void> {
  const dir = dataDir(a);
  const pidFile = join(dir, 'node.pid');
  if (!(await exists(pidFile))) fail(`no pid file in ${dir} (was it started with --detach?)`);
  const pid = Number(await readFile(pidFile, 'utf8'));
  if (!isAlive(pid)) {
    await unlink(pidFile);
    out('not running');
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 30_000;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid)) fail(`pid ${pid} still running after 30 s`);
  await unlink(pidFile).catch(() => undefined);
  out(`stopped pid ${pid} (data kept in ${dir})`);
}

async function reset(a: Args): Promise<void> {
  const dir = a.get('data') ? resolve(a.get('data')!) : fail('--data DIR is required for reset');
  if (!a.has('yes')) fail(`this permanently deletes the identity and state in ${dir}; re-run with --yes`);
  if (await exists(join(dir, 'node.pid'))) {
    const pid = Number(await readFile(join(dir, 'node.pid'), 'utf8'));
    if (isAlive(pid)) fail('node is running; stop it first');
  }
  if (!(await exists(join(dir, FILES.config))) && !(await exists(join(dir, 'cluster.json')))) fail(`${dir} does not look like a node or cluster directory`);
  await rm(dir, { recursive: true, force: true });
  out(`deleted ${dir}`);
}

// ------------------------------------------------------------------ cluster
async function clusterCmd(a: Args): Promise<void> {
  const sub = a._[1];
  if (sub === 'generate') {
    const n = a.int('nodes', 3);
    const mode = (a.get('mode') ?? 'docker') as 'docker' | 'native';
    const outDir = a.get('out') ?? join(REPO_ROOT, 'deploy/generated', `cluster-${n}${a.has('fake') ? '-fake' : ''}${mode === 'native' ? '-native' : ''}`);
    const nodes = await generateCluster({
      nodes: n,
      mode,
      out: outDir,
      networkId: a.get('network') ?? `local-${n}`,
      fake: a.has('fake'),
      modelsDir: modelsDir(a),
      threads: a.int('threads', 2),
      basePort: mode === 'docker' ? 8080 : a.int('base-port', 18100),
      image: a.get('image') ?? `werewolf-mesh/node:${SOFTWARE_VERSION}`,
      cpus: a.int('cpus', 2),
      memLimit: a.get('mem') ?? '3g',
      ...(a.get('models') ? { models: a.get('models')!.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    });
    out(`generated ${nodes.length} nodes in ${resolve(outDir)} (${mode}${a.has('fake') ? ', FAKE runtime for fault tests' : ''})`);
    for (const x of nodes) out(`  ${x.name}  ${x.peerId}  http://127.0.0.1:${x.httpPort}`);
    out(mode === 'docker' ? `\nstart: ./mesh cluster up --dir ${outDir}` : `\nstart: ./mesh cluster start --dir ${outDir}`);
    return;
  }
  const dir = resolve(a.get('dir') ?? fail('--dir is required'));
  const cluster = JSON.parse(await readFile(join(dir, 'cluster.json'), 'utf8')) as { mode: string; fake: boolean; nodes: Array<{ name: string; dir: string }> };
  if (['up', 'down', 'ps', 'logs'].includes(sub ?? '')) {
    if (cluster.mode !== 'docker') fail('this is a native cluster; use cluster start|stop');
    const args = ['compose', '-f', join(dir, 'compose.yaml'), sub!];
    if (sub === 'up') args.push('-d');
    if (sub === 'logs') args.push('--tail', '200', ...a._.slice(2));
    const r = spawnSync('docker', args, { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
    return;
  }
  if (sub === 'start' || sub === 'stop') {
    if (cluster.mode !== 'native') fail('this is a docker cluster; use cluster up|down');
    for (const n of cluster.nodes) {
      const sa = parseArgs(['--data', n.dir, ...(sub === 'start' ? ['--detach'] : [])], ['detach']);
      if (cluster.fake) process.env.MESH_ALLOW_FAKE_RUNTIME = '1';
      out(`${n.name}:`);
      await (sub === 'start' ? start(sa) : stop(sa)).catch((e) => out(`  ${(e as Error).message}`));
    }
    return;
  }
  fail('usage: ./mesh cluster generate|up|down|ps|logs|start|stop');
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2), ['detach', 'relay-server', 'no-relays', 'docker', 'fake', 'yes', 'no-stream', 'scorer']);
  const cmd = a._[0];
  switch (cmd) {
    case 'doctor':
      return doctor(a);
    case 'runtime':
      if (a._[1] !== 'install') fail('usage: ./mesh runtime install');
      return runtimeInstall();
    case 'model':
      return modelCmd(a);
    case 'models':
      return modelsCmd(a);
    case 'gpu':
      return gpuCmd(a);
    case 'init':
      return init(a);
    case 'join-info': {
      const info = await joinInfo(dataDir(a));
      const txt = JSON.stringify(info, null, 2) + '\n';
      if (a.get('out')) {
        await writeFile(a.get('out')!, txt, { mode: 0o644 });
        out(`wrote ${a.get('out')} (public information only)`);
      } else process.stdout.write(txt);
      return;
    }
    case 'peers':
      return peersCmd(a);
    case 'start':
      return start(a);
    case 'stop':
      return stop(a);
    case 'status':
      return status(a);
    case 'ui-url':
      return uiUrl(a);
    case 'chat':
      return chat(a);
    case 'reset':
      return reset(a);
    case 'cluster':
      return clusterCmd(a);
    case 'demo': {
      const { demoFailover } = await import('./demo.js');
      if (a._[1] !== 'failover') fail('usage: ./mesh demo failover --dir DIR');
      return demoFailover(resolve(a.get('dir') ?? fail('--dir is required')));
    }
    case undefined:
    case 'help':
    case '--help':
      out(HELP);
      return;
    default:
      fail(`unknown command "${cmd}". Run ./mesh help`);
  }
}

main().catch((err) => fail((err as Error).message));
