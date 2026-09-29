/**
 * fetch_url with SSRF protection (docs/agents-design.md, "Capability limits").
 *
 * - The URL is parsed with the WHATWG parser, which normalises decimal, octal
 *   and hex IPv4 spellings (http://2130706433/, http://0177.0.0.1/,
 *   http://0x7f.1/ all become 127.0.0.1) before any check. Nothing is string-matched.
 * - Only http/https on the default port, without credentials in the URL.
 * - The host is resolved ONCE; every address must be public, and the
 *   connection goes to that exact address (DNS rebinding cannot swap it).
 * - Redirects are followed by hand, at most 3, and every hop is checked again.
 * - Size and time limits apply while streaming, after decompression.
 * - No cookies, no credentials, no Referer.
 *
 * Which URLs may be fetched at all (only ones from search results or the
 * user's own message) is decided by the caller, never by the model.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { SOFTWARE_VERSION } from '../version.js';

export class FetchRefused extends Error {
  constructor(
    message: string,
    readonly reason: 'blocked_address' | 'bad_url' | 'too_many_redirects' | 'unsupported_type' | 'http_error' | 'timeout' | 'network',
  ) {
    super(message);
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network", includes 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo (embeds IPv4)
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** True if this address must never be contacted. IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address. */
export function isBlockedAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(a);
  if (v === 4) return blocked.check(a, 'ipv4');
  if (v !== 6) return true;
  const lower = a.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  // ::ffff:7f00:1 (mapped, hex form)
  const hexMapped = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return blocked.check(a, 'ipv6');
}

/** Parse and check a URL's shape (not its address). Throws FetchRefused. */
export function checkUrl(raw: string, anyPort = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRefused('not a valid URL', 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchRefused(`only http and https are allowed (got ${u.protocol})`, 'bad_url');
  if (u.port !== '' && !anyPort) throw new FetchRefused('only the default ports (80/443) are allowed', 'bad_url');
  if (u.username || u.password) throw new FetchRefused('URLs with credentials are not allowed', 'bad_url');
  if (!u.hostname) throw new FetchRefused('URL has no host', 'bad_url');
  u.hash = '';
  return u;
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /**
   * TESTS ONLY: allow 127.0.0.1 on any port, so tests can serve pages locally. Every
   * other private or reserved address stays blocked. The node refuses this setting
   * outside fake-runtime test mode.
   */
  allowLoopback?: boolean;
  /** Replaceable resolver (tests). */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

const ACCEPTED = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;

export async function guardedFetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? 2 * 2 ** 20;
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const resolve = opts.resolve ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
  const loopbackOk = (a: string) => opts.allowLoopback === true && a === '127.0.0.1';
  let url = checkUrl(rawUrl, opts.allowLoopback);
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: Array<{ address: string; family: number }>;
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new FetchRefused(`could not resolve ${host}`, 'network');
      }
    }
    if (!addresses.length) throw new FetchRefused(`could not resolve ${host}`, 'network');
    // Every address must be public: a name that also points somewhere private is refused outright.
    if (addresses.some((a) => isBlockedAddress(a.address) && !loopbackOk(a.address))) {
      throw new FetchRefused(`${host} points to a private or reserved address`, 'blocked_address');
    }
    const pinned = addresses[0]!;
    const res = await request(url, pinned, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new FetchRefused(`more than ${maxRedirects} redirects`, 'too_many_redirects');
      let next: URL;
      try {
        next = new URL(res.headers.location, url);
      } catch {
        throw new FetchRefused('invalid redirect', 'bad_url');
      }
      url = checkUrl(next.toString(), opts.allowLoopback);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new FetchRefused(`HTTP ${status}`, 'http_error');
    }
    const contentType = String(res.headers['content-type'] ?? '');
    if (!ACCEPTED.test(contentType)) {
      res.destroy();
      throw new FetchRefused(`not a web page (${contentType.split(';')[0] || 'unknown type'})`, 'unsupported_type');
    }
    const { buf, truncated } = await readLimited(decompress(res), maxBytes, signal);
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
    let body: string;
    try {
      body = new TextDecoder(charset).decode(buf);
    } catch {
      body = new TextDecoder('utf-8').decode(buf);
    }
    return { url: url.toString(), contentType, body, truncated };
  }
}

function request(url: URL, pinned: { address: string; family: number }, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new FetchRefused('timed out', 'timeout'));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': `Mozilla/5.0 (compatible; WerewolfMesh/${SOFTWARE_VERSION}; +research)`,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en;q=0.9, *;q=0.5',
        },
        // Connect to the address we checked, whatever DNS says now. TLS still verifies the host name.
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          o?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)) as never,
        agent: false,
        signal,
      },
      resolve,
    );
    req.on('error', (err) => reject(signal.aborted ? new FetchRefused('timed out', 'timeout') : new FetchRefused(err.message, 'network')));
    req.end();
  });
}

function decompress(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'deflate') return res.pipe(createInflate());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  return res;
}

async function readLimited(stream: Readable, maxBytes: number, signal: AbortSignal): Promise<{ buf: Buffer; truncated: boolean }> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const c of stream) {
      if (signal.aborted) throw new FetchRefused('timed out', 'timeout');
      const b = c as Buffer;
      if (size + b.length > maxBytes) {
        parts.push(b.subarray(0, maxBytes - size));
        stream.destroy();
        return { buf: Buffer.concat(parts), truncated: true };
      }
      parts.push(b);
      size += b.length;
    }
  } catch (err) {
    if (err instanceof FetchRefused) throw err;
    if (signal.aborted) throw new FetchRefused('timed out', 'timeout');
    if (size > 0) return { buf: Buffer.concat(parts), truncated: true };
    throw new FetchRefused((err as Error).message, 'network');
  }
  return { buf: Buffer.concat(parts), truncated: false };
}
