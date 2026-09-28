/**
 * Persistent Ed25519 libp2p identity. The private key is stored as a libp2p
 * protobuf in <dataDir>/identity.key (mode 0600) and never logged or exported.
 */
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILES } from './config.js';
import { atomicWriteFile, exists } from './util/fs.js';

export interface Identity {
  privateKey: PrivateKey;
  peerId: string;
}

export async function loadIdentity(dataDir: string): Promise<Identity> {
  const path = join(dataDir, FILES.identity);
  const buf = await readFile(path);
  const privateKey = privateKeyFromProtobuf(new Uint8Array(buf));
  if (privateKey.type !== 'Ed25519') throw new Error(`${path}: expected an Ed25519 key, found ${privateKey.type}`);
  return { privateKey, peerId: peerIdFromPrivateKey(privateKey).toString() };
}

/** Create an identity only if none exists. Never overwrites. */
export async function ensureIdentity(dataDir: string): Promise<{ identity: Identity; created: boolean }> {
  const path = join(dataDir, FILES.identity);
  if (await exists(path)) return { identity: await loadIdentity(dataDir), created: false };
  const privateKey = await generateKeyPair('Ed25519');
  await atomicWriteFile(path, privateKeyToProtobuf(privateKey), 0o600);
  return { identity: { privateKey, peerId: peerIdFromPrivateKey(privateKey).toString() }, created: true };
}
