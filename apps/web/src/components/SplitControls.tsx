import { Sensitive, usePrivacy } from '../privacy';
import type { CatalogModelView } from '@werewolf-mesh/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { Gateway } from '../store';

/** GET /admin/split */
export interface SplitView {
  accel: 'cpu' | 'cuda' | 'vulkan';
  lend: {
    enabled: boolean;
    peers: string[];
    device: 'cpu' | 'gpu';
    running: boolean;
    detail: string;
    tunnels: { active: number; total: number; refused: number };
  };
  borrow: { peers: Array<{ peerId: string; label: string | null; connected: boolean; lends: boolean; reason: string | null }> };
  models: Array<{ id: string; split: string[] }>;
}

export function useSplit(gateway: Gateway | undefined, enabled: boolean) {
  const [view, setView] = useState<SplitView | null>(null);
  const base = gateway?.url.replace(/\/$/, '') ?? '';
  const headers = useCallback((): Record<string, string> => {
    const t = gateway?.adminToken || gateway?.token;
    return t ? { authorization: `Bearer ${t}` } : {};
  }, [gateway]);
  const load = useCallback(async () => {
    if (!gateway || !enabled) return;
    const r = await fetch(`${base}/admin/split`, { headers: headers() }).catch(() => null);
    if (r?.ok) setView((await r.json()) as SplitView);
  }, [gateway, enabled, base, headers]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${r.status}`);
    await load();
  };
  return { view, post, reload: load };
}

const name = (p: { peerId: string; label: string | null }) => p.label ?? `…${p.peerId.slice(-6)}`;

/** Operator card: lend this computer's memory to chosen peers. */
export function LendCard({ split }: { split: ReturnType<typeof useSplit> }) {
  const v = split.view;
  const gpuAvailable = v?.accel !== undefined && v.accel !== 'cpu';
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [device, setDevice] = useState<'cpu' | 'gpu' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { mask } = usePrivacy();
  if (!v) return null;
  const peers = v.borrow.peers;
  const sel = chosen ?? new Set(v.lend.peers);
  const dev = device ?? v.lend.device;
  const dirty = chosen !== null || device !== null;
  const save = async (enabled: boolean) => {
    setErr(null);
    try {
      await split.post('/admin/split/lend', { enabled, peers: [...sel], device: dev });
      setChosen(null);
      setDevice(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="mt-4 rounded-xl border border-rule bg-sheet p-4" aria-labelledby="lend-title">
      <h2 id="lend-title" className="font-display text-xl">
        Lend this computer's memory
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm text-slate">
        A model too big for one computer can be split: part of it runs here, part on another computer. Choose which computers may place part of a model in this one's
        memory. They can then run low-level computations here, so only choose computers you trust as much as someone with a login on this machine.
      </p>
      {peers.length === 0 ? (
        <p className="mt-2 text-sm text-slate">No approved peers yet (./mesh peers approve).</p>
      ) : (
        <fieldset className="mt-3">
          <legend className="text-sm text-slate">Computers allowed to use this one's memory</legend>
          <ul className="mt-1 space-y-1 text-sm">
            {peers.map((p) => (
              <li key={p.peerId}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sel.has(p.peerId)}
                    onChange={(e) => {
                      const n = new Set(sel);
                      if (e.target.checked) n.add(p.peerId);
                      else n.delete(p.peerId);
                      setChosen(n);
                    }}
                  />
                  <span><Sensitive>{name(p)}</Sensitive></span>
                  <span className="text-xs text-slate" title={mask(p.peerId)}>
                    {p.connected ? 'connected' : 'not connected'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {gpuAvailable && (
        <div className="mt-3 flex gap-4 text-sm" role="radiogroup" aria-label="Memory to lend">
          {(['cpu', 'gpu'] as const).map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="radio" name="lend-device" checked={dev === d} onChange={() => setDevice(d)} />
              {d === 'cpu' ? 'RAM (runs on the CPU)' : 'GPU memory (runs on the GPU)'}
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {v.lend.enabled ? (
          <>
            <span className="text-pine"><Sensitive>{v.lend.detail}</Sensitive></span>
            {v.lend.tunnels.active > 0 && <span className="text-slate">· in use by {v.lend.tunnels.active} connection{v.lend.tunnels.active > 1 ? 's' : ''}</span>}
            {dirty && (
              <button type="button" className="rounded-md bg-ink px-3 py-1 font-medium text-paper" onClick={() => void save(true)}>
                Save changes
              </button>
            )}
            <button type="button" className="rounded-md border border-rule px-3 py-1" onClick={() => void save(false)}>
              Stop lending
            </button>
          </>
        ) : (
          <button type="button" disabled={sel.size === 0} className="rounded-md bg-ink px-3 py-1 font-medium text-paper disabled:opacity-40" onClick={() => void save(true)}>
            {sel.size ? `Lend to ${sel.size} computer${sel.size === 1 ? '' : 's'}` : 'Choose who may use it'}
          </button>
        )}
      </div>
      {err && <p className="mt-2 text-sm text-blood"><Sensitive>{err}</Sensitive></p>}
    </section>
  );
}

/** Per model: split it across lending computers. */
export function SplitModel({ m, split }: { m: CatalogModelView; split: ReturnType<typeof useSplit> }) {
  const v = split.view;
  const current = m.local?.split ?? [];
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set(current));
  const [share, setShare] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { mask } = usePrivacy();
  if (!v) return null;
  const lenders = v.borrow.peers.filter((p) => p.lends || current.includes(p.peerId));
  if (!lenders.length && !current.length) return null;
  const apply = async (peers: string[]) => {
    setErr(null);
    try {
      await split.post(`/admin/models/${m.id}/split`, { peers, ...(peers.length && share !== null ? { localShare: share / 100 } : {}) });
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mt-2 text-sm">
      {current.length > 0 && !open && (
        <p className="text-slate">
          Split with {mask(current.map((id) => name(v.borrow.peers.find((p) => p.peerId === id) ?? { peerId: id, label: null })).join(', '))}.{' '}
          <Sensitive>{/split: |fits|waiting/.test(m.local?.detail ?? '') ? (m.local!.detail!.split(/split: /)[1] ?? m.local!.detail!.replace(/^.*?\.gguf, /, '')) : ''}</Sensitive>
        </p>
      )}
      {!open ? (
        <button type="button" className="text-slate underline decoration-rule underline-offset-2 hover:text-ink" onClick={() => setOpen(true)}>
          {current.length ? 'Change the split' : 'Split across other computers…'}
        </button>
      ) : (
        <fieldset className="mt-2 rounded-lg border border-rule p-3">
          <legend className="px-1 text-slate">Split {m.name} across</legend>
          <ul className="space-y-1">
            {v.borrow.peers.map((p) => (
              <li key={p.peerId}>
                <label className={`flex items-center gap-2 ${p.lends ? '' : 'text-slate'}`}>
                  <input
                    type="checkbox"
                    disabled={!p.lends && !chosen.has(p.peerId)}
                    checked={chosen.has(p.peerId)}
                    onChange={(e) => {
                      const n = new Set(chosen);
                      if (e.target.checked) n.add(p.peerId);
                      else n.delete(p.peerId);
                      setChosen(n);
                    }}
                  />
                  <Sensitive>{name(p)}</Sensitive> <span className="text-xs text-slate">{p.lends ? 'lends memory' : mask(p.reason)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={share === null} onChange={(e) => setShare(e.target.checked ? null : 50)} />
              Automatic: use this computer first, the others only for what does not fit
            </label>
            {share !== null && (
              <label className="mt-2 flex items-center gap-3">
                <span className="num w-28">{share}% here</span>
                <input type="range" min={10} max={90} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} className="flex-1" />
              </label>
            )}
          </div>
          <p className="mt-2 text-xs text-slate">
            A split model runs at about the speed of its slowest part and needs a fast, direct network between the computers. Use it for models that do not fit on one
            computer. Answers in progress on this model are interrupted while it restarts.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={!chosen.size} className="rounded-md bg-ink px-3 py-1 font-medium text-paper disabled:opacity-40" onClick={() => void apply([...chosen])}>
              Split and restart
            </button>
            {current.length > 0 && (
              <button type="button" className="rounded-md border border-rule px-3 py-1" onClick={() => void apply([])}>
                Run only here
              </button>
            )}
            <button type="button" className="px-2 py-1 text-slate" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {err && <p className="mt-2 text-blood"><Sensitive>{err}</Sensitive></p>}
        </fieldset>
      )}
    </div>
  );
}
