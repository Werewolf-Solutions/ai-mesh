import type { CatalogModelView } from '@werewolf-mesh/protocol';
import { useEffect, useRef, useState } from 'react';
import { EFFORTS, gb, ramGb, type Effort, type useCatalog } from '../models';

interface Props {
  /** Shared catalog state (one poll for the whole chat view). */
  cat: ReturnType<typeof useCatalog>;
  model: string | undefined;
  effort: Effort;
  onModel: (id: string) => void;
  onEffort: (e: Effort) => void;
  disabled?: boolean;
}

/** Model + effort chooser shown above the message box. */
export function ModelPicker({ cat, model, effort, onModel, onEffort, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const models = cat.models ?? [];
  const current = models.find((m) => m.id === model) ?? models.find((m) => m.available.local) ?? models.find((m) => m.available.nodes > 0);
  const ready = models.filter((m) => m.available.nodes > 0);
  const notRunning = models.filter((m) => m.available.nodes === 0);

  // Pick a sensible default once the catalog arrives.
  useEffect(() => {
    if (!model && current) onModel(current.id);
  }, [model, current, onModel]);

  // A model installed from here is selected as soon as it is served.
  useEffect(() => {
    if (pendingSelect && models.find((m) => m.id === pendingSelect)?.available.nodes) {
      onModel(pendingSelect);
      setPendingSelect(null);
    }
  }, [pendingSelect, models, onModel]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const thinks = current ? current.thinking !== 'none' : false;
  const unavailable = current && current.available.nodes === 0;

  return (
    <div ref={box} className="relative mx-auto mb-2 flex max-w-[72ch] flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-3 py-1.5 hover:border-moon disabled:opacity-50"
      >
        <span className="text-slate">Model</span>
        <span className="font-medium">{current?.name ?? 'Loading…'}</span>
        {current && current.thinking !== 'none' && <span className="rounded bg-moon-soft px-1.5 text-xs">thinks</span>}
        <span aria-hidden className="text-slate">▾</span>
      </button>

      <div role="radiogroup" aria-label="Effort" className="flex items-center gap-1" title={thinks ? 'How long the model thinks before answering' : 'This model has no thinking mode: effort only changes answer length'}>
        <span className="mr-1 text-slate">Effort</span>
        {EFFORTS.map((e) => (
          <button
            key={e.value}
            type="button"
            role="radio"
            aria-checked={effort === e.value}
            disabled={disabled}
            onClick={() => onEffort(e.value)}
            title={thinks ? e.thinks : e.plain}
            className={`rounded-full px-2.5 py-1 ${effort === e.value ? 'bg-ink text-paper' : 'text-slate hover:text-ink'}`}
          >
            {e.label}
          </button>
        ))}
      </div>
      {current && (
        <span className="basis-full text-xs text-slate">
          {unavailable
            ? 'No node you can reach is running this model right now.'
            : thinks
              ? EFFORTS.find((e) => e.value === effort)!.thinks
              : `No thinking mode: ${EFFORTS.find((e) => e.value === effort)!.plain.toLowerCase()}`}
          {current.available.nodes > 0 && ` Running on ${current.available.nodes} node${current.available.nodes > 1 ? 's' : ''} you can reach.`}
        </span>
      )}

      {open && (
        <div role="listbox" aria-label="Choose a model" className="absolute bottom-full left-0 z-20 mb-2 max-h-[65vh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-rule bg-sheet p-2 shadow-lg">
          {cat.error && <p className="p-2 text-blood">{cat.error}</p>}
          <Section title="Running in the pack">
            {ready.length === 0 && <p className="px-2 py-1 text-slate">Nothing yet.</p>}
            {ready.map((m) => (
              <ModelRow
                key={m.id}
                m={m}
                selected={m.id === current?.id}
                onPick={() => {
                  onModel(m.id);
                  setOpen(false);
                }}
              />
            ))}
          </Section>
          <Section title="Not running yet">
            {notRunning.map((m) => (
              <ModelRow key={m.id} m={m} selected={false}>
                <InstallControl
                  m={m}
                  operator={cat.isOperator}
                  onInstall={async () => {
                    setErr(null);
                    try {
                      await cat.install(m.id);
                      setPendingSelect(m.id);
                    } catch (e) {
                      setErr((e as Error).message);
                    }
                  }}
                  onCancel={() => void cat.cancel(m.id)}
                />
              </ModelRow>
            ))}
          </Section>
          {err && <p className="px-2 pb-2 text-blood">{err}</p>}
          <p className="px-2 pb-1 pt-2 text-xs text-slate">
            Only vetted, openly licensed models from the Werewolf catalog can run on the mesh. Every node serving a model keeps a full copy; your computer shares the
            work with the rest of the pack.
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className="px-2 pb-1 pt-1 text-xs text-slate">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ModelRow({ m, selected, onPick, children }: { m: CatalogModelView; selected: boolean; onPick?: () => void; children?: React.ReactNode }) {
  const body = (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{m.name}</span>
        {m.thinking !== 'none' && <span className="rounded bg-moon-soft px-1.5 text-xs">thinks</span>}
        <span className="num ml-auto text-xs text-slate">
          {m.available.nodes > 0 ? `${m.available.nodes} node${m.available.nodes > 1 ? 's' : ''}` : `${gb(m.downloadBytes)} · needs ~${ramGb(m.ramMB)} RAM`}
        </span>
      </div>
      <p className="text-xs text-slate">{m.description}</p>
    </>
  );
  if (onPick) {
    return (
      <button type="button" role="option" aria-selected={selected} onClick={onPick} className={`block w-full rounded-lg px-2 py-1.5 text-left ${selected ? 'bg-moon-soft' : 'hover:bg-paper'}`}>
        {body}
      </button>
    );
  }
  return (
    <div className="rounded-lg px-2 py-1.5">
      {body}
      {children}
    </div>
  );
}

function InstallControl({ m, operator, onInstall, onCancel }: { m: CatalogModelView; operator: boolean; onInstall: () => void; onCancel: () => void }) {
  if (!operator) return <p className="mt-1 text-xs text-slate">Not running anywhere you can reach. A node operator can add it from their Models page.</p>;
  const l = m.local!;
  if (l.state === 'downloading' || l.state === 'verifying' || l.state === 'starting') {
    const pct = l.progress ? Math.floor((l.progress.done / Math.max(1, l.progress.total)) * 100) : null;
    return (
      <div className="mt-1.5">
        <div className="h-1.5 w-full rounded-full bg-rule" aria-hidden>
          <div className="h-1.5 rounded-full bg-moon transition-[width]" style={{ width: `${pct ?? 100}%` }} />
        </div>
        <p className="num mt-1 flex justify-between text-xs text-slate">
          <span>
            {l.state === 'downloading' ? `Downloading ${pct}% of ${gb(m.downloadBytes)}` : l.state === 'verifying' ? 'Checking the file' : 'Loading into memory'}
          </span>
          {l.state === 'downloading' && (
            <button type="button" className="underline" onClick={onCancel}>
              Cancel
            </button>
          )}
        </p>
      </div>
    );
  }
  if (!l.fit.ok) return <p className="mt-1 text-xs text-blood">Can't run here: {l.fit.reasons.join('; ')}.</p>;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button type="button" onClick={onInstall} className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-paper">
        {l.state === 'installed' ? 'Run on this computer' : `Download and run on this computer (${gb(m.downloadBytes)})`}
      </button>
      {l.state === 'failed' && l.error && <span className="text-xs text-blood">Last try failed: {l.error}</span>}
    </div>
  );
}
