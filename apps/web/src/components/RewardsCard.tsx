import { usePrivacy } from '../privacy';
import { useCallback, useEffect, useState } from 'react';
import type { Gateway } from '../store';

interface RewardsView {
  enabled: boolean;
  settler: string | null;
  epochs: Array<{ epoch: string; received: number; creditableTokens: number; sameNetwork: number; requesters: number }>;
  sent: { today: number };
  rejected: Record<string, number>;
  balance: { total: number; epochs: Array<{ epoch: string; wlf: number; pool: number; qualifiedNodes: number; halvings: number }> };
}

/** WLF reward points: what this computer earned by answering other people's requests. */
export function RewardsCard({ gateway }: { gateway: Gateway | undefined }) {
  const { mask } = usePrivacy();
  const [v, setV] = useState<RewardsView | null>(null);
  const load = useCallback(async () => {
    if (!gateway) return;
    const t = gateway.adminToken || gateway.token;
    const r = await fetch(`${gateway.url.replace(/\/$/, '')}/admin/rewards`, { headers: t ? { authorization: `Bearer ${t}` } : {} }).catch(() => null);
    if (r?.ok) setV((await r.json()) as RewardsView);
  }, [gateway]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);
  if (!v) return null;
  const today = v.epochs[0];
  return (
    <section className="mt-8" aria-labelledby="wlf-title">
      <h2 id="wlf-title" className="font-display text-xl">
        WLF rewards
      </h2>
      <p className="mt-1 max-w-[70ch] text-sm text-slate">
        This computer earns WLF points when it answers requests from <em>other</em> people's nodes, outside your own network. Using your own node never earns. Each
        answer comes with a receipt signed by the node that asked; the day's points are shared out when the network's settler settles the day. WLF are points, not
        a token: they have no value yet.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-rule bg-sheet p-4">
          <p className="text-sm text-slate">Settled balance</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {mask(v.balance.total.toLocaleString(undefined, { maximumFractionDigits: 2 }))} <span className="text-base font-normal text-slate">WLF</span>
          </p>
          <p className="mt-0.5 text-sm text-slate">{v.balance.epochs.length ? `from ${v.balance.epochs.length} settled day${v.balance.epochs.length > 1 ? 's' : ''}` : 'no day settled yet'}</p>
        </div>
        <div className="rounded-xl border border-rule bg-sheet p-4">
          <p className="text-sm text-slate">Today, served to others</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">{today?.received ?? 0}</p>
          <p className="mt-0.5 text-sm text-slate">
            answer{today?.received === 1 ? '' : 's'} for {today?.requesters ?? 0} other node{today?.requesters === 1 ? '' : 's'}
            {today?.sameNetwork ? ` · ${today.sameNetwork} from your own network (not counted)` : ''}
          </p>
        </div>
        <div className="rounded-xl border border-rule bg-sheet p-4">
          <p className="text-sm text-slate">Settler</p>
          <p className="mt-1 truncate font-mono text-sm" title={mask(v.settler ?? '')}>
            {mask(v.settler ? `…${v.settler.slice(-10)}` : 'not set')}
          </p>
          <p className="mt-0.5 text-sm text-slate">{v.enabled ? 'earning is on' : 'earning is off on this node'}</p>
        </div>
      </div>
      {v.balance.epochs.length > 0 && (
        <table className="num mt-3 w-full text-sm">
          <thead className="text-left text-slate">
            <tr className="border-b border-rule">
              <th className="py-1.5 font-normal">Day</th>
              <th className="py-1.5 text-right font-normal">You earned</th>
              <th className="py-1.5 text-right font-normal">Day's pool</th>
              <th className="py-1.5 text-right font-normal">Qualified nodes</th>
            </tr>
          </thead>
          <tbody>
            {[...v.balance.epochs].reverse().map((e) => (
              <tr key={e.epoch} className="border-b border-rule">
                <td className="py-1.5">{e.epoch}</td>
                <td className="py-1.5 text-right">{mask(e.wlf)} WLF</td>
                <td className="py-1.5 text-right">{e.pool} WLF</td>
                <td className="py-1.5 text-right">
                  {e.qualifiedNodes}
                  {e.halvings ? ` (halved ${e.halvings}×)` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
