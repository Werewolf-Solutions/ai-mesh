/**
 * Operator-maintained membership list: <dataDir>/authorized-peers.json.
 *
 * Only peers listed here may connect, exchange status, use our relay, or send
 * inference jobs. Discovery (bootstrap, peer exchange, caches) never adds to
 * this list. Each operator edits their own copy; there is no central
 * membership server.
 */
import { peerIdFromString } from '@libp2p/peer-id';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FILES } from './config.js';
import { atomicWriteJson, readJsonIfExists } from './util/fs.js';

const PeerIdString = z.string().refine((s) => {
  try {
    peerIdFromString(s);
    return true;
  } catch {
    return false;
  }
}, 'invalid peer ID');

export const AuthorizedPeersSchema = z.strictObject({
  networkId: z.string().min(1).max(64),
  peers: z
    .array(
      z.strictObject({
        peerId: PeerIdString,
        label: z.string().max(64).optional(),
        /** Optional known addresses for this peer (dial hints only). */
        addrs: z.array(z.string().max(512)).max(8).optional(),
      }),
    )
    .max(1024),
});
export type AuthorizedPeers = z.infer<typeof AuthorizedPeersSchema>;

export async function readAuthorized(dataDir: string): Promise<AuthorizedPeers | undefined> {
  const raw = await readJsonIfExists(join(dataDir, FILES.authorized));
  return raw === undefined ? undefined : AuthorizedPeersSchema.parse(raw);
}

export async function writeAuthorized(dataDir: string, list: AuthorizedPeers): Promise<void> {
  AuthorizedPeersSchema.parse(list);
  await atomicWriteJson(join(dataDir, FILES.authorized), list, 0o600);
}

export class Admission {
  private entries = new Map<string, { label?: string; addrs: string[] }>();
  private mtimeMs = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly dataDir: string,
    readonly networkId: string,
    readonly selfPeerId: string,
    private readonly onChange: (added: string[], removed: string[]) => void = () => {},
  ) {}

  async load(): Promise<void> {
    const path = join(this.dataDir, FILES.authorized);
    const list = await readAuthorized(this.dataDir);
    const next = new Map<string, { label?: string; addrs: string[] }>();
    if (list) {
      if (list.networkId !== this.networkId) {
        throw new Error(`${path}: networkId "${list.networkId}" does not match node networkId "${this.networkId}"`);
      }
      for (const p of list.peers) {
        if (p.peerId === this.selfPeerId) continue;
        next.set(p.peerId, { label: p.label, addrs: p.addrs ?? [] });
      }
    }
    const added = [...next.keys()].filter((k) => !this.entries.has(k));
    const removed = [...this.entries.keys()].filter((k) => !next.has(k));
    this.entries = next;
    try {
      this.mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
    if (added.length || removed.length) this.onChange(added, removed);
  }

  /** Poll the file for changes; reload on modification. */
  watch(intervalMs: number, onError: (err: unknown) => void): void {
    this.timer = setInterval(async () => {
      try {
        const m = (await stat(join(this.dataDir, FILES.authorized)).catch(() => undefined))?.mtimeMs ?? 0;
        if (m !== this.mtimeMs) await this.load();
      } catch (err) {
        onError(err);
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  isAuthorized(peerId: string): boolean {
    return this.entries.has(peerId);
  }

  label(peerId: string): string | null {
    return this.entries.get(peerId)?.label ?? null;
  }

  configuredAddrs(peerId: string): string[] {
    return this.entries.get(peerId)?.addrs ?? [];
  }

  list(): string[] {
    return [...this.entries.keys()];
  }
}
