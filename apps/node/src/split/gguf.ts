/**
 * Minimal GGUF header reader: just enough metadata to plan a split (the
 * number of transformer blocks). Reads the key/value section incrementally
 * and stops at the key it needs; tensor data is never read.
 */
import { open } from 'node:fs/promises';

const TYPE_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

export async function ggufBlockCount(path: string): Promise<number | null> {
  const fh = await open(path, 'r');
  let pos = 0;
  let buf = Buffer.alloc(0);
  let bufStart = 0;
  const need = async (n: number) => {
    if (pos + n <= bufStart + buf.length) return;
    const size = Math.max(n, 1 << 20);
    const b = Buffer.alloc(size);
    const { bytesRead } = await fh.read(b, 0, size, pos);
    if (bytesRead < n) throw new Error('truncated GGUF header');
    buf = b.subarray(0, bytesRead);
    bufStart = pos;
  };
  const u32 = async () => (await need(4), (pos += 4), buf.readUInt32LE(pos - 4 - bufStart));
  const u64 = async () => (await need(8), (pos += 8), Number(buf.readBigUInt64LE(pos - 8 - bufStart)));
  const str = async () => {
    const n = await u64();
    if (n > 1 << 24) throw new Error('bad GGUF string');
    await need(n);
    pos += n;
    return buf.toString('utf8', pos - n - bufStart, pos - bufStart);
  };
  const skip = async (type: number): Promise<void> => {
    if (type === 8) return void (await str());
    if (type === 9) {
      const t = await u32();
      const n = await u64();
      if (TYPE_SIZE[t] !== undefined) {
        pos += n * TYPE_SIZE[t]!;
        return;
      }
      for (let i = 0; i < n; i++) await skip(t);
      return;
    }
    const s = TYPE_SIZE[type];
    if (s === undefined) throw new Error(`unknown GGUF type ${type}`);
    pos += s;
  };
  try {
    await need(4);
    if (buf.toString('ascii', 0, 4) !== 'GGUF') return null;
    pos = 4;
    const version = await u32();
    if (version < 2) return null;
    await u64(); // tensor count
    const kvCount = await u64();
    for (let i = 0; i < kvCount; i++) {
      const key = await str();
      const type = await u32();
      if (key.endsWith('.block_count') && (type === 4 || type === 5 || type === 10)) {
        return type === 10 ? await u64() : await u32();
      }
      await skip(type);
    }
    return null;
  } finally {
    await fh.close();
  }
}
