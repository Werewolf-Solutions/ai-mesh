import { spawn } from 'node:child_process';
import { FarmResult, type FarmPackage, type FarmResult as Result } from '@werewolf-mesh/protocol';

// No host source mount: the package arrives on stdin and is materialized in a
// size-limited tmpfs. Image contract: Node + /bin/sh; dependencies preinstalled.
const BOOTSTRAP = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; if (input.length > 8*1024*1024) process.exit(2); });
process.stdin.on('end', () => {
  const {spec, source} = JSON.parse(input), started = Date.now();
  process.chdir('/work');
  for (const file of source.files) {
    fs.mkdirSync(path.dirname(file.path), {recursive:true});
    fs.writeFileSync(file.path, Buffer.from(file.data, 'base64'), {mode:0o600, flag:'wx'});
  }
  let budget = spec.limits.outputBytes, truncated = false, timedOut = false;
  const keep = data => {
    const b = Buffer.from(data || ''), n = Math.min(b.length, budget);
    budget -= n; if(n < b.length) truncated = true;
    return b.subarray(0,n).toString('utf8').replace(/\uFFFD$/, '');
  };
  const steps = [];
  for (const step of spec.steps) {
    const remaining = spec.limits.timeoutMs - (Date.now()-started);
    if (remaining <= 0) { timedOut = true; break; }
    const r = cp.spawnSync('/bin/sh', ['-c', step.command], {
      cwd:'/work', env:{PATH:process.env.PATH, HOME:'/tmp', CI:'true', TMPDIR:'/tmp'},
      timeout:remaining, killSignal:'SIGKILL', maxBuffer:spec.limits.outputBytes
    });
    if (r.error && r.error.code === 'ETIMEDOUT') timedOut = true;
    if (r.error && r.error.code === 'ENOBUFS') truncated = true;
    steps.push({name:step.name, exitCode:r.status, stdout:keep(r.stdout), stderr:keep(r.stderr)});
    if (r.status !== 0 || r.error) break;
  }
  const artifacts = []; let artifactBytes = 0;
  for (const output of spec.outputs) {
    const components = output.split('/');
    for(let i=1; i<=components.length; i++) if(fs.lstatSync(components.slice(0,i).join('/')).isSymbolicLink()) throw new Error('artifact symlink refused');
    const info = fs.lstatSync(output);
    if(!info.isFile() || info.size > 1024*1024 || artifactBytes + info.size > 1024*1024) throw new Error('artifact size/type limit');
    const data = fs.readFileSync(output); artifactBytes += data.length;
    if(artifactBytes > 1024*1024) throw new Error('artifact byte limit');
    artifacts.push({path:output,data:data.toString('base64'),sha256:crypto.createHash('sha256').update(data).digest('hex')});
  }
  process.stdout.write(JSON.stringify({jobId:spec.jobId,attemptId:spec.attemptId,fence:spec.fence,
    sourceDigest:spec.source.digest,image:spec.image,steps,truncated,timedOut,artifacts,durationMs:Date.now()-started}));
});`;

export function farmSandboxArgs(name: string, pkg: FarmPackage, label: string): string[] {
  const l = pkg.spec.limits;
  return ['run', '--rm', '-i', '--name', name, '--label', `werewolf.farm=${label}`,
    '--pull', 'never', '--network', 'none', '--read-only', '--log-driver', 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
    '--memory', `${l.memoryMb}m`, '--memory-swap', `${l.memoryMb}m`, '--cpus', String(l.cpus),
    '--pids-limit', '64', '--ulimit', 'nofile=256:256',
    '--tmpfs', `/work:rw,nosuid,nodev,size=${l.diskMb}m,mode=1777`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
    '--workdir', '/work', '--entrypoint', 'node', pkg.spec.image, '-e', BOOTSTRAP];
}

export async function dockerCommand(args: string[], timeoutMs = 10000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout = (stdout + d.toString()).slice(0, 131072); });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(0, 2048); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function runFarmSandbox(pkg: FarmPackage, label: string, name: string, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) throw new Error('cancelled');
  const image = await dockerCommand(['image', 'inspect', pkg.spec.image, '--format', '{{.Architecture}}']);
  const arch = pkg.spec.architecture === 'x64' ? 'amd64' : 'arm64';
  if (image.code !== 0 || image.stdout.trim() !== arch) throw new Error('pinned sandbox image unavailable or incompatible');
  if (signal.aborted) throw new Error('cancelled');
  let killPromise: Promise<unknown> | undefined;
  const child = spawn('docker', farmSandboxArgs(name, pkg, label), { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let count = 0, errorText = '', overflow = false;
  const kill = () => {
    killPromise ??= dockerCommand(['rm', '-f', name]).catch(() => undefined);
    child.kill('SIGKILL');
  };
  child.stdout.on('data', (d: Buffer) => {
    count += d.length;
    if (count > pkg.spec.limits.outputBytes * 8 + 2 * 1024 * 1024) { overflow = true; kill(); }
    else chunks.push(d);
  });
  child.stderr.on('data', (d: Buffer) => { errorText = (errorText + d.toString()).slice(0, 1000); });
  child.stdin.on('error', () => {});
  const timeout = setTimeout(kill, pkg.spec.limits.timeoutMs + 5000);
  signal.addEventListener('abort', kill, { once: true });
  // Cancellation may arrive between the check above and registration.
  if (signal.aborted) kill();
  child.stdin.end(JSON.stringify(pkg));
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (signal.aborted) throw new Error('cancelled');
    if (overflow) throw new Error('sandbox output exceeded limit');
    if (code !== 0) throw new Error(`sandbox failed (${code}): ${errorText.slice(0, 300)}`);
    const result = FarmResult.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (result.jobId !== pkg.spec.jobId || result.attemptId !== pkg.spec.attemptId || result.fence !== pkg.spec.fence || result.sourceDigest !== pkg.spec.source.digest || result.image !== pkg.spec.image) throw new Error('sandbox result binding mismatch');
    return result;
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', kill);
    await killPromise;
    // --rm is not enough when the Docker client dies before container creation.
    const cleanup = await dockerCommand(['rm', '-f', name]);
    if (cleanup.code !== 0 && !/No such container/.test(cleanup.stderr)) throw new Error('sandbox cleanup failed');
  }
}

export async function farmImageAvailable(image: string, architecture: string): Promise<boolean> {
  const result = await dockerCommand(['image', 'inspect', image, '--format', '{{.Architecture}}']);
  return result.code === 0 && result.stdout.trim() === (architecture === 'x64' ? 'amd64' : architecture);
}

export async function cleanupFarmContainers(label: string): Promise<void> {
  const list = await dockerCommand(['ps', '-aq', '--filter', `label=werewolf.farm=${label}`]);
  if (list.code !== 0) throw new Error('cannot inspect farm containers');
  const ids = list.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) {
    const result = await dockerCommand(['rm', '-f', ...ids]);
    if (result.code !== 0) throw new Error('cannot clean up farm containers');
  }
}
