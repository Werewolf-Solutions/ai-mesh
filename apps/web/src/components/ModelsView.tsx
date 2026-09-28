import type { CatalogModelView } from '@werewolf-mesh/protocol';
import { useCallback, useEffect, useState } from 'react';
import { gb, ramGb, useCatalog } from '../models';
import type { Gateway } from '../store';

const STATE_TEXT: Record<string, string> = {
  serving: 'Running on this computer',
  installed: 'Downloaded, not running',
  not_installed: 'Not downloaded',
  downloading: 'Downloading',
  verifying: 'Checking the file',
  starting: 'Loading into memory',
  stopping: 'Stopping',
  failed: 'Failed',
};

export function ModelsView({ gateways }: { gateways: Gateway[] }) {
  const cat = useCatalog(gateways[0], 2500);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="font-display text-3xl tracking-tight">Models</h1>
        <p className="mt-2 max-w-[70ch] text-slate">
          The models the Werewolf mesh can run. Each is openly licensed, pinned to an exact file checked by SHA-256, and tested on the mesh's llama.cpp build. When
          your computer runs a model, anyone in the pack can use it through their own node, and your node can use models other computers run.
        </p>
        {cat.isOperator && <GpuCard gateway={gateways[0]} onChanged={() => void cat.refresh()} />}
        {!cat.isOperator && cat.models && (
          <p className="mt-3 rounded-lg border border-rule bg-sheet px-4 py-3 text-sm text-slate">
            You are viewing another operator's gateway, so you can see what the pack runs but not add models here. To run a model on your own computer, open your own
            node's page (for example http://127.0.0.1:8080).
          </p>
        )}
        {cat.error && <p className="mt-3 text-sm text-blood">{cat.error}</p>}
        {err && <p className="mt-3 text-sm text-blood">{err}</p>}

        <ul className="mt-6 space-y-3">
          {(cat.models ?? []).map((m) => (
            <li key={m.id} className="rounded-xl border border-rule bg-sheet p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-xl">
                  {m.name}
                  {m.thinking !== 'none' && <span className="ml-2 rounded bg-moon-soft px-1.5 align-middle font-sans text-xs">thinks</span>}
                </h2>
                <span className="num text-sm text-slate">
                  {m.available.nodes > 0 ? `served by ${m.available.nodes} node${m.available.nodes > 1 ? 's' : ''} you can reach` : 'not running in the pack'}
                </span>
              </div>
              <p className="mt-1 text-slate">{m.description}</p>
              <dl className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-slate">Download</dt>
                  <dd>{gb(m.downloadBytes)}</dd>
                </div>
                <div>
                  <dt className="text-slate">Memory</dt>
                  <dd>
                    ~{ramGb(m.ramMB)} <span className="text-slate">· GPU ~{ramGb(m.vramMB)}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate">Context</dt>
                  <dd>{m.contextTokens.toLocaleString()} tokens</dd>
                </div>
                <div>
                  <dt className="text-slate">Licence</dt>
                  <dd>{m.license}</dd>
                </div>
              </dl>
              {cat.isOperator && m.local && <LocalControls m={m} run={run} cat={cat} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} />}
            </li>
          ))}
        </ul>
        <p className="mt-8 max-w-[70ch] text-xs text-slate">
          Memory figures were measured with an 8k-token context and include the model runtime. Running several models at once adds their memory together. Speed on a
          CPU drops quickly with model size: the largest models answer a few words per second.
        </p>
      </div>
    </div>
  );
}

function LocalControls({
  m,
  run,
  cat,
  confirmDelete,
  setConfirmDelete,
}: {
  m: CatalogModelView;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  cat: ReturnType<typeof useCatalog>;
  confirmDelete: string | null;
  setConfirmDelete: (id: string | null) => void;
}) {
  const l = m.local!;
  const busy = l.state === 'downloading' || l.state === 'verifying' || l.state === 'starting' || l.state === 'stopping';
  const pct = l.progress ? Math.floor((l.progress.done / Math.max(1, l.progress.total)) * 100) : null;
  return (
    <div className="mt-4 border-t border-rule pt-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={l.state === 'serving' ? 'text-pine' : l.state === 'failed' ? 'text-blood' : 'text-slate'}>
          On this computer: {STATE_TEXT[l.state] ?? l.state}
          {l.state === 'downloading' && pct !== null ? ` ${pct}%` : ''}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {(l.state === 'not_installed' || l.state === 'installed' || l.state === 'failed') && l.fit.ok && (
            <button type="button" className="rounded-md bg-ink px-3 py-1 font-medium text-paper" onClick={() => void run(() => cat.install(m.id))}>
              {l.state === 'not_installed' ? `Download and run (${gb(m.downloadBytes)})` : 'Run on this computer'}
            </button>
          )}
          {l.state === 'downloading' && (
            <button type="button" className="rounded-md border border-rule px-3 py-1" onClick={() => void run(() => cat.cancel(m.id))}>
              Cancel download
            </button>
          )}
          {l.state === 'serving' && (
            <button type="button" className="rounded-md border border-rule px-3 py-1" onClick={() => void run(() => cat.unhost(m.id))}>
              Stop running it
            </button>
          )}
          {l.state === 'installed' &&
            (confirmDelete === m.id ? (
              <>
                <button type="button" className="rounded-md border border-blood px-3 py-1 text-blood" onClick={() => void run(() => cat.remove(m.id)).then(() => setConfirmDelete(null))}>
                  Delete {gb(m.downloadBytes)} file
                </button>
                <button type="button" className="px-2 py-1 text-slate" onClick={() => setConfirmDelete(null)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="rounded-md px-3 py-1 text-slate underline" onClick={() => setConfirmDelete(m.id)}>
                Delete the file
              </button>
            ))}
        </span>
      </div>
      {busy && (
        <div className="mt-2 h-1.5 w-full rounded-full bg-rule" aria-hidden>
          <div className="h-1.5 rounded-full bg-moon transition-[width]" style={{ width: `${pct ?? 100}%` }} />
        </div>
      )}
      {!l.fit.ok && l.state !== 'serving' && <p className="mt-2 text-sm text-blood">Can't run here: {l.fit.reasons.join('; ')}.</p>}
      {l.error && <p className="mt-2 text-sm text-blood">{l.error}</p>}
    </div>
  );
}

interface RuntimeView {
  accel: 'cpu' | 'cuda' | 'vulkan';
  gpus: Array<{ vendor: string; name: string; vramMB: number | null; freeMB: number | null; backends: Array<'cuda' | 'vulkan'> }>;
  builds: Array<{ backend: 'cuda' | 'vulkan'; installed: boolean; pinned: boolean; usable: boolean; requires: string | null }>;
  job: { backend: string; phase: 'downloading' | 'restarting'; done: number; total: number; error?: string } | null;
}

/** "This computer's GPU": the operator's switch for sharing a GPU with the pack. */
function GpuCard({ gateway, onChanged }: { gateway: Gateway | undefined; onChanged: () => void }) {
  const [rt, setRt] = useState<RuntimeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const headers = useCallback((): Record<string, string> => {
    const t = gateway?.adminToken || gateway?.token;
    return t ? { authorization: `Bearer ${t}` } : {};
  }, [gateway]);
  const load = useCallback(async () => {
    if (!gateway) return;
    const r = await fetch(`${gateway.url.replace(/\/$/, '')}/admin/runtime`, { headers: headers() }).catch(() => null);
    if (r?.ok) setRt((await r.json()) as RuntimeView);
  }, [gateway, headers]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);
  const set = async (accel: 'cpu' | 'cuda' | 'vulkan') => {
    setErr(null);
    const r = await fetch(`${gateway!.url.replace(/\/$/, '')}/admin/runtime`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ accel }) });
    if (!r.ok) setErr(((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${r.status}`);
    await load();
    onChanged();
  };
  if (!rt) return null;
  const gpu = rt.gpus[0];
  const onGpu = rt.accel !== 'cpu';
  const best = gpu?.backends.includes('cuda') ? 'cuda' : gpu?.backends[0];
  const build = rt.builds.find((b) => b.backend === best);
  return (
    <section className="mt-6 rounded-xl border border-moon/60 bg-sheet p-4" aria-labelledby="gpu-title">
      <h2 id="gpu-title" className="font-display text-xl">
        This computer's GPU
      </h2>
      {!gpu ? (
        <p className="mt-1 text-slate">No GPU found. Models run on the CPU. (NVIDIA cards need their driver; AMD and Intel need a Vulkan driver.)</p>
      ) : (
        <>
          <p className="mt-1">
            {gpu.name}
            {gpu.vramMB ? ` · ${(gpu.vramMB / 1024).toFixed(0)} GB` : ''}
            {gpu.freeMB !== null ? <span className="text-slate"> · {(gpu.freeMB / 1024).toFixed(1)} GB free</span> : null}
          </p>
          <p className="mt-1 text-sm text-slate">
            {onGpu
              ? `Your models run on the GPU (${rt.accel}). Nodes in the pack measure how fast your answers are and send you more work when you are faster than their own computer.`
              : 'Your models run on the CPU. Running them on the GPU makes answers several times faster (Qwen3 8B: about 6 → 58 tokens per second on an RTX 3060), and the pack will prefer your node for the models you run.'}
          </p>
          {rt.job && !rt.job.error && (
            <p className="num mt-2 text-sm">
              {rt.job.phase === 'downloading' ? `Downloading the GPU build of llama.cpp: ${(rt.job.done / 2 ** 20).toFixed(0)} MB (verified before use)` : 'Restarting your models…'}
            </p>
          )}
          {rt.job?.error && <p className="mt-2 text-sm text-blood">{rt.job.error}</p>}
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            {!onGpu && best && (
              <button type="button" disabled={!!rt.job && !rt.job.error} onClick={() => void set(best)} className="rounded-md bg-ink px-3 py-1.5 font-medium text-paper disabled:opacity-40">
                {build?.installed ? 'Use the GPU' : `Use the GPU (downloads the ${best.toUpperCase()} build first)`}
              </button>
            )}
            {onGpu && (
              <button type="button" disabled={!!rt.job && !rt.job.error} onClick={() => void set('cpu')} className="rounded-md border border-rule px-3 py-1.5 disabled:opacity-40">
                Go back to the CPU
              </button>
            )}
            {!onGpu && gpu.backends.length > 1 && (
              <button type="button" disabled={!!rt.job && !rt.job.error} onClick={() => void set('vulkan')} className="rounded-md px-3 py-1.5 text-slate underline disabled:opacity-40">
                Use Vulkan instead
              </button>
            )}
          </div>
          {err && <p className="mt-2 text-sm text-blood">{err}</p>}
        </>
      )}
    </section>
  );
}
