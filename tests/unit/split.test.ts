/** Splitting: the placement plan, the GGUF header reader, and the byte tunnel's accept marker. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ggufBlockCount } from '../../apps/node/src/split/gguf.js';
import { planSplit } from '../../apps/node/src/split/plan.js';
import { ROOT } from '../harness.js';

describe('split plan: fill this node first', () => {
  it('does not split a model that fits on the local GPU', () => {
    const p = planSplit({ accel: 'cuda', freeLocalMB: 11_000, modelMB: 6_000, blocks: 36, lenders: 1 });
    expect(p.use).toBe(false);
    expect(p.note).toMatch(/fits/);
  });

  it('puts what fits on the GPU and only the rest on lenders (lenders listed first)', () => {
    const p = planSplit({ accel: 'cuda', freeLocalMB: 5_512, modelMB: 10_000, blocks: 48, lenders: 2 });
    expect(p.use).toBe(true);
    expect(p.gpuLayers).toBe(999);
    expect(p.tensorSplit).toEqual([0.25, 0.25, 0.5]); // lender, lender, local GPU
    expect(p.note).toBe('50% on this GPU, 50% on 2 other nodes');
  });

  it('honours an explicit local share even when the model would fit', () => {
    const p = planSplit({ accel: 'cuda', freeLocalMB: 11_000, modelMB: 6_000, blocks: 36, lenders: 1, localShare: 0.8 });
    expect(p.tensorSplit).toEqual([0.2, 0.8]);
  });

  it('on a CPU node offloads whole layers to the lenders', () => {
    const p = planSplit({ accel: 'cpu', freeLocalMB: 5_536, modelMB: 8_000, blocks: 36, lenders: 1 });
    expect(p.use).toBe(true);
    expect(p.gpuLayers).toBe(18); // half the layers go to the lender
    expect(p.tensorSplit).toBeUndefined();
    expect(p.note).toBe('18 of 36 layers here, 18 on 1 other node');
    const two = planSplit({ accel: 'cpu', freeLocalMB: 1_000, modelMB: 8_000, blocks: 36, lenders: 2 });
    expect(two.gpuLayers).toBe(36);
    expect(two.tensorSplit).toEqual([1, 1]);
  });

  it('with no lenders there is nothing to split', () => {
    expect(planSplit({ accel: 'cuda', freeLocalMB: 100, modelMB: 6_000, blocks: 36, lenders: 0 }).use).toBe(false);
  });
});

describe('GGUF header', () => {
  const f = join(ROOT, 'models', 'SmolLM2-135M-Instruct-Q4_K_M.gguf');
  it.skipIf(!existsSync(f))('reads the number of blocks without reading the weights', async () => {
    expect(await ggufBlockCount(f)).toBe(30);
  });
  it('returns null for a file that is not GGUF', async () => {
    expect(await ggufBlockCount(join(ROOT, 'package.json'))).toBeNull();
  });
});
