import { useCallback, useMemo, useState } from 'react';
import { ChatView } from './components/ChatView';
import { GatewaysView } from './components/GatewaysView';
import { NetworkView, useSnapshot } from './components/NetworkView';
import { Moon } from './components/Moon';
import { uid, useChats, useGateways, usePersistent, type Message } from './store';

type Tab = 'chat' | 'network' | 'gateways';

export function App() {
  const [gateways, setGateways] = useGateways();
  const { chats, setChats, update } = useChats();
  const [activeId, setActiveId] = usePersistent<string | null>('wam.active', null);
  const [tab, setTab] = usePersistent<Tab>('wam.tab', 'chat');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [railOpen, setRailOpen] = useState(false);
  const onLabels = useCallback((l: Record<string, string>) => setLabels((p) => ({ ...p, ...l })), []);
  const primary = gateways[0];
  const { snap, error } = useSnapshot(primary, onLabels);
  const active = chats.find((c) => c.id === activeId) ?? null;
  const sorted = useMemo(() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt), [chats]);
  if (snap) labels[snap.status.peerId] ??= 'this gateway';

  const create = (first: Message) => {
    const id = uid();
    setChats((all) => [{ id, title: first.content.slice(0, 60), messages: [first], updatedAt: Date.now() }, ...all]);
    setActiveId(id);
    return id;
  };

  const exportAll = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), chats }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `werewolf-mesh-chats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const ready = snap?.status.runtime.ready;
  const peersUp = snap?.peers.filter((p) => p.available).length ?? 0;

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex items-center gap-3 border-b border-rule bg-sheet px-4 py-2.5 sm:px-6">
        <button className="rounded-md border border-rule px-2 py-1 text-sm md:hidden" onClick={() => setRailOpen((o) => !o)} aria-expanded={railOpen} aria-controls="rail">
          Chats
        </button>
        <span className="flex items-center gap-2">
          <Moon load={0.62} size={22} title="Werewolf AI Mesh" />
          <span className="font-display text-lg">Werewolf AI Mesh</span>
        </span>
        <nav className="ml-2 flex gap-1 text-sm" aria-label="Views">
          {(
            [
              ['chat', 'Chat'],
              ['network', 'Network'],
              ['gateways', 'Gateways'],
            ] as const
          ).map(([t, name]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-current={tab === t ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1 ${tab === t ? 'bg-ink text-paper' : 'text-slate hover:text-ink'}`}
            >
              {name}
            </button>
          ))}
        </nav>
        <span className="ml-auto hidden text-sm text-slate sm:inline" title={primary?.url}>
          {primary ? new URL(primary.url).host : 'no gateway'}
          {snap && (
            <>
              {' '}
              <span className={ready ? 'text-pine' : 'text-blood'}>{ready ? 'model ready' : 'model not ready'}</span>, {peersUp} peer{peersUp === 1 ? '' : 's'} can serve
            </>
          )}
        </span>
      </header>

      <div className="grid min-h-0 md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside
          id="rail"
          className={`${railOpen ? 'block' : 'hidden'} min-h-0 overflow-y-auto border-r border-rule bg-sheet p-3 md:block ${railOpen ? 'absolute inset-x-0 top-12 bottom-0 z-10' : ''}`}
        >
          <button
            className="w-full rounded-lg border border-ink px-3 py-2 text-left font-medium"
            onClick={() => {
              setActiveId(null);
              setTab('chat');
              setRailOpen(false);
            }}
          >
            New chat
          </button>
          <ul className="mt-3 space-y-0.5">
            {sorted.map((c) => (
              <li key={c.id} className="group flex items-center">
                <button
                  className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm ${c.id === activeId && tab === 'chat' ? 'bg-moon-soft text-ink' : 'text-slate hover:text-ink'}`}
                  onClick={() => {
                    setActiveId(c.id);
                    setTab('chat');
                    setRailOpen(false);
                  }}
                >
                  {c.title || 'Untitled'}
                </button>
                <button
                  className="px-1.5 text-xs text-slate opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Delete chat ${c.title}`}
                  onClick={() => setChats((all) => all.filter((x) => x.id !== c.id))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {chats.length > 0 && (
            <div className="mt-6 border-t border-rule pt-3 text-xs text-slate">
              <p>Chats are saved only in this browser. They are never shared with the mesh.</p>
              <div className="mt-2 flex gap-3">
                <button className="underline" onClick={exportAll}>
                  Export all
                </button>
                <button
                  className="text-blood underline"
                  onClick={() => {
                    if (confirm(`Delete all ${chats.length} chats from this browser?`)) {
                      setChats([]);
                      setActiveId(null);
                    }
                  }}
                >
                  Delete all
                </button>
              </div>
            </div>
          )}
        </aside>

        <main className="min-h-0">
          {tab === 'chat' && <ChatView chat={active} gateways={gateways} labels={labels} onUpdate={update} onCreate={create} />}
          {tab === 'network' && <NetworkView snap={snap} error={error} gateway={primary} />}
          {tab === 'gateways' && <GatewaysView gateways={gateways} setGateways={setGateways} />}
        </main>
      </div>
    </div>
  );
}
