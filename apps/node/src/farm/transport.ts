import type { Libp2p } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { FARM_LIMITS, FARM_PROTOCOL, FarmReply, FarmRequest, FarmTransferChunk, FarmTransferHeader, type FarmRequest as Request, type FarmReply as Reply } from '@werewolf-mesh/protocol';
import { FrameStream } from '../p2p/framing.js';

export async function writeTransfer(stream: FrameStream, value: unknown, signal: AbortSignal): Promise<void> {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > FARM_LIMITS.transferBytes) throw new Error('farm transfer too large');
  await stream.write({ v: 1, type: 'farm-transfer', bytes: data.length }, signal);
  let seq = 0;
  for (let i = 0; i < data.length; i += FARM_LIMITS.chunkBytes) await stream.write({ v: 1, type: 'farm-chunk', seq: seq++, data: data.subarray(i, i + FARM_LIMITS.chunkBytes).toString('base64') }, signal);
}
export async function readTransfer(stream: FrameStream, signal: AbortSignal): Promise<unknown> {
  const header = await stream.read(FarmTransferHeader, signal);
  const chunks: Buffer[] = []; let size = 0, seq = 0;
  while (size < header.bytes) {
    const chunk = await stream.read(FarmTransferChunk, signal);
    const bytes = Buffer.from(chunk.data, 'base64');
    if (chunk.seq !== seq++ || bytes.length === 0 || bytes.length > FARM_LIMITS.chunkBytes || bytes.toString('base64') !== chunk.data || size + bytes.length > header.bytes) throw new Error('invalid farm transfer chunk');
    chunks.push(bytes); size += bytes.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export class FarmTransport {
  constructor(private readonly libp2p: Libp2p, private readonly authorized: (id: string) => boolean, private readonly handler: (remote: string, request: Request) => Promise<Reply>) {}
  async register(): Promise<void> {
    await this.libp2p.handle(FARM_PROTOCOL, async (stream, connection) => {
      const remote = connection.remotePeer.toString();
      if (!this.authorized(remote)) { stream.abort(new Error('unauthorized')); return; }
      const frames = new FrameStream(stream, 128 * 1024, 1);
      const signal = AbortSignal.timeout(15000);
      try {
        const request = FarmRequest.parse(await readTransfer(frames, signal));
        if (!this.authorized(remote)) throw new Error('revoked');
        const reply = await this.handler(remote, request);
        await writeTransfer(frames, FarmReply.parse(reply), signal);
        await frames.close();
      } catch { frames.abort('invalid or interrupted farm request'); }
    }, { maxInboundStreams: 4, maxOutboundStreams: 4, runOnLimitedConnection: true });
  }
  async request(peer: string, request: Request, signal: AbortSignal = AbortSignal.timeout(15000)): Promise<Reply> {
    if (!this.authorized(peer)) throw new Error('target peer is not approved');
    const stream = await this.libp2p.dialProtocol(peerIdFromString(peer), FARM_PROTOCOL, { signal, runOnLimitedConnection: true });
    const frames = new FrameStream(stream, 128 * 1024, 1);
    try {
      await writeTransfer(frames, FarmRequest.parse(request), signal);
      const reply = FarmReply.parse(await readTransfer(frames, signal));
      if (!this.authorized(peer)) throw new Error('target peer was revoked');
      return reply;
    } finally { await frames.close(); }
  }
}
