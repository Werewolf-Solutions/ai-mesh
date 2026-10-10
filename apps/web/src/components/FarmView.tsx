import { PrivateTextarea, usePrivacy } from '../privacy';
import { useCallback, useEffect, useState } from 'react';
import { FarmPolicy, FarmSubmit, type FarmPolicy as Policy, type FarmStatus } from '@werewolf-mesh/protocol';
import { FarmClient, type FarmJob } from '@werewolf-mesh/client';
import type { Gateway } from '../store';

interface View { policy: Policy; active: boolean; cleanupReady: boolean; jobs: FarmStatus[]; outgoing: FarmJob[] }

export function FarmView({ gateways }: { gateways: Gateway[] }) {
  const { hidden, mask } = usePrivacy();
  const gateway = gateways[0];
  const [view, setView] = useState<View | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState('');
  const [packageText, setPackageText] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [result, setResult] = useState<FarmJob | null>(null);
  const [busy, setBusy] = useState(false);
  const headers = useCallback((): Record<string, string> => {
    const token = gateway?.adminToken || gateway?.token;
    return token ? { authorization: `Bearer ${token}` } : {};
  }, [gateway]);
  const load = useCallback(async () => {
    if (!gateway) return;
    try {
      const r = await fetch(`${gateway.url.replace(/\/$/, '')}/admin/farm`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error((await r.json() as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`);
      setView(await r.json() as View); setError('');
    } catch (e) { setError((e as Error).message); }
  }, [gateway, headers]);
  useEffect(() => {
    setView(null); setPolicy(null); void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => clearInterval(timer);
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const client = gateway ? new FarmClient({ url: gateway.url, token: gateway.adminToken || gateway.token }) : null;
  let parsed: ReturnType<typeof FarmSubmit.safeParse> | null = null;
  if (packageText) { try { parsed = FarmSubmit.safeParse(JSON.parse(packageText)); } catch { /* invalid editor input */ } }
  const draft = policy ?? view?.policy;
  const button = 'rounded-md border border-rule px-3 py-1 disabled:opacity-40';
  return <div className="mx-auto max-w-5xl space-y-5 p-6">
    <h1 className="font-display text-2xl">Coding farm</h1>
    <p className="max-w-[75ch] text-sm text-slate">Run tests and builds on computers you trust. The selected computer's owner can read the project you send. Source and results are encrypted during transfer and storage. Tasks run without network access.</p>
    {error && <p role="alert" className="text-sm text-blood">{mask(error)}</p>}
    {!gateway && <p>Add a gateway to use the farm.</p>}
    {draft && <section className="rounded-xl border border-rule bg-sheet p-4">
      <h2 className="font-display text-xl">Share this computer</h2>
      <p className="my-2 text-sm">Farm mode is {view?.policy.enabled ? 'on' : 'off'} · {view?.active ? 'running a task' : 'idle'}{view?.cleanupReady === false ? ' · cleanup needs attention' : ''}</p>
      <label className="block text-sm">Approved requester peer IDs, one per line
        <PrivateTextarea className="mt-1 block w-full rounded border border-rule p-2 font-mono text-xs" value={draft.requesters.join('\n')} onChange={(e) => setPolicy({ ...draft, requesters: e.target.value.split('\n').filter(Boolean) })} />
      </label>
      <label className="mt-3 block text-sm">Prepared sandbox images, pinned by digest, one per line
        <PrivateTextarea className="mt-1 block w-full rounded border border-rule p-2 font-mono text-xs" value={draft.images.join('\n')} onChange={(e) => setPolicy({ ...draft, images: e.target.value.split('\n').filter(Boolean) })} />
      </label>
      <div className="my-3 flex flex-wrap gap-4">
        {([['cpus', 'CPU cores'], ['memoryMb', 'Memory MB'], ['diskMb', 'Work disk MB'], ['timeoutMs', 'Time limit ms']] as const).map(([field, label]) => <label key={field} className="text-sm">{label}<input type="number" className="ml-2 w-24 rounded border border-rule p-1" value={draft[field]} onChange={(e) => setPolicy({ ...draft, [field]: Number(e.target.value) })} /></label>)}
      </div>
      <div className="flex gap-2">{[true, false].map((enabled) => <button key={String(enabled)} className={button} disabled={busy || (enabled && hidden) || (enabled && (!draft.images.length || !draft.requesters.length))} onClick={() => void run(async () => {
        const p = FarmPolicy.parse(enabled ? { ...draft, enabled } : { ...view!.policy, enabled: false });
        const r = await fetch(`${gateway!.url.replace(/\/$/, '')}/admin/farm/policy`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(p) });
        if (!r.ok) throw new Error((await r.json() as { error?: { message?: string } }).error?.message ?? 'Policy rejected');
        setPolicy(null);
      })}>{enabled ? 'Enable / save farm mode' : 'Turn off and cancel current task'}</button>)}</div>
    </section>}
    <section className="rounded-xl border border-rule bg-sheet p-4">
      <h2 className="font-display text-xl">Submit a reviewed routine</h2>
      <p className="my-2 text-sm text-slate">Prepare a source package with the CLI, then paste its JSON here to inspect and submit it. Packages remain in this page's memory.</p>
      <PrivateTextarea aria-label="Routine package JSON" className="h-32 w-full rounded border border-rule p-2 font-mono text-xs" value={packageText} onChange={(e) => { setPackageText(e.target.value); setReviewed(false); }} />
      {parsed?.success && <div className="my-3 text-sm">
        <p className="break-all">Worker: {mask(parsed.data.targetPeerId)}</p>
        <p>{parsed.data.package.source.files.length} files · {mask(parsed.data.package.spec.title)}</p>
        <details><summary>Files and commands leaving this machine</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{mask(JSON.stringify({ files: parsed.data.package.source.files.map((f) => f.path), steps: parsed.data.package.spec.steps }, null, 2))}</pre></details>
        <label className="mt-2 block"><input type="checkbox" disabled={hidden} checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I approve these commands and trust this worker with this source.</label>
      </div>}
      <button className={button} disabled={hidden || busy || !client || !parsed?.success || !reviewed} onClick={() => void run(async () => { if (parsed?.success) setResult(await client!.submit(parsed.data)); })}>Send routine</button>
    </section>
    <section className="rounded-xl border border-rule bg-sheet p-4">
      <h2 className="font-display text-xl">Submitted tasks</h2>
      {!view?.outgoing.length && <p className="my-2 text-sm text-slate">No tasks submitted.</p>}
      {view?.outgoing.map((job) => <div key={`${mask(job.ref.jobId)}/${job.ref.attemptId}`} className="my-3 border-t border-rule pt-3 text-sm">
        <p>{mask(job.ref.jobId)}: {job.state}</p><p className="text-slate">{mask(job.status?.detail ?? job.error)}</p>
        <div className="mt-2 flex gap-2">
          <button className={button} disabled={busy} onClick={() => void run(async () => setResult(await client!.status(job.ref)))}>Inspect result</button>
          <button className={button} disabled={busy || ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)} onClick={() => void run(async () => setResult(await client!.cancel(job.ref)))}>Cancel</button>
          <button className={button} disabled={busy || !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state) || job.status?.acknowledged} onClick={() => void run(async () => setResult(await client!.acknowledge(job.ref)))}>Acknowledge receipt</button>
        </div>
      </div>)}
      {result && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-rule p-3 text-xs">{mask(JSON.stringify(result, null, 2))}</pre>}
    </section>
    {!!view?.jobs.length && <section className="rounded-xl border border-rule bg-sheet p-4"><h2 className="font-display text-xl">Tasks served here</h2>{view.jobs.map((job) => <p key={`${mask(job.jobId)}/${job.attemptId}`} className="mt-2 text-sm">{mask(job.jobId)}: {job.state} · workspace cleanup {job.cleanup}</p>)}</section>}
  </div>;
}
