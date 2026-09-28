import type { MetricsView, NodeStatusView, PeerView } from '@werewolf-mesh/protocol';
import { useEffect, useState } from 'react';
import type { Gateway } from '../store';
import { hueFor, Moon } from './Moon';

interface Snapshot {
  status: NodeStatusView;
  peers: PeerView[];
  metrics: MetricsView;
  at: number;
}

export function useSnapshot(gw: Gateway | undefined, onLabels: (l: Record<string, string>) => void) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!gw) return;
    let stop = false;
    const headers: Record<string, string> = gw.adminToken ? { authorization: `Bearer ${gw.adminToken}` } : {};
    const tick = async () => {
      try {
        const get = async (p: string) => {
          const r = await fetch(gw.url.replace(/\/$/, '') + p, { headers });
          if (r.status === 401 || r.status === 403) throw new Error('This gateway needs its admin token to show the network. Add it under Gateways.');
          if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
          return r.json();
        };
        const [status, peers, metrics] = await Promise.all([get('/admin/status'), get('/admin/peers'), get('/admin/metrics')]);
        if (stop) return;
        setSnap({ status, peers: peers.peers, metrics, at: Date.now() });
        setError(null);
        const labels: Record<string, string> = {};
        for (const p of peers.peers as PeerView[]) if (p.label) labels[p.peerId] = p.label;
        onLabels(labels);
      } catch (e) {
        if (!stop) setError(e instanceof TypeError ? `Cannot reach ${gw.url}.` : (e as Error).message);
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [gw, onLabels]);
  return { snap, error };
}

const ms = (n: number | null | undefined) => (n == null ? '–' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
const uptime = (n: number) => {
  const s = Math.floor(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
};
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null);

export function NetworkView({ snap, error, gateway }: { snap: Snapshot | null; error: string | null; gateway: Gateway | undefined }) {
  if (!gateway) return null;
  if (!snap) return <p className="p-8 text-slate">{error ?? 'Loading…'}</p>;
  const { status: s, peers, metrics } = snap;
  const selfLoad = (s.worker.active + s.worker.queued) / Math.max(1, s.worker.maxConcurrency + s.worker.maxQueue);
  const failures = Object.entries(metrics.counters)
    .filter(([k]) => /failed|interrupted|rejected|denied|timeout/.test(k))
    .sort((a, b) => b[1] - a[1]);

  return (
    <div className="h-full overflow-y-auto px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <h1 className="font-display text-3xl tracking-tight">The pack, as {s.peerId.slice(-6)} sees it</h1>
          <p className="mt-1 max-w-[70ch] text-slate">
            A local, partial view from the gateway at {new URL(gateway.url).host}. Other nodes may see a different network. Updated every 3 seconds.
          </p>
          {error && <p className="mt-2 text-sm text-blood">Last refresh failed: {error}</p>}
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <PackRing self={s} selfLoad={selfLoad} peers={peers} />
          <section aria-labelledby="this-node">
            <h2 id="this-node" className="font-display text-xl">This node</h2>
            <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-slate">Model</dt>
              <dd className={s.runtime.ready ? 'text-pine' : 'text-blood'}>{s.runtime.ready ? 'Ready' : 'Not ready'} — {s.runtime.detail}</dd>
              <dt className="text-slate">Verified file</dt>
              <dd>{s.model.verified ? `${s.model.id}` : 'not verified'}</dd>
              <dt className="text-slate">State</dt>
              <dd>{s.state}</dd>
              <dt className="text-slate">Working / waiting</dt>
              <dd>
                {s.worker.active} of {s.worker.maxConcurrency} / {s.worker.queued} of {s.worker.maxQueue}
              </dd>
              <dt className="text-slate">Requests in flight</dt>
              <dd>
                {s.gateway.inFlight} of {s.gateway.maxInFlight}
              </dd>
              <dt className="text-slate">Uptime</dt>
              <dd>{uptime(s.uptimeMs)}</dd>
              <dt className="text-slate">First token (median)</dt>
              <dd>{ms(median(metrics.recent.ttftMs))}</dd>
              <dt className="text-slate">Failover time (median)</dt>
              <dd>{ms(median(metrics.recent.failoverMs))}</dd>
              <dt className="text-slate">Memory</dt>
              <dd>{Math.round(metrics.memory.rssBytes / 2 ** 20)} MiB (node process only)</dd>
              <dt className="text-slate">Peer ID</dt>
              <dd className="break-all text-xs">{s.peerId}</dd>
            </dl>
            {failures.length > 0 && (
              <>
                <h3 className="mt-6 font-medium">Failures and refusals since start</h3>
                <ul className="num mt-2 space-y-0.5 text-sm">
                  {failures.map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-4 border-b border-rule/60 py-0.5">
                      <span className="text-slate">{k.replaceAll('_', ' ')}</span>
                      <span>{v}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <section className="mt-10" aria-labelledby="peers">
          <h2 id="peers" className="font-display text-xl">Authorised peers</h2>
          {peers.length === 0 ? (
            <p className="mt-2 text-slate">No peers approved yet. Approve another node with ./mesh peers approve &lt;their-join.json&gt;.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="num w-full min-w-[640px] text-left text-sm">
                <thead className="text-slate">
                  <tr className="border-b border-rule">
                    <th className="py-2 pr-4 font-normal">Node</th>
                    <th className="py-2 pr-4 font-normal">Link</th>
                    <th className="py-2 pr-4 font-normal">Can serve</th>
                    <th className="py-2 pr-4 font-normal">Working / waiting</th>
                    <th className="py-2 pr-4 font-normal">Round trip</th>
                    <th className="py-2 pr-4 font-normal">Last heard</th>
                    <th className="py-2 font-normal">Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {peers.map((p) => (
                    <tr key={p.peerId} className="border-b border-rule/60 align-top">
                      <td className="py-2 pr-4">
                        <span className="flex items-center gap-2" title={p.peerId}>
                          <Moon load={((p.activeJobs ?? 0) + (p.queueLength ?? 0)) / 9} available={p.available} size={16} />
                          {p.label ?? `…${p.peerId.slice(-6)}`}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{p.connected ? (p.relayed ? 'via relay' : 'direct') : 'not connected'}</td>
                      <td className={`py-2 pr-4 ${p.available ? 'text-pine' : 'text-slate'}`}>
                        {p.available ? 'yes' : !p.connected ? 'no' : !p.modelCompatible ? 'different model' : p.state === 'draining' ? 'draining' : 'no'}
                      </td>
                      <td className="py-2 pr-4">{p.activeJobs == null ? '–' : `${p.activeJobs} / ${p.queueLength}`}</td>
                      <td className="py-2 pr-4">{ms(p.rttMs)}</td>
                      <td className="py-2 pr-4">{p.lastStatusAgeMs == null ? 'never' : `${ms(p.lastStatusAgeMs)} ago`}</td>
                      <td className="max-w-[28ch] py-2 text-xs text-slate">
                        {p.consecutiveFailures > 0 && `${p.consecutiveFailures} failed checks. `}
                        {p.lastError}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** The gateway in the centre, each authorised peer around it; solid = direct link, dashed = through a relay. */
function PackRing({ self, selfLoad, peers }: { self: NodeStatusView; selfLoad: number; peers: PeerView[] }) {
  const W = 360;
  const c = W / 2;
  const R = 128;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${W}`} className="w-full max-w-[420px]" role="img" aria-label={`Gateway and ${peers.length} peers`}>
        <circle cx={c} cy={c} r={R} fill="none" stroke="var(--color-rule)" strokeDasharray="1 5" />
        {peers.map((p, i) => {
          const a = (i / Math.max(1, peers.length)) * Math.PI * 2 - Math.PI / 2;
          const x = c + R * Math.cos(a);
          const y = c + R * Math.sin(a);
          const load = ((p.activeJobs ?? 0) + (p.queueLength ?? 0)) / 9;
          return (
            <g key={p.peerId}>
              {p.connected && <line x1={c} y1={c} x2={x} y2={y} stroke="var(--color-slate)" strokeOpacity="0.5" strokeDasharray={p.relayed ? '4 4' : undefined} />}
              <g transform={`translate(${x - 17} ${y - 17})`}>
                <Moon load={load} available={p.available} size={34} title={`${p.label ?? p.peerId}: ${p.available ? 'can serve' : 'cannot serve'}`} />
              </g>
              <text x={x} y={y + 32} textAnchor="middle" fontSize="12" fill="var(--color-ink)">
                {p.label ?? p.peerId.slice(-6)}
              </text>
              <circle cx={x + 13} cy={y - 13} r="3" fill={`oklch(0.65 0.12 ${hueFor(p.peerId)})`} />
            </g>
          );
        })}
        <g transform={`translate(${c - 28} ${c - 28})`}>
          <Moon load={selfLoad} available={self.runtime.ready} size={56} title="this gateway" />
        </g>
        <text x={c} y={c + 46} textAnchor="middle" fontSize="12" fill="var(--color-slate)">
          this gateway
        </text>
      </svg>
      <figcaption className="mt-2 text-xs text-slate">
        Lit part of each moon: how busy the node is. Solid line: direct connection. Dashed: through a relay. Dotted outline: cannot serve right now.
      </figcaption>
    </figure>
  );
}
