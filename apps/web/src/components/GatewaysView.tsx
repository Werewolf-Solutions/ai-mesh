import { useState } from 'react';
import type { Gateway } from '../store';

export function GatewaysView({ gateways, setGateways }: { gateways: Gateway[]; setGateways: (g: Gateway[]) => void }) {
  const [form, setForm] = useState<Gateway>({ url: '', token: '', adminToken: '', label: '' });
  const [check, setCheck] = useState<Record<string, string>>({});

  const move = (i: number, d: -1 | 1) => {
    const g = [...gateways];
    const j = i + d;
    if (j < 0 || j >= g.length) return;
    [g[i], g[j]] = [g[j]!, g[i]!];
    setGateways(g);
  };
  const test = async (g: Gateway) => {
    setCheck((c) => ({ ...c, [g.url]: 'Checking…' }));
    try {
      const r = await fetch(g.url.replace(/\/$/, '') + '/health/ready');
      const b = await r.json();
      setCheck((c) => ({ ...c, [g.url]: b.ready ? 'Ready: its own model is loaded' : b.canServe ? 'Reachable: can forward to peers' : `Reachable, not serving (model ${b.model})` }));
    } catch {
      setCheck((c) => ({ ...c, [g.url]: 'Cannot reach it from this browser (offline, wrong URL, or not in its allowed origins)' }));
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-[72ch]">
        <h1 className="font-display text-3xl tracking-tight">Gateways</h1>
        <p className="mt-2 text-slate">
          Gateways are the nodes this browser sends questions to. If one fails before it starts answering, the next one in this list is tried, up to three. An answer that
          breaks part-way is never continued elsewhere; you retry it as a new answer.
        </p>
        <p className="mt-2 text-sm text-slate">
          Tokens are stored only in this browser. A running page keeps working through the next gateway if one goes down, but a fresh visit to a dead address cannot load
          anything: keep the address of a second gateway, or run the UI from your own node.
        </p>

        <ol className="mt-6 space-y-3">
          {gateways.map((g, i) => (
            <li key={g.url} className="rounded-xl border border-rule bg-sheet p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-medium">{g.label || new URL(g.url).host}</span>
                  <span className="ml-2 text-sm text-slate">{g.url}</span>
                </div>
                <span className="text-xs text-slate">{i === 0 ? 'tried first' : `fallback ${i}`}</span>
              </div>
              <p className="mt-1 text-sm text-slate">
                {g.token ? 'Client token saved' : 'No client token (works only on this machine’s own node)'}
                {g.adminToken ? ', admin token saved' : ''}
              </p>
              {check[g.url] && <p className="mt-1 text-sm">{check[g.url]}</p>}
              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                <button className="rounded-md border border-rule px-2.5 py-1" onClick={() => test(g)}>
                  Check
                </button>
                <button className="rounded-md border border-rule px-2.5 py-1 disabled:opacity-40" disabled={i === 0} onClick={() => move(i, -1)}>
                  Move up
                </button>
                <button className="rounded-md border border-rule px-2.5 py-1 disabled:opacity-40" disabled={i === gateways.length - 1} onClick={() => move(i, 1)}>
                  Move down
                </button>
                <button className="rounded-md border border-rule px-2.5 py-1 text-blood" onClick={() => setGateways(gateways.filter((x) => x.url !== g.url))}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>

        <form
          className="mt-8 grid gap-3 rounded-xl border border-dashed border-rule p-4"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const u = new URL(form.url);
              const url = u.origin;
              setGateways([...gateways.filter((g) => g.url !== url), { ...form, url, label: form.label || u.host }]);
              setForm({ url: '', token: '', adminToken: '', label: '' });
            } catch {
              /* invalid URL: the input's own validation reports it */
            }
          }}
        >
          <h2 className="font-display text-xl">Add a gateway</h2>
          {(
            [
              ['url', 'Address', 'https://node.example.org', 'url', true],
              ['label', 'Name', 'Home server', 'text', false],
              ['token', 'Client token', 'wmc_…', 'password', false],
              ['adminToken', 'Admin token (optional, shows the network view)', 'wma_…', 'password', false],
            ] as const
          ).map(([k, label, ph, type, req]) => (
            <label key={k} className="grid gap-1 text-sm">
              <span>{label}</span>
              <input
                type={type}
                required={req}
                placeholder={ph}
                autoComplete="off"
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                className="rounded-lg border border-rule bg-paper px-3 py-2 focus:border-moon focus:outline-none"
              />
            </label>
          ))}
          <p className="text-xs text-slate">
            The gateway must list this page’s origin ({window.location.origin}) in http.allowedOrigins, and should be served over HTTPS when it is not on this machine.
          </p>
          <button type="submit" className="justify-self-start rounded-lg bg-ink px-4 py-2 font-medium text-paper">
            Add gateway
          </button>
        </form>
      </div>
    </div>
  );
}
