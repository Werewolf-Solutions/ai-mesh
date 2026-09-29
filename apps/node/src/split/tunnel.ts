/**
 * Byte tunnel between a local TCP socket and a libp2p stream.
 *
 * Splitting a model uses llama.cpp's RPC backend, which speaks plain,
 * unauthenticated TCP. It is never exposed on a network: both ends stay on
 * 127.0.0.1, and the bytes travel between machines inside a libp2p stream,
 * which is encrypted (Noise) and only exists between operator-approved peers.
 */
import type { Stream } from '@libp2p/interface';
import type { Socket } from 'node:net';

/** First byte a lender sends on an accepted tunnel; a refused tunnel is reset instead. */
export const TUNNEL_OK = 0x57;

/**
 * Copy bytes both ways until either side ends. `preamble: 'send'` (lender)
 * writes TUNNEL_OK first; `'expect'` (borrower) requires and strips it.
 */
export function pipeSocketStream(sock: Socket, stream: Stream, opts: { preamble?: 'send' | 'expect' } = {}): Promise<{ toStream: number; toSocket: number }> {
  let toStream = 0;
  let toSocket = 0;
  sock.setNoDelay(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      if (err) stream.abort(err);
      else void stream.close().catch(() => stream.abort(new Error('close failed')));
      sock.destroy();
      resolve({ toStream, toSocket });
    };

    if (opts.preamble === 'send') stream.send(Uint8Array.of(TUNNEL_OK));
    let expectOk = opts.preamble === 'expect';

    // socket → stream, with backpressure from the stream.
    sock.on('data', (d: Buffer) => {
      toStream += d.length;
      if (!stream.send(d)) {
        sock.pause();
        stream.onDrain().then(
          () => sock.resume(),
          (e: Error) => finish(e),
        );
      }
    });
    sock.on('end', () => finish());
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish());

    // stream → socket, with backpressure from the socket.
    void (async () => {
      try {
        for await (const chunk of stream) {
          let b = chunk instanceof Uint8Array ? chunk : chunk.subarray();
          if (expectOk) {
            if (b[0] !== TUNNEL_OK) throw new Error('tunnel refused');
            expectOk = false;
            b = b.subarray(1);
            if (!b.length) continue;
          }
          toSocket += b.length;
          if (!sock.write(b)) await new Promise<void>((r) => sock.once('drain', () => r()).once('close', () => r()));
          if (sock.destroyed) break;
        }
        finish();
      } catch (e) {
        finish(e as Error);
      }
    })();
  });
}

/** Open a tunnel and wait for the lender's TUNNEL_OK: tells "allowed" apart from "refused" before llama-server starts. */
export async function probeTunnel(open: () => Promise<Stream>, timeoutMs = 5000): Promise<boolean> {
  let stream: Stream | undefined;
  try {
    stream = await open();
    const it = stream[Symbol.asyncIterator]();
    const first = await Promise.race([it.next(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    if (!first || first.done) return false;
    const b = first.value instanceof Uint8Array ? first.value : first.value.subarray();
    return b[0] === TUNNEL_OK;
  } catch {
    return false;
  } finally {
    if (stream) void stream.close().catch(() => stream!.abort(new Error('probe done')));
  }
}
