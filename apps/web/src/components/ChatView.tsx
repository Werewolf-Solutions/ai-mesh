import { MeshClient } from '@werewolf-mesh/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { uid, type Chat, type Gateway, type Message } from '../store';
import { NodeBadge } from './Moon';

interface Props {
  chat: Chat | null;
  gateways: Gateway[];
  labels: Record<string, string>;
  onUpdate: (id: string, fn: (c: Chat) => Chat) => void;
  onCreate: (first: Message) => string;
}

const STATUS_TEXT: Record<string, string> = {
  interrupted: 'Interrupted. The node answering stopped part-way; the text above is incomplete.',
  cancelled: 'Stopped.',
  failed: 'No answer.',
};

export function ChatView({ chat, gateways, labels, onUpdate, onCreate }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const client = useMemo(() => new MeshClient(gateways.map((g) => ({ url: g.url, token: g.token || g.adminToken || undefined, label: g.label }))), [gateways]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length, chat?.messages.at(-1)?.content]);

  /** Generate a NEW assistant answer for `history`. Never appends to an older answer. */
  async function run(chatId: string, history: Message[]) {
    const answerId = uid();
    onUpdate(chatId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, { id: answerId, role: 'assistant', content: '', status: 'streaming', at: Date.now() }] }));
    const patch = (p: Partial<Message>) =>
      onUpdate(chatId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === answerId ? { ...m, ...p } : m)) }));
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(true);
    try {
      const r = await client.chat({
        // Only complete exchanges are sent as context; interrupted/failed answers are left out.
        messages: history.filter((m) => m.role === 'user' || m.status === 'completed').map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 256,
        signal: ctl.signal,
        onToken: (_t, full) => patch({ content: full }),
        onMeta: (meta) => patch({ worker: meta.workerPeerId, route: meta.route, gatewayUrl: meta.gatewayUrl, runtime: meta.runtime }),
      });
      if (r.status === 'completed') patch({ content: r.text, status: 'completed', attempts: r.meta.attempts });
      else if (r.status === 'interrupted') patch({ content: r.text, status: 'interrupted', error: r.error.message, attempts: r.meta.attempts });
      else if (r.status === 'cancelled') patch({ content: r.text, status: 'cancelled' });
      else
        patch({
          status: 'failed',
          error: r.gatewayAttempts.length
            ? r.gatewayAttempts.map((a) => `${new URL(a.gatewayUrl).host}: ${a.error.message}`).join('\n')
            : r.error.message,
        });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    const msg: Message = { id: uid(), role: 'user', content: text, at: Date.now() };
    if (!chat) {
      const id = onCreate(msg);
      void run(id, [msg]);
    } else {
      onUpdate(chat.id, (c) => ({ ...c, messages: [...c.messages, msg] }));
      void run(chat.id, [...chat.messages, msg]);
    }
  }

  function retry(answer: Message) {
    if (!chat || busy) return;
    const idx = chat.messages.findIndex((m) => m.id === answer.id);
    void run(chat.id, chat.messages.slice(0, idx));
  }

  const messages = chat?.messages ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
        <div className="mx-auto max-w-[72ch] py-8">
          {messages.length === 0 && <EmptyState />}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="mb-6 flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-paper">{m.content}</p>
              </div>
            ) : (
              <article key={m.id} className="rise mb-8" aria-live={m.status === 'streaming' ? 'polite' : undefined}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {m.worker ? <NodeBadge peerId={m.worker} label={labels[m.worker]} route={m.route} /> : m.status === 'streaming' ? <span className="text-sm text-slate">Finding a node…</span> : null}
                  {m.runtime === 'fake' && <span className="rounded bg-blood px-1.5 text-xs text-paper">test runtime, not a model</span>}
                  {m.attempts && m.attempts.length > 1 && (
                    <span className="text-xs text-slate" title={m.attempts.map((a) => `${a.workerPeerId.slice(-6)}: ${a.outcome}`).join('\n')}>
                      answered after {m.attempts.length - 1} failed node{m.attempts.length > 2 ? 's' : ''}
                    </span>
                  )}
                </div>
                <div className={`whitespace-pre-wrap font-display text-[1.075rem] leading-[1.65] ${m.status === 'streaming' ? 'caret' : ''} ${m.status === 'interrupted' ? 'text-ink/75' : ''}`}>
                  {m.content}
                </div>
                {m.status && m.status !== 'streaming' && m.status !== 'completed' && (
                  <div className={`mt-3 flex flex-wrap items-center gap-3 border-l-2 pl-3 text-sm ${m.status === 'cancelled' ? 'border-rule text-slate' : 'border-blood text-blood'}`}>
                    <span className="whitespace-pre-wrap">{STATUS_TEXT[m.status]}{m.error && m.status !== 'cancelled' ? ` ${m.error}` : ''}</span>
                    <button type="button" disabled={busy} onClick={() => retry(m)} className="rounded-md border border-current px-2.5 py-0.5 font-medium disabled:opacity-40">
                      Retry as a new answer
                    </button>
                  </div>
                )}
              </article>
            ),
          )}
          <div ref={endRef} />
        </div>
      </div>
      <form
        className="border-t border-rule bg-sheet px-4 py-3 sm:px-8"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="mx-auto flex max-w-[72ch] items-end gap-2">
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <textarea
            id="composer"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask the pack…"
            className="min-h-[2.75rem] flex-1 resize-none rounded-xl border border-rule bg-paper px-3 py-2 text-ink placeholder:text-slate focus:border-moon focus:outline-none"
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="h-11 rounded-xl border border-ink px-4 font-medium">
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim()} className="h-11 rounded-xl bg-ink px-4 font-medium text-paper disabled:opacity-40">
              Send
            </button>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-[72ch] text-xs text-slate">
          SmolLM2-135M is a very small model: expect short, often wrong answers. Every node runs a full copy; more nodes add capacity, not intelligence.
        </p>
      </form>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-[12vh] text-center">
      <h1 className="font-display text-4xl tracking-tight sm:text-5xl">Ask the pack</h1>
      <p className="mx-auto mt-4 max-w-[46ch] text-slate">
        Your question goes to a gateway you chose, which hands it to whichever node in the mesh is free. You will see which node answered.
      </p>
    </div>
  );
}
