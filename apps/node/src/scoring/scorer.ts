/**
 * Summary scorer: compares candidate texts with a reference text.
 *
 *  - ROUGE-L F1 (always available, no model): shared wording.
 *  - Meaning similarity (optional): cosine similarity of sentence embeddings
 *    from a small open embedding model (see models/scorer-manifest.json), run
 *    by the same pinned llama.cpp build in embedding mode, on loopback only.
 *
 * Scoring runs on the node the client talks to, so every run scored through the
 * same gateway uses the same model. It never runs on remote peers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { freePort } from '../runtime/llamacpp.js';
import { atomicWriteFile, readJsonIfExists } from '../util/fs.js';
import type { Logger } from '../util/log.js';
import { sha256File } from '../model.js';
import { stat } from 'node:fs/promises';
import { rougeL } from './rouge.js';

export const ScorerManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string(),
  displayName: z.string(),
  license: z.string(),
  attribution: z.string(),
  source: z.object({ repo: z.string() }).passthrough(),
  artifact: z
    .object({
      filename: z.string().regex(/^[A-Za-z0-9._-]+\.gguf$/),
      url: z.string().url(),
      sizeBytes: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .passthrough(),
  /** llama.cpp --pooling value the model was trained for. */
  pooling: z.enum(['cls', 'mean', 'last']),
  /** Cosine similarity of the reference to an unrelated sentence, measured when pinning (for context in the UI). */
  calibration: z.object({ unrelated: z.string(), note: z.string() }).passthrough(),
});
export type ScorerManifest = z.infer<typeof ScorerManifestSchema>;

/** A fixed, off-topic sentence: its similarity to the reference shows the "unrelated" floor. */
export const UNRELATED_SENTENCE = 'To bake the bread, mix two cups of flour with warm water, a spoon of yeast and a pinch of salt.';

export interface ScoreResult {
  rougeL: Array<{ f1: number; precision: number; recall: number }>;
  semantic:
    | { available: true; model: string; cosine: number[]; unrelatedBaseline: number }
    | { available: false; reason: string };
}

export class Scorer {
  private child: ChildProcess | undefined;
  private baseUrl = '';
  private apiKey = '';
  private state: 'absent' | 'loading' | 'ready' | 'failed' | 'disabled' = 'loading';
  private detail = '';

  constructor(
    private readonly opts: {
      enabled: boolean;
      binary: string;
      manifestPath: string;
      modelDir: string;
      dataDir: string;
      threads: number;
      log: Logger;
    },
  ) {}

  status(): { state: string; detail: string } {
    return { state: this.state, detail: this.detail };
  }

  private manifest: ScorerManifest | undefined;

  async start(): Promise<void> {
    if (!this.opts.enabled) {
      this.state = 'disabled';
      this.detail = 'scorer.enabled is false';
      return;
    }
    try {
      const raw = await readJsonIfExists(this.opts.manifestPath);
      if (!raw) throw new Error(`no scorer manifest at ${this.opts.manifestPath}`);
      const m = ScorerManifestSchema.parse(raw);
      this.manifest = m;
      const path = join(this.opts.modelDir, m.artifact.filename);
      if (!existsSync(path)) {
        this.state = 'absent';
        this.detail = `embedding model not installed; run: ./mesh model download --scorer`;
        return;
      }
      if ((await stat(path)).size !== m.artifact.sizeBytes || (await sha256File(path)) !== m.artifact.sha256) {
        this.state = 'failed';
        this.detail = `${m.artifact.filename} does not match the scorer manifest SHA-256; not loaded`;
        return;
      }
      if (!existsSync(this.opts.binary)) {
        this.state = 'absent';
        this.detail = `llama-server binary not found at ${this.opts.binary}`;
        return;
      }
      const port = await freePort();
      this.apiKey = randomBytes(24).toString('base64url');
      const keyFile = join(this.opts.dataDir, 'scorer.key');
      await atomicWriteFile(keyFile, this.apiKey + '\n', 0o600);
      const args = [
        '-m', path, '--embedding', '--pooling', m.pooling,
        '--host', '127.0.0.1', '--port', String(port),
        '-c', '512', '-np', '1', '-t', String(this.opts.threads), '-tb', String(this.opts.threads),
        '--api-key-file', keyFile, '--no-webui', '--offline', '--no-slots',
      ];
      const usePdeath = process.platform === 'linux' && existsSync('/usr/bin/setpriv');
      const [cmd, cmdArgs] = usePdeath ? ['/usr/bin/setpriv', ['--pdeathsig', 'TERM', '--', this.opts.binary, ...args]] : [this.opts.binary, args];
      this.baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      this.child = child;
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        if (this.state !== 'disabled') {
          this.state = 'failed';
          this.detail = `embedding runtime exited (code ${code})`;
        }
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (!this.child) throw new Error(this.detail || 'embedding runtime exited during startup');
        const ok = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
        if (ok) {
          this.state = 'ready';
          this.detail = `${m.displayName} (${m.license})`;
          this.opts.log.info({ model: m.id }, 'summary scorer ready');
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('embedding runtime not healthy after 30 s');
    } catch (err) {
      this.state = 'failed';
      this.detail = (err as Error).message.slice(0, 300);
      this.opts.log.warn({ err: this.detail }, 'summary scorer unavailable (ROUGE-L still works)');
    }
  }

  async stop(): Promise<void> {
    const c = this.child;
    this.state = 'disabled';
    this.child = undefined;
    c?.kill('SIGTERM');
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  /** Sentence embeddings (also used by pack memory). Texts are truncated to fit the 512-token window. */
  async embed(texts: string[]): Promise<number[][]> {
    texts = texts.map((t) => (t.length > 1500 ? t.slice(0, 1500) : t) || ' ');
    const r = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
    const j = (await r.json()) as { data: Array<{ index: number; embedding: number[] }> };
    return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async score(reference: string, candidates: string[]): Promise<ScoreResult> {
    const rouge = candidates.map((c) => rougeL(c, reference));
    if (this.state !== 'ready' || !this.manifest) {
      return { rougeL: rouge, semantic: { available: false, reason: this.detail || this.state } };
    }
    try {
      const vecs = await this.embed([reference, UNRELATED_SENTENCE, ...candidates.map((c) => c || ' ')]);
      const [ref, unrelated, ...cands] = vecs as [number[], number[], ...number[][]];
      return {
        rougeL: rouge,
        semantic: {
          available: true,
          model: this.manifest.id,
          cosine: cands.map((v) => cosine(ref, v)),
          unrelatedBaseline: cosine(ref, unrelated),
        },
      };
    } catch (err) {
      return { rougeL: rouge, semantic: { available: false, reason: (err as Error).message } };
    }
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
