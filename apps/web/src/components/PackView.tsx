import { PrivateInput, Sensitive } from '../privacy';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { myTokens, PackApi, type NoteView, type PackStats } from '../pack';
import type { Gateway } from '../store';

const KIND_LABEL = { solution: 'Solved problem', howto: 'How-to', idea: 'Idea' } as const;

export function PackView({ gateways }: { gateways: Gateway[] }) {
  const api = useMemo(() => new PackApi(gateways), [gateways]);
  const isAdmin = !!gateways[0]?.adminToken || (gateways[0] ? /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(gateways[0].url) : false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [res, setRes] = useState<{ notes: NoteView[]; total: number; semantic: boolean } | null>(null);
  const [stats, setStats] = useState<PackStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState(myTokens());
  const [thanked, setThanked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.search(query, showHidden), api.stats()]);
      setRes(r);
      setStats(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, query, showHidden]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  // Group notes that the node merged as "the same problem".
  const groups = useMemo(() => {
    const m = new Map<string, NoteView[]>();
    for (const n of res?.notes ?? []) m.set(n.group, [...(m.get(n.group) ?? []), n]);
    return [...m.values()];
  }, [res]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setTokens(myTokens());
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="font-display text-3xl tracking-tight">Pack memory</h1>
        <p className="mt-2 max-w-[70ch] text-slate">
          What the pack has learned: problems people solved, how-tos and ideas, shared anonymously. Every node keeps its own full copy, so the memory survives any one
          node going away. Similar notes are grouped together, and notes that help answer questions rise to the top over time.
        </p>
        {stats && (
          <p className="num mt-3 text-sm text-slate">
            {stats.visible.toLocaleString()} notes on this node
            {stats.waitingToSpread ? `, ${stats.waitingToSpread} waiting a few minutes before spreading` : ''}
            {stats.withdrawn ? `, ${stats.withdrawn} withdrawn` : ''}
            {stats.lastSync ? `. Last exchange with the pack ${Math.max(0, Math.round((Date.now() - stats.lastSync.at) / 1000))} s ago${stats.lastSync.received ? `, ${stats.lastSync.received} new` : ''}.` : '. Not synced with other nodes yet.'}
          </p>
        )}

        <form
          className="mt-6 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q);
          }}
        >
          <label htmlFor="pack-search" className="sr-only">
            Search the pack memory
          </label>
          <PrivateInput
            id="pack-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={res?.semantic === false ? 'Search words…' : 'Describe a problem…'}
            className="min-w-0 flex-1 rounded-lg border border-rule bg-paper px-3 py-2 focus:border-moon focus:outline-none"
          />
          <button type="submit" className="rounded-lg bg-ink px-4 py-2 font-medium text-paper">
            Search
          </button>
          {query && (
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-slate"
              onClick={() => {
                setQ('');
                setQuery('');
              }}
            >
              Show all
            </button>
          )}
        </form>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate">
          <span>{res?.semantic ? 'Search matches by meaning.' : 'Search matches exact words (the meaning model is not installed on this gateway).'}</span>
          {isAdmin && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show notes hidden on this node
            </label>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-blood"><Sensitive>{error}</Sensitive></p>}

        {res && res.notes.length === 0 && (
          <div className="mt-10 max-w-[60ch]">
            <p className="font-display text-xl">{query ? 'Nothing in the pack matches that yet.' : 'The pack has not learned anything yet.'}</p>
            <p className="mt-2 text-slate">
              When an answer in Chat solves something, press “Share how with the pack”, or type “share this with the pack”. It will appear here and on every other node.
            </p>
          </div>
        )}

        <ul className="mt-6 space-y-4">
          {groups.map((g) => (
            <li key={g[0]!.group} className={g.length > 1 ? 'rounded-xl border border-rule p-3' : ''}>
              {g.length > 1 && <p className="mb-2 px-1 text-xs text-slate">{g.length} similar notes, merged as one problem</p>}
              <div className="space-y-3">
                {g.map((v) => {
                  const n = v.note;
                  const long = n.solution.length > 420;
                  const open = expanded.has(n.id);
                  return (
                    <article key={n.id} className={`rounded-xl bg-sheet p-4 ${v.hidden ? 'opacity-60' : ''}`}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h2 className="font-display text-lg leading-snug"><Sensitive>{n.title}</Sensitive></h2>
                        <span className="num text-xs text-slate">
                          {KIND_LABEL[n.kind]} · {n.day}
                          {v.similarity !== undefined ? ` · ${Math.round(v.similarity * 100)}% match` : ''}
                        </span>
                      </div>
                      {n.problem && <p className="mt-2 text-sm text-slate"><Sensitive>{n.problem}</Sensitive></p>}
                      <p className="mt-2 whitespace-pre-wrap font-display leading-[1.6]"><Sensitive>{long && !open ? n.solution.slice(0, 400) + '…' : n.solution}</Sensitive></p>
                      {long && (
                        <button
                          type="button"
                          className="mt-1 text-sm text-slate underline"
                          onClick={() =>
                            setExpanded((s) => {
                              const x = new Set(s);
                              if (x.has(n.id)) x.delete(n.id);
                              else x.add(n.id);
                              return x;
                            })
                          }
                        >
                          {open ? 'Show less' : 'Show all'}
                        </button>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                        {n.tags.map((t) => (
                          <span key={t} className="rounded-full bg-moon-soft px-2 py-0.5 text-xs">
                            <Sensitive>{t}</Sensitive>
                          </span>
                        ))}
                        <span className="num text-xs text-slate">{v.uses ? `helped answer ${v.uses} question${v.uses > 1 ? 's' : ''} here` : 'not used yet'}</span>
                        <span className="ml-auto flex gap-2">
                          <button type="button" disabled={thanked.has(n.id)} className="rounded-md border border-rule px-2 py-0.5 text-xs disabled:opacity-50" onClick={() => void act(async () => { await api.helped(n.id); setThanked((s) => new Set(s).add(n.id)); })}>
                            {thanked.has(n.id) ? 'Thanks, noted' : 'This helped'}
                          </button>
                          {tokens[n.id] && (
                            <button type="button" className="rounded-md border border-blood px-2 py-0.5 text-xs text-blood" onClick={() => void act(() => api.withdraw(n.id))}>
                              Withdraw my note
                            </button>
                          )}
                          {isAdmin && (
                            <button type="button" className="rounded-md border border-rule px-2 py-0.5 text-xs" onClick={() => void act(() => api.hide(n.id, !v.hidden))}>
                              {v.hidden ? 'Show on this node' : 'Hide on this node'}
                            </button>
                          )}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-8 max-w-[70ch] text-xs text-slate">
          Notes carry no name, node or time of day, and only the browser that shared a note can withdraw it. The operator of a gateway can still read what passes through
          it, and notes may be wrong: treat them as tips from strangers. “This helped” only changes the ranking on this node.
        </p>
      </div>
    </div>
  );
}
