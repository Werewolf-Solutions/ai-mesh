/**
 * Browser side of pack memory. The withdrawal token is generated here and
 * never leaves this browser until the author withdraws; gateways only ever see
 * its SHA-256. Tokens are kept in localStorage under wam.packTokens.
 */
import type { Note, NoteKind } from '@werewolf-mesh/protocol';
import type { Gateway } from './store';

export interface NoteView {
  note: Note;
  group: string;
  groupSize: number;
  weight: number;
  uses: number;
  hidden: boolean;
  similarity?: number;
}

export interface PackStats {
  notes: number;
  visible: number;
  withdrawn: number;
  waitingToSpread: number;
  semanticSearch: boolean;
  lastSync: { at: number; ok: boolean; received: number } | null;
}

const TOKENS_KEY = 'wam.packTokens';

export function myTokens(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function saveToken(id: string, token: string): void {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify({ ...myTokens(), [id]: token }));
  } catch {
    /* storage unavailable: the note cannot be withdrawn later from this browser */
  }
}
function forgetToken(id: string): void {
  try {
    const t = myTokens();
    delete t[id];
    localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 hex. WebCrypto where available (secure contexts), small fallback otherwise (plain-HTTP LAN pages). */
async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  if (globalThis.crypto?.subtle) {
    const d = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return sha256Fallback(data);
}

function sha256Fallback(msg: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, len * 8);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const t1 = (h! + S1 + ((e! & f!) ^ (~e! & g!)) + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const t2 = (S0 + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

export class PackApi {
  constructor(private readonly gateways: Gateway[]) {}

  /** Try each gateway in order until one answers (not 5xx / network error). */
  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let last: Error = new Error('no gateway configured');
    for (const g of this.gateways.slice(0, 3)) {
      const tok = g.adminToken || g.token;
      let r: Response;
      try {
        r = await fetch(g.url.replace(/\/$/, '') + path, {
          ...init,
          headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
        });
      } catch {
        last = new Error(`Cannot reach ${g.url}`);
        continue; // network error: try the next gateway
      }
      const j = await r.json().catch(() => null);
      if (r.ok) return j as T;
      last = new Error(j?.error?.message ?? `HTTP ${r.status}`);
      // A gateway-specific problem (down, busy, wrong token) → next gateway; anything else is the real answer.
      if (!(r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429)) throw last;
    }
    throw last;
  }

  async share(n: { kind: NoteKind; title: string; problem: string; solution: string; tags: string[] }): Promise<{ id: string; note: Note; removed: string[] }> {
    const token = randomToken();
    const withdrawHash = await sha256Hex(token);
    const r = await this.call<{ id: string; note: Note; removed: string[] }>('/v1/pack/notes', { method: 'POST', body: JSON.stringify({ ...n, withdrawHash }) });
    saveToken(r.id, token);
    return r;
  }

  async withdraw(noteId: string): Promise<void> {
    const token = myTokens()[noteId];
    if (!token) throw new Error('This browser does not hold the withdrawal key for that note.');
    await this.call('/v1/pack/withdraw', { method: 'POST', body: JSON.stringify({ noteId, token }) });
    forgetToken(noteId);
  }

  search(q: string, hidden = false): Promise<{ notes: NoteView[]; total: number; semantic: boolean }> {
    return this.call(`/v1/pack/notes?q=${encodeURIComponent(q)}&limit=60${hidden ? '&hidden=1' : ''}`);
  }

  helped(id: string): Promise<unknown> {
    return this.call(`/v1/pack/notes/${id}/helped`, { method: 'POST', body: '{}' });
  }

  hide(id: string, hidden: boolean): Promise<unknown> {
    return this.call('/admin/pack/hide', { method: 'POST', body: JSON.stringify({ id, hidden }) });
  }

  stats(): Promise<PackStats> {
    return this.call('/v1/pack/stats');
  }
}

/** First sentence of a question, as a note title. */
export function titleFrom(q: string): string {
  const s = q.replace(/\s+/g, ' ').trim();
  const first = s.split(/(?<=[.?!])\s/)[0] ?? s;
  return (first.length > 100 ? first.slice(0, 97) + '…' : first) || 'Untitled';
}
