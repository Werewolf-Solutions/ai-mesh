/**
 * Length-prefixed JSON frames over a libp2p stream.
 *
 * Each frame = unsigned varint length + UTF-8 JSON. Frames larger than
 * `maxBytes` are refused before being buffered in full. JSON is decoded
 * strictly (invalid UTF-8 rejected), the protocol version is checked, and the
 * object is validated against a Zod schema. TCP chunk boundaries are
 * irrelevant: the decoder reassembles frames.
 */
import type { Stream } from '@libp2p/interface';
import { lpStream, type LengthPrefixedStream } from '@libp2p/utils';
import { LIMITS, MeshError, PROTOCOL_VERSION } from '@werewolf-mesh/protocol';
import type { z } from 'zod';

export class ProtocolError extends MeshError {
  constructor(message: string) {
    super('protocol_error', message);
    this.name = 'ProtocolError';
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export class FrameStream {
  private readonly lp: LengthPrefixedStream<Stream>;

  constructor(
    readonly stream: Stream,
    private readonly maxBytes: number = LIMITS.maxFrameBytes,
    /** Frame version this protocol speaks (status/infer: PROTOCOL_VERSION; pack memory: 1). */
    private readonly version: number = PROTOCOL_VERSION,
  ) {
    this.lp = lpStream(stream, { maxDataLength: maxBytes });
  }

  async read<S extends z.ZodType>(schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    let buf;
    try {
      buf = await this.lp.read(signal ? { signal } : undefined);
    } catch (err) {
      if (signal?.aborted) throw signal.reason instanceof MeshError ? signal.reason : new MeshError('cancelled', 'cancelled');
      const name = (err as Error).name;
      if (name === 'InvalidDataLengthError' || name === 'InvalidDataLengthLengthError' || name === 'InvalidMessageLengthError') {
        throw new ProtocolError(`frame exceeds ${this.maxBytes} bytes`);
      }
      throw new ProtocolError(`stream ended: ${(err as Error).message ?? name}`);
    }
    let obj: unknown;
    try {
      obj = JSON.parse(decoder.decode(buf.subarray()));
    } catch {
      throw new ProtocolError('malformed frame (not UTF-8 JSON)');
    }
    if (typeof obj !== 'object' || obj === null || (obj as { v?: unknown }).v !== this.version) {
      throw new ProtocolError(`unsupported protocol version ${JSON.stringify((obj as { v?: unknown } | null)?.v ?? null)}`);
    }
    const parsed = schema.safeParse(obj);
    if (!parsed.success) {
      throw new ProtocolError(`invalid frame: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.slice(0, 200));
    }
    return parsed.data;
  }

  async write(frame: object, signal?: AbortSignal): Promise<void> {
    const bytes = encoder.encode(JSON.stringify(frame));
    if (bytes.byteLength > this.maxBytes) throw new ProtocolError(`outgoing frame exceeds ${this.maxBytes} bytes`);
    await this.lp.write(bytes, signal ? { signal } : undefined);
  }

  async close(): Promise<void> {
    try {
      await this.stream.close({ signal: AbortSignal.timeout(2000) });
    } catch {
      this.stream.abort(new Error('close failed'));
    }
  }

  abort(reason: string): void {
    this.stream.abort(new Error(reason));
  }
}
