/**
 * How much of a split model stays on this node. llama.cpp's default spreads
 * layers by each device's free memory, and a lender reports its whole RAM as
 * free, so a fast local GPU would get too little. The mesh instead fills this
 * node first (GPU memory, or RAM on a CPU node) and puts only the rest on the
 * lenders, evenly. The operator can set the local share explicitly.
 */
export interface SplitPlanInput {
  accel: 'cpu' | 'cuda' | 'vulkan';
  /** Free memory on this node now: GPU memory for a GPU node, RAM for a CPU node. */
  freeLocalMB: number;
  /** Memory the whole model needs on that kind of device (weights + context). */
  modelMB: number;
  /** Transformer blocks in the model (from its GGUF header). */
  blocks: number;
  lenders: number;
  /** Operator override: fraction of the model kept on this node (0–1). */
  localShare?: number;
}

export interface SplitPlan {
  /** False when the model fits here and no share was forced: run without lenders. */
  use: boolean;
  /** llama.cpp -ngl. */
  gpuLayers: number;
  /** llama.cpp --tensor-split: proportions per device: each lender, then the local GPU. */
  tensorSplit?: number[];
  localShare: number;
  note: string;
}

/** Room kept free on the local device for buffers and the rest of the system. */
const RESERVE_MB = { gpu: 512, cpu: 1536 };

export function planSplit(p: SplitPlanInput): SplitPlan {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (p.lenders < 1) return { use: false, gpuLayers: p.accel === 'cpu' ? 0 : 999, localShare: 1, note: 'no lenders' };
  const room = p.freeLocalMB - (p.accel === 'cpu' ? RESERVE_MB.cpu : RESERVE_MB.gpu);
  const fits = Math.max(0, Math.min(1, room / Math.max(1, p.modelMB)));
  const forced = p.localShare !== undefined;
  const local = forced ? Math.max(0, Math.min(1, p.localShare!)) : fits;
  if (!forced && local >= 1) {
    return { use: false, gpuLayers: p.accel === 'cpu' ? 0 : 999, localShare: 1, note: `fits on this node${p.accel === 'cpu' ? '' : "'s GPU"}; lenders not needed` };
  }
  const each = (1 - local) / p.lenders;
  if (p.accel !== 'cpu') {
    // Every layer goes to a device. llama.cpp puts RPC devices FIRST in the model's device list
    // (measured: a 0.8 share listed first landed on the lender), so the local GPU's share comes last.
    return {
      use: true,
      gpuLayers: 999,
      tensorSplit: [...Array.from({ length: p.lenders }, () => each), local].map((x) => Math.round(x * 1000) / 1000),
      localShare: local,
      note: `${pct(local)} on this GPU, ${pct(1 - local)} on ${p.lenders} other node${p.lenders > 1 ? 's' : ''}`,
    };
  }
  // CPU node: layers not offloaded stay in local RAM; -ngl layers go to the lenders (the only devices).
  const remote = Math.max(1, Math.min(p.blocks, Math.round(p.blocks * (1 - local))));
  return {
    use: true,
    gpuLayers: remote,
    ...(p.lenders > 1 ? { tensorSplit: Array.from({ length: p.lenders }, () => 1) } : {}),
    localShare: 1 - remote / p.blocks,
    note: `${p.blocks - remote} of ${p.blocks} layers here, ${remote} on ${p.lenders} other node${p.lenders > 1 ? 's' : ''}`,
  };
}
