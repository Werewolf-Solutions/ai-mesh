/**
 * External engines (docs/engines.md): models served by another inference
 * server on this machine (or one the operator trusts), e.g. ds4-server.
 * Kept in <data>/engines.json, managed only by this node's operator.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { CatalogEntry } from '../model.js';
import { atomicWriteJson, readJsonIfExists } from '../util/fs.js';

export const EngineConfig = z.strictObject({
  id: z.string().regex(/^[a-z0-9._-]+$/).min(2).max(64),
  name: z.string().min(1).max(64),
  url: z.string().url(),
  /** Model name the engine expects; default: the first it lists. */
  model: z.string().max(200).optional(),
  apiKeyFile: z.string().max(500).optional(),
  contextTokens: z.number().int().min(256).max(65536).default(8192),
  maxOutputTokens: z.number().int().min(16).max(16384).default(2048),
  thinking: z.enum(['none', 'toggle', 'always']).default('none'),
  thinkingControl: z.enum(['none', 'reasoning_effort', 'chat_template_kwargs']).default('none'),
  license: z.string().max(100).default('unknown'),
  description: z.string().max(300).default(''),
  /** SHA-256 of the weights file, if the operator knows it. Nodes with the same hash serve "the same model". */
  weightsSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type EngineConfig = z.infer<typeof EngineConfig>;
export type EngineInput = z.input<typeof EngineConfig>;

const File = z.object({ version: z.literal(1), engines: z.array(EngineConfig).max(8) });

export type ExternalEntry = CatalogEntry & { external: EngineConfig };
export const isExternal = (e: CatalogEntry): e is ExternalEntry => 'external' in e && !!(e as ExternalEntry).external;

/** Identity of an external model: the weights hash if known, else a hash of the declared ID (same ID → same model). */
export function engineHash(c: Pick<EngineConfig, 'id' | 'weightsSha256'>): string {
  return c.weightsSha256 ?? createHash('sha256').update(`declared:${c.id}`).digest('hex');
}
export const engineFingerprint = (c: Pick<EngineConfig, 'id' | 'weightsSha256'>) => `${c.id}:ext:${engineHash(c)}`;
const EXT_FP = /^([a-z0-9._-]+):ext:([0-9a-f]{64})$/;
export const parseEngineFingerprint = (fp: string) => {
  const m = EXT_FP.exec(fp);
  return m ? { id: m[1]!, hash: m[2]! } : null;
};

/** A catalog entry for an engine configured on this node. */
export function engineEntry(c: EngineConfig, order: number): ExternalEntry {
  return {
    manifestVersion: 1,
    id: c.id,
    displayName: c.name,
    family: 'external',
    params: '',
    order,
    description: c.description || `Served by an external engine (${new URL(c.url).host}). Declared by its operator; the mesh has not verified the model file.`,
    source: { repo: 'external', license: c.license, attribution: 'declared by the operator of the node running the engine' },
    artifact: { filename: `${c.id}.gguf`, url: 'https://invalid.example/external', sizeBytes: 1, sha256: engineHash(c), quantization: 'unknown' },
    chatTemplate: { format: 'engine' },
    capabilities: { thinking: c.thinking },
    serving: { contextTokens: c.contextTokens, maxOutputTokens: c.maxOutputTokens },
    resources: { ramMB: 1, tested: false },
    external: c,
  };
}

/**
 * An external model another node serves and this node knows only by its
 * fingerprint. Limits are conservative; the node running the engine applies its own.
 */
export function remoteEngineEntry(fp: string, order: number): CatalogEntry | null {
  const p = parseEngineFingerprint(fp);
  if (!p) return null;
  return {
    manifestVersion: 1,
    id: p.id,
    displayName: p.id,
    family: 'external',
    params: '',
    order,
    description: 'Served by an external engine on another node. Declared by that node’s operator; not verified by the mesh.',
    source: { repo: 'external', license: 'unknown', attribution: 'declared by another node' },
    artifact: { filename: `${p.id}.gguf`, url: 'https://invalid.example/external', sizeBytes: 1, sha256: p.hash, quantization: 'unknown' },
    chatTemplate: { format: 'engine' },
    capabilities: { thinking: 'toggle' },
    serving: { contextTokens: 8192, maxOutputTokens: 2048 },
    resources: { ramMB: 1, tested: false },
  };
}

export async function loadEngines(dataDir: string): Promise<EngineConfig[]> {
  const raw = await readJsonIfExists(join(dataDir, 'engines.json'));
  return raw ? File.parse(raw).engines : [];
}

export async function saveEngines(dataDir: string, engines: EngineConfig[]): Promise<void> {
  await atomicWriteJson(join(dataDir, 'engines.json'), { version: 1, engines });
}
