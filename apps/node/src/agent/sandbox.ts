/**
 * run_python (docs/agents-design.md, "Capability limits"): runs a program in a
 * throw-away Docker container with no network, a read-only filesystem, capped
 * memory, CPU, processes and open files, no capabilities, as user "nobody".
 *
 * The program arrives on stdin, so nothing on the host is mounted. The image
 * is pinned by digest and never pulled here (`./mesh code setup` pulls it), so
 * a run can never fetch anything.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface SandboxOptions {
  image: string;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  /** Bytes of stdout and of stderr kept; the rest is dropped. */
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface SandboxResult {
  /** Exit code of the program; null if it never ran (see `error`). */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  ms: number;
  /** The sandbox itself failed (Docker missing, image not installed, …). */
  error?: string;
}

export class SandboxUnavailable extends Error {}

/** The `docker run` arguments. Exported so tests can check every restriction is there. */
export function sandboxArgs(name: string, o: Pick<SandboxOptions, 'image' | 'timeoutMs' | 'memoryMb' | 'cpus'>): string[] {
  const seconds = Math.max(1, Math.ceil(o.timeoutMs / 1000));
  return [
    'run', '--rm', '-i', '--name', name,
    '--pull', 'never',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--memory', `${o.memoryMb}m`, '--memory-swap', `${o.memoryMb}m`,
    '--cpus', String(o.cpus),
    '--pids-limit', '64',
    '--ulimit', 'nofile=64:64',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65534:65534',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    '-e', 'PYTHONUNBUFFERED=1',
    o.image,
    // TERM at the limit, KILL one second later if the program ignores TERM.
    'timeout', '-k', '1', String(seconds), 'python', '-I', '-',
  ];
}

export async function runPython(program: string, o: SandboxOptions): Promise<SandboxResult> {
  const name = `werewolf-py-${randomBytes(6).toString('hex')}`;
  const t0 = Date.now();
  const child = spawn('docker', sandboxArgs(name, o), { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const keep = (k: 'stdout' | 'stderr') => (d: Buffer) => {
    if (out[k].length < o.maxOutputBytes) out[k] = Buffer.concat([out[k], d.subarray(0, o.maxOutputBytes - out[k].length)]);
  };
  child.stdout.on('data', keep('stdout'));
  child.stderr.on('data', keep('stderr'));
  child.stdin.on('error', () => {}); // the container may exit before reading everything
  child.stdin.end(program);

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => {});
    child.kill('SIGKILL');
  };
  // Backstop in case Docker itself hangs; the in-container `timeout` normally ends the run first.
  const backstop = setTimeout(kill, o.timeoutMs + 15_000);
  const onAbort = () => kill();
  o.signal?.addEventListener('abort', onAbort, { once: true });

  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(backstop);
  o.signal?.removeEventListener('abort', onAbort);

  const stdout = out.stdout.toString('utf8');
  const stderr = out.stderr.toString('utf8');
  const ms = Date.now() - t0;
  if (code === null && !killed) return { exitCode: null, timedOut: false, stdout, stderr, ms, error: 'docker is not available on this computer' };
  // `docker run` itself failing (exit 125) or the image missing: not the program's fault.
  if (code === 125 || /Unable to find image|No such image|pull access denied/i.test(stderr)) {
    const missing = /Unable to find image|No such image/i.test(stderr);
    return { exitCode: null, timedOut: false, stdout, stderr, ms, error: missing ? 'the Python sandbox is not installed (run: ./mesh code setup)' : `the sandbox failed to start: ${stderr.trim().split('\n').at(-1)?.slice(0, 200)}` };
  }
  // 124: `timeout` stopped it; 137 after a timeout-length run: KILLed after ignoring TERM.
  const timedOut = killed || code === 124 || (code === 137 && ms >= o.timeoutMs);
  return { exitCode: code, timedOut, stdout, stderr, ms };
}

/** Is Docker usable and the image installed? */
export function sandboxStatus(image: string): { docker: boolean; image: boolean; detail: string } {
  const v = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (v.status !== 0) return { docker: false, image: false, detail: 'docker is not available' };
  const i = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  return i.status === 0 ? { docker: true, image: true, detail: `ready (docker ${v.stdout.trim()})` } : { docker: true, image: false, detail: 'image not installed (run: ./mesh code setup)' };
}
