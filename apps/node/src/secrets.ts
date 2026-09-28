/**
 * HTTP credentials, separate from peer membership.
 *  - clientTokens: may call /v1/* (chat, models).
 *  - adminToken: may call /admin/* (status, peers, metrics, reload).
 * Stored in <dataDir>/secrets.json (mode 0600). Compared in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { FILES } from './config.js';
import { atomicWriteJson, readJsonIfExists } from './util/fs.js';

const SecretsSchema = z.strictObject({
  clientTokens: z.array(z.string().min(24)).max(64),
  adminToken: z.string().min(24),
});
export type Secrets = z.infer<typeof SecretsSchema>;

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export async function loadSecrets(dataDir: string): Promise<Secrets> {
  const raw = await readJsonIfExists(join(dataDir, FILES.secrets));
  if (raw === undefined) throw new Error(`Missing ${FILES.secrets}; run ./mesh init`);
  return SecretsSchema.parse(raw);
}

export async function ensureSecrets(dataDir: string): Promise<{ secrets: Secrets; created: boolean }> {
  const raw = await readJsonIfExists(join(dataDir, FILES.secrets));
  if (raw !== undefined) return { secrets: SecretsSchema.parse(raw), created: false };
  const secrets: Secrets = { clientTokens: [newToken('wmc')], adminToken: newToken('wma') };
  await atomicWriteJson(join(dataDir, FILES.secrets), secrets);
  return { secrets, created: true };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export class TokenChecker {
  private readonly client: Buffer[];
  private readonly admin: Buffer;
  constructor(secrets: Secrets) {
    this.client = secrets.clientTokens.map(digest);
    this.admin = digest(secrets.adminToken);
  }
  /** Returns 'admin', 'client' or null. The admin token also grants client access. */
  check(token: string | undefined): 'admin' | 'client' | null {
    if (!token) return null;
    const d = digest(token);
    if (timingSafeEqual(d, this.admin)) return 'admin';
    let ok = false;
    for (const c of this.client) ok = timingSafeEqual(d, c) || ok;
    return ok ? 'client' : null;
  }
}
