import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FARM_LIMITS, FarmSource, type FarmSource as Source } from '@werewolf-mesh/protocol';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const excluded = /^(?:\.git|\.env(?:\..*)?|\.aws|\.ssh|\.codex|\.claude|\.psm|\.psm-.*|node_modules|dist|build|coverage|\.cache|.*\.(?:pem|key|p12|pfx)|(?:credentials|secrets|identity|session).*|AGENTS\.md)$/i;
export function sourceExclusion(path: string): boolean { return path.split('/').some((part) => excluded.test(part)); }
/** Canonical content digest is independent of JSON formatting and file order. */
export function sourceDigest(source: Source): string {
  const hash = createHash('sha256');
  for (const file of [...source.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(`${file.path}\0${file.sha256}\0`);
  }
  return hash.digest('hex');
}
export function validateSource(raw: unknown, expected?: string, checkExclusions = true): Source {
  const source = FarmSource.parse(raw);
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of source.files) {
    if (checkExclusions && sourceExclusion(file.path)) throw new Error(`excluded source path: ${file.path}`);
    if (paths.has(file.path)) throw new Error('duplicate source path');
    paths.add(file.path);
    const data = Buffer.from(file.data, 'base64');
    if (data.toString('base64') !== file.data || data.length > FARM_LIMITS.fileBytes) throw new Error('invalid source encoding or size');
    bytes += data.length;
    if (bytes > FARM_LIMITS.sourceBytes) throw new Error('source exceeds byte limit');
    if (sha256(data) !== file.sha256) throw new Error('source file digest mismatch');
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw new Error('file/directory source conflict');
  }
  if (expected !== undefined && sourceDigest(source) !== expected) throw new Error('source snapshot digest mismatch');
  return source;
}

/** Operator-side packaging: never follow symlinks or include dependencies/secrets. */
export async function packageSource(root: string): Promise<Source> {
  const source: Source = { files: [] };
  let bytes = 0;
  const visit = async (relative: string) => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (sourceExclusion(path)) continue;
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) throw new Error(`source contains symlink: ${path}`);
      if (stat.isDirectory()) { await visit(path); continue; }
      if (!stat.isFile()) throw new Error(`source contains special file: ${path}`);
      if (stat.size > FARM_LIMITS.fileBytes || bytes + stat.size > FARM_LIMITS.sourceBytes || source.files.length >= FARM_LIMITS.files) throw new Error('source exceeds transfer limits');
      const data = await readFile(join(root, path)); bytes += data.length;
      source.files.push({ path, data: data.toString('base64'), sha256: sha256(data) });
    }
  };
  await visit('');
  return validateSource(source);
}
