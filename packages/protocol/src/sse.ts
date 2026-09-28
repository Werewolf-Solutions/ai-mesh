/**
 * Minimal, bounded Server-Sent Events parser for the chat stream.
 *
 * Stream contract (documented in docs/protocol.md):
 *  - `data: {chat.completion.chunk}` events carry text deltas.
 *  - A successful stream ends with a chunk whose finish_reason is set,
 *    followed by `data: [DONE]`.
 *  - A failed stream sends `data: {"error": {...}}` and ends WITHOUT `[DONE]`.
 *  - A stream that ends without `[DONE]` must be treated as interrupted.
 */

export interface SseEvent {
  event: string | null;
  data: string;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | null = null;
  private dataBytes = 0;

  constructor(
    private readonly onEvent: (ev: SseEvent) => void,
    private readonly maxEventBytes = 1024 * 1024,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxEventBytes) {
      throw new Error('SSE line exceeds maximum size');
    }
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      const sepLen = this.buffer.startsWith('\r\n', idx) ? 2 : 1;
      this.buffer = this.buffer.slice(idx + sepLen);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.dataLines.length > 0) {
        const data = this.dataLines.join('\n');
        const ev = { event: this.eventName, data };
        this.dataLines = [];
        this.eventName = null;
        this.dataBytes = 0;
        this.onEvent(ev);
      }
      this.eventName = null;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataBytes += value.length;
      if (this.dataBytes > this.maxEventBytes) throw new Error('SSE event exceeds maximum size');
      this.dataLines.push(value);
    } else if (field === 'event') {
      this.eventName = value;
    }
  }
}

/** Shape of stream chunks emitted by the gateway (OpenAI chunk + mesh extension). */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  mesh?: {
    gatewayPeerId: string;
    workerPeerId: string | null;
    route: 'local' | 'remote' | null;
    attempts?: Array<{ workerPeerId: string; route: 'local' | 'remote'; outcome: string }>;
    runtime?: 'llama.cpp' | 'fake';
  };
}
