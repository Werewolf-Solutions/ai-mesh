import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { peerIdFromString } from '@libp2p/peer-id';
import { FarmEnvelope, type FarmKey } from '@werewolf-mesh/protocol';
import type { Identity } from '../identity.js';
import { atomicWriteFile, exists } from '../util/fs.js';

const keyStatement = (peerId: string, publicKey: string) => Buffer.from(`werewolf-farm-key-v1\0${peerId}\0${publicKey}`);
const derive = (shared: Buffer, context: string) => Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(32), Buffer.from(`werewolf-farm-wrap-v1\0${context}`), 32));

export async function verifyFarmKey(key: FarmKey, expected: string): Promise<void> {
  if (key.peerId !== expected) throw new Error('encryption key identity mismatch');
  const peer = peerIdFromString(expected);
  if (!peer.publicKey || !(await peer.publicKey.verify(keyStatement(key.peerId, key.publicKey), Buffer.from(key.signature, 'base64')))) throw new Error('invalid encryption key signature');
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'x25519') throw new Error('expected an X25519 encryption key');
}

function seal(key: Buffer, plaintext: Buffer, context: string): { nonce: Buffer; tag: Buffer; data: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), data };
}
function open(key: Buffer, nonce: Buffer, tag: Buffer, data: Buffer, context: string): Buffer {
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid encryption parameters');
  const cipher = createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** Fresh data key per envelope, wrapped with ephemeral X25519 + HKDF + AES-GCM. */
export function encryptFor(key: FarmKey, plaintext: Buffer, context: string): FarmEnvelope {
  const ephemeral = generateKeyPairSync('x25519');
  const recipient = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  if (recipient.asymmetricKeyType !== 'x25519') throw new Error('expected X25519');
  const binding = `${key.peerId}\0${context}`;
  const wrappingKey = derive(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), binding);
  const dataKey = randomBytes(32);
  const wrapped = seal(wrappingKey, dataKey, binding);
  const content = seal(dataKey, plaintext, binding);
  dataKey.fill(0); wrappingKey.fill(0);
  return FarmEnvelope.parse({ v: 1, recipient: key.peerId, context,
    ephemeralKey: (ephemeral.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
    wrappedKey: Buffer.concat([wrapped.nonce, wrapped.tag, wrapped.data]).toString('base64'),
    nonce: content.nonce.toString('base64'), tag: content.tag.toString('base64'), data: content.data.toString('base64') });
}

export class FarmCrypto {
  private constructor(readonly announcement: FarmKey, private readonly privateKey: KeyObject, private readonly storageKey: Buffer) {}
  static async load(dir: string, identity: Identity): Promise<FarmCrypto> {
    const path = join(dir, 'farm', 'encryption.key');
    if (!(await exists(path))) {
      const keys = generateKeyPairSync('x25519');
      await atomicWriteFile(path, keys.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer);
    }
    const privateKey = createPrivateKey({ key: await readFile(path), format: 'der', type: 'pkcs8' });
    const publicKey = (createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
    const signature = Buffer.from(await identity.privateKey.sign(keyStatement(identity.peerId, publicKey))).toString('base64');
    const storagePath = join(dir, 'farm', 'storage.key');
    if (!(await exists(storagePath))) await atomicWriteFile(storagePath, randomBytes(32));
    const storageKey = await readFile(storagePath);
    if (storageKey.length !== 32) throw new Error('invalid farm storage key');
    return new FarmCrypto({ peerId: identity.peerId, publicKey, signature }, privateKey, storageKey);
  }
  decrypt(raw: FarmEnvelope, context: string): Buffer {
    const e = FarmEnvelope.parse(raw);
    if (e.recipient !== this.announcement.peerId || e.context !== context) throw new Error('encrypted object binding mismatch');
    const binding = `${e.recipient}\0${context}`;
    const ephemeral = createPublicKey({ key: Buffer.from(e.ephemeralKey, 'base64'), format: 'der', type: 'spki' });
    if (ephemeral.asymmetricKeyType !== 'x25519') throw new Error('expected X25519');
    const wrappingKey = derive(diffieHellman({ privateKey: this.privateKey, publicKey: ephemeral }), binding);
    const wrapped = Buffer.from(e.wrappedKey, 'base64');
    const dataKey = open(wrappingKey, wrapped.subarray(0, 12), wrapped.subarray(12, 28), wrapped.subarray(28), binding);
    try { return open(dataKey, Buffer.from(e.nonce, 'base64'), Buffer.from(e.tag, 'base64'), Buffer.from(e.data, 'base64'), binding); }
    finally { dataKey.fill(0); wrappingKey.fill(0); }
  }
  sealRecord(value: unknown, context: string): Buffer {
    const e = seal(this.storageKey, Buffer.from(JSON.stringify(value)), context);
    return Buffer.concat([e.nonce, e.tag, e.data]);
  }
  openRecord(bytes: Buffer, context: string): unknown {
    return JSON.parse(open(this.storageKey, bytes.subarray(0, 12), bytes.subarray(12, 28), bytes.subarray(28), context).toString('utf8'));
  }
}
