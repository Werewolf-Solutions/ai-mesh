/**
 * GPU detection and the pinned GPU builds of llama.cpp (models/runtime.json →
 * gpuBinaries). Everything here is local to this machine: peers never learn
 * more than the node's own "accel" hint, and routing trusts measured speed.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { downloadVerified, sha256File, type RuntimePin } from '../model.js';
import { exists } from '../util/fs.js';
import { REPO_ROOT } from '../version.js';

const run = promisify(execFile);

export type GpuBackend = 'cuda' | 'vulkan';
export type Accel = 'cpu' | GpuBackend;

export interface GpuInfo {
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  name: string;
  vramMB: number | null;
  freeMB: number | null;
  /** Backends that can drive this GPU. */
  backends: GpuBackend[];
}

/** Find GPUs. NVIDIA details come from nvidia-smi; AMD/Intel are detected from the kernel (Vulkan only). */
export async function detectGpus(): Promise<GpuInfo[]> {
  const out: GpuInfo[] = [];
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout: 5000 });
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, total, free] = line.split(',').map((x) => x.trim());
      out.push({ vendor: 'nvidia', name: name ?? 'NVIDIA GPU', vramMB: Number(total) || null, freeMB: Number(free) || null, backends: ['cuda', 'vulkan'] });
    }
  } catch {
    /* no NVIDIA driver */
  }
  try {
    const cards = (await readdir('/sys/class/drm')).filter((d) => /^card\d+$/.test(d));
    for (const c of cards) {
      const vendor = await import('node:fs/promises').then((fs) => fs.readFile(`/sys/class/drm/${c}/device/vendor`, 'utf8')).catch(() => '');
      const v = vendor.trim();
      if (v === '0x1002') out.push({ vendor: 'amd', name: 'AMD GPU', vramMB: null, freeMB: null, backends: ['vulkan'] });
      else if (v === '0x8086') out.push({ vendor: 'intel', name: 'Intel GPU', vramMB: null, freeMB: null, backends: ['vulkan'] });
    }
  } catch {
    /* not Linux or no DRM */
  }
  return out;
}

const pinKey = (b: GpuBackend) => `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}-${b}`;

/** Where the pinned GPU build lives once installed. */
export function gpuBinaryPath(pin: RuntimePin, backend: GpuBackend): string | null {
  const g = (pin as unknown as { gpuBinaries?: Record<string, { dir: string }> }).gpuBinaries?.[pinKey(backend)];
  if (!g) return null;
  return join(REPO_ROOT, '.cache/runtime', backend, g.dir, 'llama-server');
}

export function gpuBuildInstalled(pin: RuntimePin, backend: GpuBackend): boolean {
  const p = gpuBinaryPath(pin, backend);
  return !!p && existsSync(p);
}

/** Download (SHA-256 verified) and unpack the pinned GPU build. CUDA's runtime libraries are placed next to the binary. */
export async function installGpuBuild(pin: RuntimePin, backend: GpuBackend, onProgress?: (done: number, total: number | null) => void, signal?: AbortSignal): Promise<string> {
  const g = (pin as unknown as { gpuBinaries?: Record<string, { url: string; sha256: string; dir: string; extra?: Array<{ url: string; sha256: string; dir: string }> }> }).gpuBinaries?.[pinKey(backend)];
  if (!g) throw new Error(`no pinned ${backend} build for ${process.platform}-${process.arch}`);
  const root = join(REPO_ROOT, '.cache/runtime', backend);
  await mkdir(root, { recursive: true });
  for (const part of [{ url: g.url, sha256: g.sha256, dir: g.dir }, ...(g.extra ?? [])]) {
    const tarball = join(REPO_ROOT, '.cache/runtime', basename(new URL(part.url).pathname));
    if (!(await exists(tarball)) || (await sha256File(tarball)) !== part.sha256) {
      await downloadVerified(part.url, tarball, { sha256: part.sha256 }, onProgress, signal);
    }
    const r = spawnSync('tar', ['xzf', tarball, '-C', root]);
    if (r.status !== 0) throw new Error(`could not unpack ${basename(tarball)}`);
    if (part.dir !== g.dir) {
      // CUDA runtime libraries: put them where the binary's loader finds them.
      for (const f of await readdir(join(root, part.dir))) await copyFile(join(root, part.dir, f), join(root, g.dir, f));
    }
  }
  const bin = join(root, g.dir, 'llama-server');
  if (!existsSync(bin)) throw new Error('GPU build unpacked but llama-server is missing');
  return bin;
}

/** Rough VRAM need for a model fully on the GPU: weights + KV cache and buffers for its context. */
export function estimateVramMB(fileBytes: number, contextTokens: number): number {
  return Math.round((fileBytes / 2 ** 20) * 1.05 + (contextTokens / 8192) * 900);
}
