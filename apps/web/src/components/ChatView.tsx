import { MeshClient } from '@werewolf-mesh/client';
import { isShareIntent } from '@werewolf-mesh/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PackApi, titleFrom } from '../pack';
import { uid, usePersistent, type Chat, type Gateway, type Message } from '../store';
import { useCatalog, type Effort } from '../models';
import { ModelPicker } from './ModelPicker';
import { NodeBadge } from './Moon';
import { ShareCard } from './ShareCard';

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

/** The question an answer responds to: the closest earlier real user message. */
function questionFor(messages: Message[], answerIdx: number): string {
  for (let i = answerIdx - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.meta) return m.content;
  }
  return '';
}

export function ChatView({ chat, gateways, labels, onUpdate, onCreate }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  const [thanked, setThanked] = useState<Set<string>>(new Set());
  const [model, setModel] = usePersistent<string | undefined>('wam.model', undefined);
  const [effort, setEffort] = usePersistent<Effort>('wam.effort', 'low');
  const [openThinking, setOpenThinking] = useState<Set<string>>(new Set());
  const [webOn, setWebOn] = usePersistent<boolean>('wam.web', false);
  const [openSteps, setOpenSteps] = useState<Set<string>>(new Set());
  const cat = useCatalog(gateways[0]);
  const modelName = (id: string) => cat.models?.find((x) => x.id === id)?.name ?? id;
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const client = useMemo(() => new MeshClient(gateways.map((g) => ({ url: g.url, token: g.token || g.adminToken || undefined, label: g.label }))), [gateways]);
  const pack = useMemo(() => new PackApi(gateways), [gateways]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length, chat?.messages.at(-1)?.content, sharing]);

  /** Generate a NEW assistant answer for `history`. Never appends to an older answer. */
  async function run(chatId: string, history: Message[]) {
    const answerId = uid();
    onUpdate(chatId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, { id: answerId, role: 'assistant', content: '', status: 'streaming', at: Date.now() }] }));
    const patch = (p: Partial<Message>) =>
      onUpdate(chatId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === answerId ? { ...m, ...p } : m)) }));
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(true);
    const t0 = performance.now();
    let thinkStart = 0;
    let thinkEnd = 0;
    try {
      const r = await client.chat({
        model,
        effort,
        // Toggle on: always search first. Off: only when the message asks for it ("search the web…", a link).
        web: webOn ? 'on' : 'auto',
        onStep: (_s, all) => patch({ steps: all }),
        onReasoning: (_t, full) => {
          thinkStart ||= performance.now();
          patch({ reasoning: full });
        },
        // Only complete exchanges are sent as context; interrupted/failed answers and UI-only messages are left out.
        messages: history.filter((m) => !m.meta && (m.role === 'user' || m.status === 'completed')).map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 512,
        signal: ctl.signal,
        onToken: (_t, full) => {
          if (thinkStart && !thinkEnd) {
            thinkEnd = performance.now();
            patch({ thinkingMs: Math.round(thinkEnd - t0) });
          }
          patch({ content: full });
        },
        onMeta: (meta) => patch({ worker: meta.workerPeerId, route: meta.route, gatewayUrl: meta.gatewayUrl, runtime: meta.runtime }),
      });
      const notes = r.status === 'completed' || r.status === 'interrupted' ? r.meta.packNotes : undefined;
      const web = r.status === 'completed' || r.status === 'interrupted' ? r.meta.web : undefined;
      const extra =
        r.status === 'completed' || r.status === 'interrupted'
          ? {
              reasoning: r.reasoning || undefined,
              model: r.meta.model,
              effort: r.meta.effort,
              ...(web ? { steps: web.steps.map((s) => (s.kind === 'answer' ? { ...s, status: 'done' as const, text: s.text.replace(/^Writing/, 'Wrote') } : s)), sources: web.sources, webQuery: web.query } : {}),
            }
          : {};
      if (r.status === 'completed') patch({ content: r.text, status: 'completed', attempts: r.meta.attempts, ...extra, ...(notes ? { packNotes: notes } : {}) });
      else if (r.status === 'interrupted') patch({ content: r.text, status: 'interrupted', error: r.error.message, attempts: r.meta.attempts, ...extra });
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

  /** "Share this with the pack" typed in the chat: share the latest completed answer right away (with Undo). */
  async function shareFromChat(c: Chat, request: Message) {
    const idx = [...c.messages].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'assistant' && m.status === 'completed' && !m.meta)?.i;
    const card: Message = { id: uid(), role: 'assistant', content: '', meta: true, at: Date.now() };
    if (idx === undefined) {
      onUpdate(c.id, (x) => ({ ...x, messages: [...x.messages, request, { ...card, packCard: { noteId: '', title: '', removed: [], error: 'There is no finished answer in this chat to share yet.' } }] }));
      return;
    }
    const answer = c.messages[idx]!;
    const question = questionFor(c.messages, idx);
    onUpdate(c.id, (x) => ({ ...x, messages: [...x.messages, request] }));
    try {
      const r = await pack.share({ kind: 'solution', title: titleFrom(question), problem: question.slice(0, 1000), solution: answer.content.slice(0, 2000), tags: [] });
      onUpdate(c.id, (x) => ({
        ...x,
        messages: [...x.messages.map((m) => (m.id === answer.id ? { ...m, sharedNoteId: r.id } : m)), { ...card, packCard: { noteId: r.id, title: r.note.title, removed: r.removed } }],
      }));
    } catch (e) {
      onUpdate(c.id, (x) => ({ ...x, messages: [...x.messages, { ...card, packCard: { noteId: '', title: '', removed: [], error: (e as Error).message } }] }));
    }
  }

  function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    const msg: Message = { id: uid(), role: 'user', content: text, at: Date.now() };
    if (chat && isShareIntent(text)) {
      void shareFromChat(chat, { ...msg, meta: true });
      return;
    }
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

  async function withdraw(cardMsg: Message) {
    if (!chat || !cardMsg.packCard) return;
    const noteId = cardMsg.packCard.noteId;
    try {
      await pack.withdraw(noteId);
      onUpdate(chat.id, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === cardMsg.id ? { ...m, packCard: { ...m.packCard!, withdrawn: true } } : m.sharedNoteId === noteId ? { ...m, sharedNoteId: undefined } : m,
        ),
      }));
    } catch (e) {
      onUpdate(chat.id, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === cardMsg.id ? { ...m, packCard: { ...m.packCard!, error: (e as Error).message } } : m)) }));
    }
  }

  const messages = chat?.messages ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
        <div className="mx-auto max-w-[72ch] py-8">
          {messages.length === 0 && <EmptyState />}
          {messages.map((m, idx) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} className="mb-6 flex justify-end">
                  <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm px-4 py-2.5 ${m.meta ? 'border border-moon text-ink' : 'bg-ink text-paper'}`}>{m.content}</p>
                </div>
              );
            }
            if (m.packCard) return <PackCardView key={m.id} m={m} onWithdraw={() => void withdraw(m)} />;
            const done = m.status === 'completed';
            return (
              <article key={m.id} className="rise mb-8" aria-live={m.status === 'streaming' ? 'polite' : undefined}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {m.worker ? (
                    <NodeBadge peerId={m.worker} label={labels[m.worker]} route={m.route} />
                  ) : m.status === 'streaming' && !m.steps?.length ? (
                    <span className="text-sm text-slate">Finding a node…</span>
                  ) : null}
                  {m.model && <span className="text-xs text-slate">{modelName(m.model)}{m.effort ? ` · ${m.effort === 'none' || m.effort === 'minimal' ? 'fast' : m.effort === 'low' ? 'balanced' : m.effort === 'high' ? 'thorough' : m.effort}` : ''}</span>}
                  {m.runtime === 'fake' && <span className="rounded bg-blood px-1.5 text-xs text-paper">test runtime, not a model</span>}
                  {m.attempts && m.attempts.length > 1 && (
                    <span className="text-xs text-slate" title={m.attempts.map((a) => `${a.workerPeerId.slice(-6)}: ${a.outcome}`).join('\n')}>
                      answered after {m.attempts.length - 1} failed node{m.attempts.length > 2 ? 's' : ''}
                    </span>
                  )}
                  {m.packNotes && m.packNotes.length > 0 && (
                    <button type="button" className="rounded-full border border-moon px-2 py-0.5 text-xs" aria-expanded={notesOpen !== m.id} onClick={() => setNotesOpen(notesOpen === m.id ? null : m.id)}>
                      {notesOpen === m.id ? 'show' : 'hide'} {m.packNotes.length} pack note{m.packNotes.length > 1 ? 's' : ''}
                    </button>
                  )}
                </div>
                {notesOpen !== m.id && m.packNotes && m.packNotes.length > 0 && (
                  <div className="mb-3 rounded-lg border-l-2 border-moon bg-sheet p-3 text-sm">
                    <p className="text-slate">From the pack’s memory (shared anonymously, may be wrong). The model was given this, but a small model can ignore it:</p>
                    <ul className="mt-2 space-y-3">
                      {m.packNotes.map((n) => (
                        <li key={n.id} className="grid gap-1">
                          <span className="font-medium">{n.title}</span>
                          {n.solution && <span className="whitespace-pre-wrap font-display leading-[1.55]">{n.solution}</span>}
                          <button
                            type="button"
                            disabled={thanked.has(n.id)}
                            className="justify-self-start rounded-md border border-rule px-2 py-0.5 text-xs disabled:opacity-50"
                            onClick={() => void pack.helped(n.id).then(() => setThanked((s) => new Set(s).add(n.id)))}
                          >
                            {thanked.has(n.id) ? 'Thanks, noted' : 'This helped'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {m.steps && m.steps.length > 0 && (
                  <WebSteps
                    m={m}
                    open={m.status === 'streaming' || openSteps.has(m.id)}
                    onToggle={() => setOpenSteps((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                  />
                )}
                {m.reasoning && (
                  <div className="mb-3 border-l-2 border-rule pl-3 text-sm">
                    {m.status === 'streaming' && !m.content ? (
                      <>
                        <p className="text-slate">Thinking…</p>
                        {/* column-reverse keeps the newest thinking in view while it streams */}
                        <div className="mt-1 flex max-h-40 flex-col-reverse overflow-y-auto">
                          <p className="caret whitespace-pre-wrap text-slate">{m.reasoning.slice(-1500)}</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="text-slate underline decoration-rule underline-offset-2 hover:text-ink"
                          aria-expanded={openThinking.has(m.id)}
                          onClick={() => setOpenThinking((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                        >
                          {m.thinkingMs ? `Thought for ${(m.thinkingMs / 1000).toFixed(m.thinkingMs < 10_000 ? 1 : 0)} s` : 'Thinking'} · {openThinking.has(m.id) ? 'hide' : 'show'}
                        </button>
                        {openThinking.has(m.id) && <p className="mt-1 whitespace-pre-wrap text-slate">{m.reasoning}</p>}
                      </>
                    )}
                  </div>
                )}
                <div className={`whitespace-pre-wrap font-display text-[1.075rem] leading-[1.65] ${m.status === 'streaming' && (m.content || !m.reasoning) ? 'caret' : ''} ${m.status === 'interrupted' ? 'text-ink/75' : ''}`}>
                  {m.sources?.length ? <Cited text={m.content} sources={m.sources} /> : m.content}
                </div>
                {m.sources && m.sources.length > 0 && m.status !== 'streaming' && <SourceList sources={m.sources} />}
                {m.status && m.status !== 'streaming' && !done && (
                  <div className={`mt-3 flex flex-wrap items-center gap-3 border-l-2 pl-3 text-sm ${m.status === 'cancelled' ? 'border-rule text-slate' : 'border-blood text-blood'}`}>
                    <span className="whitespace-pre-wrap">{STATUS_TEXT[m.status]}{m.error && m.status !== 'cancelled' ? ` ${m.error}` : ''}</span>
                    <button type="button" disabled={busy} onClick={() => retry(m)} className="rounded-md border border-current px-2.5 py-0.5 font-medium disabled:opacity-40">
                      Retry as a new answer
                    </button>
                  </div>
                )}
                {done && sharing !== m.id && (
                  <div className="mt-2 text-sm">
                    {m.sharedNoteId ? (
                      <span className="text-pine">Shared with the pack</span>
                    ) : (
                      <button type="button" className="text-slate underline decoration-moon underline-offset-2 hover:text-ink" onClick={() => setSharing(m.id)}>
                        Solved something? Share how with the pack
                      </button>
                    )}
                  </div>
                )}
                {sharing === m.id && chat && (
                  <ShareCard
                    gateways={gateways}
                    question={questionFor(messages, idx)}
                    answer={m.content}
                    onCancel={() => setSharing(null)}
                    onDone={(r) => {
                      setSharing(null);
                      onUpdate(chat.id, (c) => ({ ...c, messages: c.messages.map((x) => (x.id === m.id ? { ...x, sharedNoteId: r.id } : x)) }));
                    }}
                  />
                )}
              </article>
            );
          })}
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
        <ModelPicker cat={cat} model={model} effort={effort} onModel={setModel} onEffort={setEffort} disabled={busy} />
        <div className="mx-auto flex max-w-[72ch] items-end gap-2">
          <button
            type="button"
            aria-pressed={webOn}
            onClick={() => setWebOn(!webOn)}
            title={webOn ? 'Every question is searched on the web first (from this computer, through your own search engine)' : 'Web search only when you ask for it ("search the web for…", or paste a link)'}
            className={`flex h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm ${webOn ? 'border-moon bg-moon-soft text-ink' : 'border-rule text-slate hover:text-ink'}`}
          >
            <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M2.5 10h15M10 2.5c2.2 2.3 3.2 4.8 3.2 7.5s-1 5.2-3.2 7.5c-2.2-2.3-3.2-4.8-3.2-7.5s1-5.2 3.2-7.5z" />
            </svg>
            <span>Web{webOn ? ' on' : ''}</span>
          </button>
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
            placeholder={webOn ? 'Ask anything: the web is searched first…' : 'Ask the pack…  (“search the web for …” or a link searches the web)'}
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
          Small models make mistakes, especially without thinking. Every node serving a model runs a full copy; more nodes add capacity, not intelligence.
        </p>
      </form>
    </div>
  );
}

const STEP_MARK = { running: '◌', done: '✓', failed: '✕' } as const;

function WebSteps({ m, open, onToggle }: { m: Message; open: boolean; onToggle: () => void }) {
  const steps = m.steps!;
  const pages = m.sources?.filter((s) => s.kind === 'page').length ?? 0;
  const failed = steps.some((s) => s.status === 'failed');
  const summary = m.webQuery ? `Searched the web for “${m.webQuery}”` : 'Read the linked page';
  return (
    <div className="mb-3 border-l-2 border-moon pl-3 text-sm">
      {m.status !== 'streaming' && (
        <button type="button" className="text-slate underline decoration-rule underline-offset-2 hover:text-ink" aria-expanded={open} onClick={onToggle}>
          {summary}
          {pages ? ` · read ${pages} page${pages > 1 ? 's' : ''}` : ''}
          {failed ? ' · some steps failed' : ''} · {open ? 'hide steps' : 'show steps'}
        </button>
      )}
      {open && (
        <ol className="mt-1 space-y-0.5">
          {steps
            .filter((s) => !(s.kind === 'query' && s.status === 'done'))
            .map((s, i) => (
              <li key={i} className={`flex gap-2 ${s.status === 'failed' ? 'text-blood' : s.status === 'running' ? 'text-ink' : 'text-slate'}`}>
                <span aria-hidden className={s.status === 'running' ? 'animate-pulse' : ''}>
                  {STEP_MARK[s.status]}
                </span>
                <span>
                  {s.text}
                  <span className="sr-only"> ({s.status})</span>
                </span>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}

const safeHref = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

/** Answer text with [n] turned into links to the n-th source. */
function Cited({ text, sources }: { text: string; sources: NonNullable<Message['sources']> }) {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const n = /^\[(\d{1,2})\]$/.exec(p)?.[1];
        const src = n ? sources.find((s) => s.n === Number(n)) : undefined;
        if (!src) return p;
        return (
          <a key={i} href={safeHref(src.url)} target="_blank" rel="noopener noreferrer" title={`${src.title} (${hostOf(src.url)})`} className="align-super font-sans text-xs text-moon no-underline hover:underline">
            [{n}]
          </a>
        );
      })}
    </>
  );
}

function SourceList({ sources }: { sources: NonNullable<Message['sources']> }) {
  return (
    <div className="mt-3 text-sm">
      <p className="text-slate">Sources (from the web, not checked by anyone):</p>
      <ol className="mt-1 space-y-0.5">
        {sources.map((s) => (
          <li key={s.n} className="flex gap-2">
            <span className="num text-slate">[{s.n}]</span>
            <span className="min-w-0">
              <a href={safeHref(s.url)} target="_blank" rel="noopener noreferrer" className="underline decoration-rule underline-offset-2 hover:decoration-moon">
                {s.title}
              </a>{' '}
              <span className="text-slate">
                {hostOf(s.url)}
                {s.kind === 'snippet' ? ' · summary only' : ''}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PackCardView({ m, onWithdraw }: { m: Message; onWithdraw: () => void }) {
  const c = m.packCard!;
  if (!c.noteId) {
    return <p className="mb-8 border-l-2 border-blood pl-3 text-sm text-blood">Not shared: {c.error}</p>;
  }
  return (
    <div className="rise mb-8 rounded-xl border border-moon/60 bg-sheet p-4 text-sm">
      {c.withdrawn ? (
        <p className="text-slate">Withdrawn. The note is being removed from every node in the pack.</p>
      ) : (
        <>
          <p>
            <span className="font-display text-base">Shared anonymously with the pack:</span> “{c.title}”
          </p>
          <p className="mt-1 text-slate">
            Only this question and answer were shared, without your name, node or the time of day. It reaches the other nodes within a few minutes.
            {c.removed.length > 0 ? ` Removed first: ${c.removed.join(', ')}.` : ''}
          </p>
          <button type="button" className="mt-2 rounded-md border border-rule px-2.5 py-1" onClick={onWithdraw}>
            Undo
          </button>
          {c.error && <p className="mt-2 text-blood">{c.error}</p>}
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-[12vh] text-center">
      <h1 className="font-display text-4xl tracking-tight sm:text-5xl">Ask the pack</h1>
      <p className="mx-auto mt-4 max-w-[46ch] text-slate">
        Your question goes to a gateway you chose, which hands it to whichever node in the mesh is free. Solved something? Share how, and every node remembers it.
      </p>
    </div>
  );
}
