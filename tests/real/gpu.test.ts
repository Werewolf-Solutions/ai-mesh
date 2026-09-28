/** REAL GPU test: runs only on machines with an NVIDIA GPU and the pinned CUDA build installed. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, makeCluster, ROOT, startNode, waitFor, type TestCluster, type TestNode } from '../harness.js';

const hasNvidia = (() => {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const ready = hasNvidia && existsSync(join(ROOT, '.cache/runtime/cuda/llama-b11223/llama-server')) && existsSync(join(ROOT, 'models/Qwen3.5-0.8B-Q8_0.gguf'));

describe.skipIf(!ready)('GPU (CUDA)', () => {
  let c: TestCluster;
  let n: TestNode;
  beforeAll(async () => {
    c = await makeCluster({ nodes: 2, fake: false, patch: () => ({ runtime: { gpu: 'cuda' }, model: { host: ['qwen3.5-0.8b-q8_0'] } }) });
    n = c.nodes[0]!;
    await startNode(n);
  });
  afterAll(async () => {
    await c?.cleanup();
  });

  it('runs the model on the GPU and is much faster than the CPU baseline', async () => {
    const rt = await admin(n, '/admin/runtime');
    expect(rt.accel).toBe('cuda');
    await waitFor(async () => (await admin(n, '/admin/status')).models.every((m: any) => m.state === 'serving'), 60_000, 'serving');
    const r = await (
      await fetch(`${n.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3.5-0.8b-q8_0', reasoning_effort: 'none', max_tokens: 128, temperature: 0, messages: [{ role: 'user', content: 'Write five sentences about wolves.' }] }),
      })
    ).json();
    const tokPerS = r.usage.completion_tokens / ((r.mesh.timings.totalMs - r.mesh.timings.firstTokenMs) / 1000);
    expect(tokPerS).toBeGreaterThan(60); // CPU (4 threads) measured 26 tok/s for this model
    const apps = execFileSync('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader'], { encoding: 'utf8' });
    expect(apps.trim().length).toBeGreaterThan(0);
  });
});
