/**
 * Model manifest, artifact verification, download and import.
 *
 * The model is fetched once into a persistent directory and verified by
 * SHA-256 before every load. Nothing here downloads from peers.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9._-]+$/),
  displayName: z.string(),
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
  serving: z.object({ contextTokens: z.number().int(), maxOutputTokens: z.number().int() }),
  runtime: z
    .object({
      engine: z.literal('llama.cpp'),
      release: z.string(),
      buildInfo: z.string(),
      image: z.string(),
      binaries: z.record(z.string(), z.object({ url: z.string().url(), sha256: Hex64, dir: z.string(), tested: z.boolean() })),
    })
    .passthrough(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export async function loadManifest(path: string): Promise<Manifest> {
  return ManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

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
export async function downloadVerified(
  url: string,
  dest: string,
  expect: { sha256: string; sizeBytes?: number },
  onProgress?: (done: number, total: number | null) => void,
): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true });
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || expect.sizeBytes || null;
  const hash = createHash('sha256');
  let done = 0;
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
  await pipeline(body, createWriteStream(part, { mode: 0o644 }));
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
