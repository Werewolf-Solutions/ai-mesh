/**
 * Model manifest, artifact verification, download and import.
 *
 * The model is fetched once into a persistent directory and verified by
 * SHA-256 before every load. Nothing here downloads from peers.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, open as openFile, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** One entry of the model catalog (models/catalog/<id>.json). */
export const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9._-]+$/),
  displayName: z.string(),
  family: z.string().default(''),
  params: z.string().default(''),
  order: z.number().default(100),
  description: z.string().default(''),
  source: z.object({ repo: z.string(), license: z.string(), attribution: z.string() }).passthrough(),
  artifact: z
    .object({
      filename: z.string().regex(/^[A-Za-z0-9._-]+\.gguf$/),
      url: z.string().url(),
      sizeBytes: z.number().int().positive(),
      sha256: Hex64,
      quantization: z.string(),
    })
    .passthrough(),
  chatTemplate: z.object({ format: z.string() }).passthrough(),
  capabilities: z.object({ thinking: z.enum(['none', 'toggle', 'always']) }).default({ thinking: 'none' }),
  serving: z.object({ contextTokens: z.number().int().min(256).max(65536), maxOutputTokens: z.number().int().min(16).max(16384) }),
  resources: z.object({ ramMB: z.number().int().positive(), tested: z.boolean() }).passthrough().default({ ramMB: 1024, tested: false }),
});
export type Manifest = z.infer<typeof ManifestSchema>;
export type CatalogEntry = Manifest;

/** The pinned llama.cpp build shared by every catalog model (models/runtime.json). */
export const RuntimePinSchema = z
  .object({
    engine: z.literal('llama.cpp'),
    release: z.string(),
    buildInfo: z.string(),
    image: z.string(),
    binaries: z.record(z.string(), z.object({ url: z.string().url(), sha256: Hex64, dir: z.string(), tested: z.boolean() })),
  })
  .passthrough();
export type RuntimePin = z.infer<typeof RuntimePinSchema>;

export async function loadManifest(path: string): Promise<Manifest> {
  return ManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function loadRuntimePin(path: string): Promise<RuntimePin> {
  return RuntimePinSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** All catalog entries, in display order. Invalid files are reported, not silently skipped. */
export async function loadCatalog(dir: string): Promise<CatalogEntry[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: CatalogEntry[] = [];
  for (const f of files) {
    const e = await loadManifest(join(dir, f)).catch((err) => {
      throw new Error(`${join(dir, f)}: ${(err as Error).message}`);
    });
    if (`${e.id}.json` !== f) throw new Error(`${join(dir, f)}: id "${e.id}" must match the file name`);
    out.push(e);
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export const DEFAULT_MODEL_ID = 'smollm2-135m-instruct-q4_k_m';

/**
 * Fingerprint shared on the wire. Peers must advertise an identical
 * fingerprint to exchange jobs; it pins the exact model bytes.
 */
export function modelFingerprint(m: Manifest): string {
  return `${m.id}:sha256:${m.artifact.sha256}`;
}

export function modelPath(m: Manifest, dir: string): string {
  return join(dir, m.artifact.filename);
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export type VerifyResult =
  | { ok: true; path: string; sha256: string; ms: number }
  | { ok: false; path: string; reason: 'absent' | 'size_mismatch' | 'hash_mismatch'; detail: string };

export async function verifyModel(m: Manifest, dir: string): Promise<VerifyResult> {
  const path = modelPath(m, dir);
  const t0 = Date.now();
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { ok: false, path, reason: 'absent', detail: `${path} not found` };
  }
  if (size !== m.artifact.sizeBytes) {
    return { ok: false, path, reason: 'size_mismatch', detail: `size ${size} != manifest ${m.artifact.sizeBytes}` };
  }
  const sha = await sha256File(path);
  if (sha !== m.artifact.sha256) {
    return { ok: false, path, reason: 'hash_mismatch', detail: `sha256 ${sha} != manifest ${m.artifact.sha256}` };
  }
  return { ok: true, path, sha256: sha, ms: Date.now() - t0 };
}

/** Download a URL to `dest` via a .part file, verifying size and SHA-256 before the final rename. */
/**
 * Download a URL to `dest` via `dest.part`, verifying size and SHA-256 before
 * the final rename.
 *  - Resumable: an existing .part file is re-hashed and continued with an HTTP Range request.
 *  - Cancellable with `signal` (the .part file is kept for a later resume).
 *  - A `dest.lock` file (holding the PID) stops two processes sharing a models
 *    directory from writing the same file at once.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expect: { sha256: string; sizeBytes?: number },
  onProgress?: (done: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true });
  const part = `${dest}.part`;
  const lock = `${dest}.lock`;
  const lockFh = await acquireLock(lock);
  try {
    const hash = createHash('sha256');
    let have = 0;
    try {
      const st = await stat(part);
      if (expect.sizeBytes !== undefined && st.size > expect.sizeBytes) throw new Error('oversized partial file');
      await pipeline(createReadStream(part), new (await import('node:stream')).Writable({
        write(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          have += chunk.length;
          cb();
        },
      }));
    } catch {
      await unlink(part).catch(() => undefined);
      have = 0;
    }
    const res = await fetch(url, { redirect: 'follow', signal, headers: have > 0 ? { range: `bytes=${have}-` } : {} });
    if (have > 0 && res.status !== 206) {
      // Server ignored the range: start over.
      await res.body?.cancel().catch(() => undefined);
      await unlink(part).catch(() => undefined);
      return await downloadVerifiedFresh(url, dest, expect, onProgress, signal);
    }
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    const total = expect.sizeBytes ?? (Number(res.headers.get('content-length')) + have || null);
    let done = have;
    let lastReport = 0;
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      done += chunk.length;
      if (onProgress && Date.now() - lastReport > 500) {
        lastReport = Date.now();
        onProgress(done, total);
      }
    });
    await pipeline(body, createWriteStream(part, { mode: 0o644, flags: have > 0 ? 'a' : 'w' }));
    onProgress?.(done, total);
    const sha = hash.digest('hex');
    if (expect.sizeBytes !== undefined && done !== expect.sizeBytes) {
      await unlink(part).catch(() => undefined);
      throw new Error(`size mismatch: got ${done} bytes, expected ${expect.sizeBytes}`);
    }
    if (sha !== expect.sha256) {
      await unlink(part).catch(() => undefined);
      throw new Error(`SHA-256 mismatch: got ${sha}, expected ${expect.sha256}. File discarded.`);
    }
    await rename(part, dest);
  } finally {
    await lockFh.close().catch(() => undefined);
    await unlink(lock).catch(() => undefined);
  }
}

async function downloadVerifiedFresh(
  url: string,
  dest: string,
  expect: { sha256: string; sizeBytes?: number },
  onProgress?: (done: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = expect.sizeBytes ?? (Number(res.headers.get('content-length')) || null);
  const hash = createHash('sha256');
  let done = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    done += chunk.length;
    onProgress?.(done, total);
  });
  await pipeline(body, createWriteStream(part, { mode: 0o644 }));
  if ((expect.sizeBytes !== undefined && done !== expect.sizeBytes) || hash.digest('hex') !== expect.sha256) {
    await unlink(part).catch(() => undefined);
    throw new Error('downloaded file failed verification; discarded');
  }
  await rename(part, dest);
}

async function acquireLock(lock: string) {
  try {
    const fh = await openFile(lock, 'wx', 0o644);
    await fh.writeFile(String(process.pid));
    return fh;
  } catch {
    const pid = Number(await readFile(lock, 'utf8').catch(() => '0'));
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      /* stale lock */
    }
    if (alive) throw new Error(`another process (pid ${pid}) is already downloading this file`);
    await unlink(lock).catch(() => undefined);
    const fh = await openFile(lock, 'wx', 0o644);
    await fh.writeFile(String(process.pid));
    return fh;
  }
}

/** Copy an existing local GGUF into the model directory, then verify it. Never contacts the network. */
export async function importModel(m: Manifest, src: string, dir: string): Promise<VerifyResult> {
  await mkdir(dir, { recursive: true });
  const dest = modelPath(m, dir);
  const srcSha = await sha256File(src);
  if (srcSha !== m.artifact.sha256) {
    return { ok: false, path: src, reason: 'hash_mismatch', detail: `sha256 ${srcSha} != manifest ${m.artifact.sha256}; not imported` };
  }
  const part = `${dest}.part`;
  await copyFile(src, part);
  await chmod(part, 0o644);
  await rename(part, dest);
  return verifyModel(m, dir);
}

export function platformKey(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform;
  return `${os}-${process.arch}`;
}
