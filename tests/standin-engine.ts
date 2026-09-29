/**
 * Stand-in for an external OpenAI-compatible engine (like ds4-server) in tests.
 * It streams `reasoning_content` then `content`, echoes the last user message
 * so tests can prove the prompt arrived, and records every request.
 *
 * Directives in the last user message: [[think=N]] reasoning chunks (default 0),
 * [[tokens=N]] answer chunks (default 6). `script` replaces the answer with
 * its own text (for example a code block), split into a few chunks.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StandIn {
  url: string;
  requests: any[];
  setDown(down: boolean): void;
  close(): Promise<void>;
}

export async function startStandInEngine(opts: { model?: string; apiKey?: string; script?: (body: any) => string | undefined } = {}): Promise<StandIn> {
  const model = opts.model ?? 'deepseek-v4-flash';
  const requests: any[] = [];
  let down = false;
  const server = http.createServer((req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', async () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const last = [...body.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
        const think = Number(/\[\[think=(\d+)\]\]/.exec(last)?.[1] ?? 0);
        const tokens = Number(/\[\[tokens=(\d+)\]\]/.exec(last)?.[1] ?? 6);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta: object, finish: string | null = null, extra = {}) =>
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
        let closed = false;
        res.on('close', () => (closed = true));
        const thinkingOff = body.reasoning_effort === 'none' || body.chat_template_kwargs?.enable_thinking === false;
        let n = 0;
        for (let i = 0; i < (thinkingOff ? 0 : think) && !closed; i++, n++) {
          send({ reasoning_content: `r${i} ` });
          await new Promise((r) => setTimeout(r, 1));
        }
        const echo = `echo(${last.replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 40)}) `;
        const scripted = opts.script?.(body);
        const parts = scripted !== undefined ? (scripted.match(/[\s\S]{1,40}/g) ?? []) : [echo, ...Array.from({ length: tokens - 1 }, (_, i) => `e${i} `)].slice(0, Math.min(tokens, body.max_tokens ?? 1e9));
        for (const p of parts) {
          if (closed) return;
          send({ content: p });
          n++;
          await new Promise((r) => setTimeout(r, 1));
        }
        send({}, 'stop', { usage: { prompt_tokens: 42, completion_tokens: n, total_tokens: 42 + n } });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setDown: (d) => {
      down = d;
      if (d) server.closeAllConnections();
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
