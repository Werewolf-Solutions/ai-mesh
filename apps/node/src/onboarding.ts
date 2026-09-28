/**
 * Node initialisation and the operator-approved onboarding workflow:
 *   1. `mesh init`        creates config, identity and HTTP secrets (never overwrites).
 *   2. `mesh join-info`   exports PUBLIC data only: peer ID + advertised addresses.
 *   3. `mesh peers approve <join-info.json|peerId>` on EVERY other operator's node.
 *   4. Nodes pick up authorized-peers.json changes automatically (poll) or on SIGHUP.
 */
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readAuthorized, writeAuthorized } from './admission.js';
import { FILES, loadConfig, NodeConfigSchema, writeConfig, type NodeConfigInput } from './config.js';
import { ensureIdentity, loadIdentity } from './identity.js';
import { ensureSecrets } from './secrets.js';
import { exists, readJsonIfExists } from './util/fs.js';

export interface InitOptions {
  networkId: string;
  label: string;
  config?: Partial<NodeConfigInput>;
}

export async function initNode(dataDir: string, o: InitOptions): Promise<{ peerId: string; createdConfig: boolean; createdIdentity: boolean }> {
  let createdConfig = false;
  if (!(await exists(join(dataDir, FILES.config)))) {
    const cfg: NodeConfigInput = { ...(o.config ?? {}), networkId: o.networkId, label: o.label };
    NodeConfigSchema.parse(cfg);
    await writeConfig(dataDir, cfg);
    createdConfig = true;
  }
  const cfg = await loadConfig(dataDir).catch(async (err) => {
    // Allow fake configs to be initialised without the env flag.
    const raw = (await readJsonIfExists(join(dataDir, FILES.config))) as NodeConfigInput;
    if (raw?.runtime?.kind === 'fake') return NodeConfigSchema.parse(raw);
    throw err;
  });
  const { identity, created } = await ensureIdentity(dataDir);
  await ensureSecrets(dataDir);
  if (!(await readAuthorized(dataDir))) {
    await writeAuthorized(dataDir, { networkId: cfg.networkId, peers: [] });
  }
  return { peerId: identity.peerId, createdConfig, createdIdentity: created };
}

export const JoinInfoSchema = z.strictObject({
  format: z.literal('werewolf-mesh-join/1'),
  networkId: z.string(),
  peerId: z.string(),
  label: z.string(),
  addrs: z.array(z.string()).max(16),
  relayServer: z.boolean(),
  note: z.string().optional(),
});
export type JoinInfo = z.infer<typeof JoinInfoSchema>;

/** Public join information. Contains no private key and no HTTP tokens. */
export async function joinInfo(dataDir: string): Promise<JoinInfo> {
  const raw = (await readJsonIfExists(join(dataDir, FILES.config))) as NodeConfigInput;
  const cfg = NodeConfigSchema.parse(raw);
  const { peerId } = await loadIdentity(dataDir);
  const withId = (a: string) => (a.includes('/p2p/') ? a : `${a}/p2p/${peerId}`);
  let addrs = cfg.p2p.announce.map(withId);
  let note: string | undefined;
  if (addrs.length === 0) {
    addrs = cfg.p2p.listen.filter((a) => !a.includes('0.0.0.0') && !a.includes('/::/')).map(withId);
    note =
      'No p2p.announce addresses configured. Listed addresses (if any) are local listen addresses, which are usually NOT reachable from the internet. ' +
      'Set p2p.announce to a public /ip4/<public-ip>/tcp/<port> or /dns4/<name>/tcp/<port>, or rely on a relay.';
  }
  return { format: 'werewolf-mesh-join/1', networkId: cfg.networkId, peerId, label: cfg.label, addrs, relayServer: cfg.p2p.relayServer, ...(note ? { note } : {}) };
}

export async function approvePeer(dataDir: string, peerId: string, opts: { label?: string; addrs?: string[] } = {}): Promise<'added' | 'updated'> {
  peerIdFromString(peerId); // validates
  for (const a of opts.addrs ?? []) multiaddr(a); // validates
  const list = await readAuthorized(dataDir);
  if (!list) throw new Error('authorized-peers.json missing; run ./mesh init first');
  const self = (await loadIdentity(dataDir)).peerId;
  if (peerId === self) throw new Error('refusing to approve this node\'s own peer ID');
  const existing = list.peers.find((p) => p.peerId === peerId);
  if (existing) {
    if (opts.label) existing.label = opts.label;
    if (opts.addrs?.length) existing.addrs = [...new Set([...(existing.addrs ?? []), ...opts.addrs])].slice(0, 8);
    await writeAuthorized(dataDir, list);
    return 'updated';
  }
  list.peers.push({ peerId, ...(opts.label ? { label: opts.label } : {}), ...(opts.addrs?.length ? { addrs: opts.addrs.slice(0, 8) } : {}) });
  await writeAuthorized(dataDir, list);
  return 'added';
}

export async function approveFromJoinFile(dataDir: string, file: string): Promise<{ peerId: string; result: 'added' | 'updated' }> {
  const info = JoinInfoSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const list = await readAuthorized(dataDir);
  if (list && list.networkId !== info.networkId) {
    throw new Error(`join file is for network "${info.networkId}", this node is on "${list.networkId}"`);
  }
  const result = await approvePeer(dataDir, info.peerId, { label: info.label, addrs: info.addrs });
  return { peerId: info.peerId, result };
}

export async function revokePeer(dataDir: string, peerId: string): Promise<boolean> {
  const list = await readAuthorized(dataDir);
  if (!list) return false;
  const before = list.peers.length;
  list.peers = list.peers.filter((p) => p.peerId !== peerId);
  await writeAuthorized(dataDir, list);
  return list.peers.length < before;
}
