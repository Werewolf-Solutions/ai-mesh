import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Atomically replace `path` with `data`: write a temp file in the same
 * directory, fsync it, then rename over the target. The file is created with
 * `mode` (default 0600, owner read/write only).
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value, null, 2) + '\n', mode);
}

export async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Warn-level check: returns a description if the file is readable by group/others. */
export async function looseModeWarning(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if ((s.mode & 0o077) !== 0) return `${path} has permissions ${(s.mode & 0o777).toString(8)}; expected 600`;
  } catch {
    /* ignore */
  }
  return null;
}
