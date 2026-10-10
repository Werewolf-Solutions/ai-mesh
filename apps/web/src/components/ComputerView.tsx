import { usePrivacy } from '../privacy';
import type { SystemView } from '@werewolf-mesh/protocol';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Gateway } from '../store';
import { RewardsCard } from './RewardsCard';

/** Readings every 2 s; the charts show the last 5 minutes (kept only in this page, never stored). */
const INTERVAL_MS = 2000;
const HISTORY = 150;

type Sample = { at: number; v: SystemView };

function useSystem(gateway: Gateway | undefined) {
  const [history, setHistory] = useState<Sample[]>([]);
  const [error, setError] = useState<{ code: number | null; message: string } | null>(null);
  const load = useCallback(async () => {
    if (!gateway) return;
    const t = gateway.adminToken || gateway.token;
    try {
      const r = await fetch(`${gateway.url.replace(/\/$/, '')}/admin/system`, { headers: t ? { authorization: `Bearer ${t}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        setError({ code: r.status, message: ((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${r.status}` });
        return;
      }
      const v = (await r.json()) as SystemView;
      setError(null);
      setHistory((h) => [...h, { at: v.at, v }].slice(-HISTORY));
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    }
  }, [gateway]);
  useEffect(() => {
    setHistory([]);
    void load();
    // Pause while the tab is in the background; catch up as soon as it is visible.
    const t = setInterval(() => document.hidden || void load(), INTERVAL_MS);
    const onVisible = () => document.hidden || void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);
  return { history, error };
}

// ------------------------------------------------------------------ formatting

const gb = (mb: number | null | undefined) => (mb == null ? '–' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const pctText = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n)}%`);
const degText = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n)} °C`);

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/** Kernel sensor drivers, in words. */
const SOURCE: Record<string, string> = {
  nvme: 'SSD (NVMe)',
  drivetemp: 'Disk',
  k10temp: 'CPU (AMD)',
  zenpower: 'CPU (AMD)',
  coretemp: 'CPU (Intel)',
  cpu_thermal: 'CPU',
  acpitz: 'ACPI',
  iwlwifi_1: 'Wi-Fi',
  asus_wmi_sensors: 'Motherboard',
  asus: 'Motherboard',
  nct6775: 'Motherboard',
  nct6798: 'Motherboard',
  it87: 'Motherboard',
};
const source = (s: string) => SOURCE[s] ?? s;

type Level = 'normal' | 'warm' | 'hot';
/** Typical limits: desktop CPUs throttle around 95–100 °C, GPUs around 83–93 °C. */
function heat(c: number | null | undefined, kind: 'cpu' | 'gpu'): Level | null {
  if (c == null) return null;
  const [warm, hot] = kind === 'cpu' ? [75, 90] : [75, 85];
  return c >= hot ? 'hot' : c >= warm ? 'warm' : 'normal';
}

function severity(p: number | null | undefined): 'ok' | 'high' | 'full' {
  if (p == null) return 'ok';
  return p >= 95 ? 'full' : p >= 85 ? 'high' : 'ok';
}

const FILL = { ok: 'bg-slate', high: 'bg-moon', full: 'bg-blood' } as const;

function HeatBadge({ level }: { level: Level | null }) {
  if (!level) return null;
  const cls = level === 'hot' ? 'text-blood border-blood' : level === 'warm' ? 'text-moon border-moon' : 'text-pine border-pine';
  const mark = level === 'hot' ? '▲' : level === 'warm' ? '△' : '✓';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 text-xs ${cls}`}>
      <span aria-hidden>{mark}</span>
      {level === 'hot' ? 'Hot' : level === 'warm' ? 'Warm' : 'Normal'}
    </span>
  );
}

// ------------------------------------------------------------------ marks

function Meter({ value, label }: { value: number | null; label: string }) {
  const s = severity(value);
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-rule" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      <div className={`h-full rounded-full ${FILL[s]} transition-[width] duration-500`} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
    </div>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * Single-series trend of the last 5 minutes on a fixed scale, with a hover
 * crosshair. One series, so the tile's title names it and there is no legend.
 */
function Sparkline({ points, min, max, format, label }: { points: Array<{ at: number; y: number | null }>; min: number; max: number; format: (n: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 44;
  const valid = points.filter((p) => p.y !== null) as Array<{ at: number; y: number }>;
  const now = points.at(-1)?.at ?? Date.now();
  // The window grows with the data: 1 minute at first, up to the full 5 minutes.
  const span = Math.min(HISTORY * INTERVAL_MS, Math.max(60_000, now - (points[0]?.at ?? now)));
  const x = (at: number) => width - ((now - at) / span) * width;
  const y = (v: number) => H - 2 - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (H - 4);
  const line = valid.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const area = valid.length > 1 ? `${line}L${x(valid.at(-1)!.at).toFixed(1)},${H}L${x(valid[0]!.at).toFixed(1)},${H}Z` : '';
  const ys = valid.map((p) => p.y);
  const summary = ys.length ? `${label} over the last ${Math.round((now - valid[0]!.at) / 60000) || 1} min: low ${format(Math.min(...ys))}, high ${format(Math.max(...ys))}, now ${format(ys.at(-1)!)}` : `${label}: no readings yet`;
  const h = hover !== null ? valid[hover] : undefined;
  return (
    <div
      ref={ref}
      className="relative mt-3 mb-4 h-11"
      role="img"
      aria-label={summary}
      onMouseMove={(e) => {
        if (!valid.length) return;
        const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
        let best = 0;
        for (let i = 1; i < valid.length; i++) if (Math.abs(x(valid[i]!.at) - px) < Math.abs(x(valid[best]!.at) - px)) best = i;
        setHover(best);
      }}
      onMouseLeave={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={H} className="block overflow-visible" aria-hidden>
          <line x1={0} x2={width} y1={H - 0.5} y2={H - 0.5} stroke="var(--color-rule)" strokeWidth={1} />
          {area && <path d={area} fill="var(--color-slate)" opacity={0.12} />}
          {line && <path d={line} fill="none" stroke="var(--color-slate)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {valid.length > 0 && !h && <circle cx={x(valid.at(-1)!.at)} cy={y(valid.at(-1)!.y)} r={3.5} fill="var(--color-ink)" stroke="var(--color-sheet)" strokeWidth={2} />}
          {h && (
            <>
              <line x1={x(h.at)} x2={x(h.at)} y1={0} y2={H} stroke="var(--color-ink)" strokeWidth={1} opacity={0.4} />
              <circle cx={x(h.at)} cy={y(h.y)} r={4} fill="var(--color-ink)" stroke="var(--color-sheet)" strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      <span className="pointer-events-none absolute -bottom-4 left-0 text-[11px] text-slate">{Math.round(span / 60000)} min</span>
      <span className="pointer-events-none absolute right-0 -bottom-4 text-[11px] text-slate">now</span>
      {h && (
        <div
          className="num pointer-events-none absolute -top-8 z-10 whitespace-nowrap rounded-md border border-rule bg-sheet px-2 py-0.5 text-xs shadow-sm"
          style={{ left: Math.min(Math.max(0, x(h.at) - 50), Math.max(0, width - 110)) }}
        >
          <span className="font-medium">{format(h.y)}</span> <span className="text-slate">{Math.round((now - h.at) / 1000)} s ago</span>
        </div>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  meter,
  badge,
  trend,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  meter?: number | null;
  badge?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-rule bg-sheet p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm text-slate">{label}</h2>
        {badge}
      </div>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-sm text-slate">{sub}</p>}
      {meter !== undefined && <Meter value={meter} label={label} />}
      {trend}
    </section>
  );
}

// ------------------------------------------------------------------ view

export function ComputerView({ gateways }: { gateways: Gateway[] }) {
  const { mask } = usePrivacy();
  const gateway = gateways[0];
  const { history, error } = useSystem(gateway);
  const v = history.at(-1)?.v;
  const series = (f: (v: SystemView) => number | null | undefined) => history.map((s) => ({ at: s.at, y: f(s.v) ?? null }));
  const pct = (n: number) => `${Math.round(n)}%`;
  const deg = (n: number) => `${Math.round(n)} °C`;

  return (
    <div className="h-full overflow-y-auto px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="font-display text-3xl tracking-tight">This computer</h1>
        <p className="mt-2 max-w-[70ch] text-slate">
          How hard this computer is working, how warm it is, and how much of it Werewolf uses. Readings come from this node every 2 seconds and stay on this page: they
          are never sent to other nodes.
        </p>
        {error && (
          <p className="mt-4 rounded-lg border border-rule bg-sheet px-4 py-3 text-sm text-slate">
            {error.code === 401 || error.code === 403
              ? "Only the operator of this node can see its computer's resources. Open your own node's page (for example http://127.0.0.1:8080) or add its admin token under Gateways."
              : `Could not read the resources: ${mask(error.message)}`}
          </p>
        )}
        {!v && !error && <p className="mt-6 text-slate">Reading…</p>}
        {v && <Body v={v} series={series} pct={pct} deg={deg} />}
        {v && <RewardsCard gateway={gateway} />}
      </div>
    </div>
  );
}

function Body({
  v,
  series,
  pct,
  deg,
}: {
  v: SystemView;
  series: (f: (v: SystemView) => number | null | undefined) => Array<{ at: number; y: number | null }>;
  pct: (n: number) => string;
  deg: (n: number) => string;
}) {
  const { mask } = usePrivacy();
  const memPct = (s: SystemView) => (s.memory.totalMB ? (s.memory.usedMB / s.memory.totalMB) * 100 : null);
  const ww = v.mesh;
  const wwRam = ww.node.rssMB + ww.runtimes.reduce((s, r) => s + (r.rssMB ?? 0), 0);
  const wwCpu = [ww.node.cpuPct, ...ww.runtimes.map((r) => r.cpuPct)].reduce<number>((s, c) => s + (c ?? 0), 0);

  return (
    <>
      <p className="mt-1 text-sm text-slate">
        {v.cpu.model} · {v.cpu.threads} threads · {gb(v.memory.totalMB)} RAM · {v.platform} · up {uptime(v.uptimeS)}
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          label="CPU use"
          value={pctText(v.cpu.usagePct)}
          sub={
            <>
              load {v.cpu.load.join(' · ')}
              {v.cpu.freqMHz ? ` · ${(v.cpu.freqMHz / 1000).toFixed(2)} GHz` : ''}
            </>
          }
          meter={v.cpu.usagePct}
          trend={<Sparkline points={series((s) => s.cpu.usagePct)} min={0} max={100} format={pct} label="CPU use" />}
        />
        <Tile
          label="CPU temperature"
          value={degText(v.cpu.tempC)}
          sub={v.cpu.tempSource ? `sensor: ${v.cpu.tempSource}` : 'no CPU sensor found'}
          badge={<HeatBadge level={heat(v.cpu.tempC, 'cpu')} />}
          trend={v.cpu.tempC !== null ? <Sparkline points={series((s) => s.cpu.tempC)} min={20} max={100} format={deg} label="CPU temperature" /> : undefined}
        />
        <Tile
          label="Memory"
          value={pctText(memPct(v))}
          sub={
            <>
              {gb(v.memory.usedMB)} of {gb(v.memory.totalMB)} used · {gb(v.memory.availableMB)} free
              {v.memory.swapUsedMB > 0 && <> · swap {gb(v.memory.swapUsedMB)}</>}
            </>
          }
          meter={memPct(v)}
          trend={<Sparkline points={series(memPct)} min={0} max={100} format={pct} label="Memory use" />}
        />
        {v.gpus.map((g, i) => (
          <GpuTiles key={i} i={i} g={g} series={series} pct={pct} deg={deg} />
        ))}
      </div>

      {v.cpu.perThreadPct.length > 1 && (
        <section className="mt-6">
          <h2 className="font-display text-xl">CPU threads</h2>
          <div className="mt-2 flex h-16 items-end gap-0.5 rounded-xl border border-rule bg-sheet p-3" role="img" aria-label={`Use per thread: ${v.cpu.perThreadPct.map((p) => Math.round(p)).join(', ')} percent`}>
            {v.cpu.perThreadPct.map((p, i) => (
              <div key={i} className="group relative flex h-full flex-1 items-end rounded-sm bg-rule/60" title={`Thread ${i + 1}: ${Math.round(p)}%`}>
                <div className={`w-full rounded-t-sm ${FILL[severity(p)]} transition-[height] duration-500`} style={{ height: `${Math.max(2, p)}%` }} />
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate">One bar per thread. A model answering on the CPU keeps most bars full; on the GPU it barely touches them.</p>
        </section>
      )}

      <section className="mt-8">
        <h2 className="font-display text-xl">What Werewolf uses</h2>
        <p className="mt-1 text-sm text-slate">
          {gb(wwRam)} of RAM ({v.memory.totalMB ? Math.round((wwRam / v.memory.totalMB) * 100) : 0}% of this computer) and {Math.round(wwCpu)}% CPU, where 100% is one
          thread fully busy.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-rule bg-sheet">
          <table className="num w-full text-sm">
            <thead className="text-left text-slate">
              <tr className="border-b border-rule">
                <th className="px-4 py-2 font-normal">Process</th>
                <th className="px-4 py-2 text-right font-normal">RAM</th>
                <th className="px-4 py-2 text-right font-normal">CPU</th>
                <th className="px-4 py-2 text-right font-normal">GPU memory</th>
                <th className="px-4 py-2 font-normal">Runs on</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule last:border-0">
                <td className="px-4 py-2">Node (network, gateway, pack memory)</td>
                <td className="px-4 py-2 text-right">{gb(ww.node.rssMB)}</td>
                <td className="px-4 py-2 text-right">{pctText(ww.node.cpuPct)}</td>
                <td className="px-4 py-2 text-right text-slate">–</td>
                <td className="px-4 py-2 text-slate">CPU</td>
              </tr>
              {ww.runtimes.map((r) => (
                <tr key={r.name} className="border-b border-rule last:border-0">
                  <td className="px-4 py-2">{r.name}</td>
                  <td className="px-4 py-2 text-right">{gb(r.rssMB)}</td>
                  <td className="px-4 py-2 text-right">{pctText(r.cpuPct)}</td>
                  <td className="px-4 py-2 text-right">{r.gpuMemMB !== null ? gb(r.gpuMemMB) : <span className="text-slate">–</span>}</td>
                  <td className="px-4 py-2 text-slate">{r.pid === null ? 'not running as a process here' : r.accel === 'cpu' ? 'CPU' : `GPU (${r.accel === 'cuda' ? 'CUDA' : 'Vulkan'})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ww.runtimes.some((r) => r.accel === 'vulkan') && <p className="mt-1 text-xs text-slate">GPU memory per process is only reported for CUDA on NVIDIA cards.</p>}
      </section>

      <section className="mt-8 grid gap-6 sm:grid-cols-2">
        <div>
          <h2 className="font-display text-xl">Sensors</h2>
          {v.sensors.temps.length === 0 && v.sensors.fans.length === 0 ? (
            <p className="mt-2 text-sm text-slate">This system exposes no temperature or fan sensors (common in virtual machines and on macOS).</p>
          ) : (
            <table className="num mt-2 w-full text-sm">
              <tbody>
                {v.sensors.temps.map((t, i) => (
                  <tr key={`t${i}`} className="border-b border-rule">
                    <td className="py-1.5 pr-3">{t.label}</td>
                    <td className="py-1.5 pr-3 text-slate" title={t.source}>
                      {source(t.source)}
                    </td>
                    <td className="py-1.5 text-right">{degText(t.c)}</td>
                  </tr>
                ))}
                {v.sensors.fans.map((f, i) => (
                  <tr key={`f${i}`} className="border-b border-rule">
                    <td className="py-1.5 pr-3">{f.label}</td>
                    <td className="py-1.5 pr-3 text-slate">fan</td>
                    <td className="py-1.5 text-right">{f.rpm.toLocaleString()} rpm</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h2 className="font-display text-xl">Disk</h2>
          {v.disk ? (
            <>
              <p className="mt-2 text-sm">
                {gb(v.disk.freeMB)} free of {gb(v.disk.totalMB)}
              </p>
              <Meter value={v.disk.totalMB ? ((v.disk.totalMB - v.disk.freeMB) / v.disk.totalMB) * 100 : null} label="Disk used" />
              <p className="mt-1 truncate text-xs text-slate" title={mask(v.disk.path)}>
                The disk holding {mask(v.disk.path)}, where models are stored.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate">Not available.</p>
          )}
        </div>
      </section>
    </>
  );
}

function GpuTiles({
  i,
  g,
  series,
  pct,
  deg,
}: {
  i: number;
  g: SystemView['gpus'][number];
  series: (f: (v: SystemView) => number | null | undefined) => Array<{ at: number; y: number | null }>;
  pct: (n: number) => string;
  deg: (n: number) => string;
}) {
  const memPct = g.memUsedMB !== null && g.memTotalMB ? (g.memUsedMB / g.memTotalMB) * 100 : null;
  const pick = (s: SystemView) => s.gpus[i];
  const name = i === 0 ? 'GPU' : `GPU ${i + 1}`;
  if (g.utilPct === null && g.memTotalMB === null && g.tempC === null) {
    return <Tile label={name} value={g.name} sub="Detected. This driver does not report load or temperature." />;
  }
  return (
    <>
      <Tile
        label={`${name} use`}
        value={pctText(g.utilPct)}
        sub={
          <>
            {g.name}
            {g.clockMHz !== null && ` · ${(g.clockMHz / 1000).toFixed(2)} GHz`}
            {g.powerW !== null && ` · ${Math.round(g.powerW)} W${g.powerLimitW ? ` of ${Math.round(g.powerLimitW)}` : ''}`}
          </>
        }
        meter={g.utilPct}
        trend={<Sparkline points={series((s) => pick(s)?.utilPct)} min={0} max={100} format={pct} label={`${name} use`} />}
      />
      <Tile
        label={`${name} temperature`}
        value={degText(g.tempC)}
        sub={g.fanPct !== null ? (g.fanPct === 0 ? 'fans stopped' : `fans at ${g.fanPct}%`) : undefined}
        badge={<HeatBadge level={heat(g.tempC, 'gpu')} />}
        trend={g.tempC !== null ? <Sparkline points={series((s) => pick(s)?.tempC)} min={20} max={100} format={deg} label={`${name} temperature`} /> : undefined}
      />
      <Tile
        label={`${name} memory`}
        value={pctText(memPct)}
        sub={`${gb(g.memUsedMB)} of ${gb(g.memTotalMB)} used`}
        meter={memPct}
        trend={<Sparkline points={series((s) => { const x = pick(s); return x?.memUsedMB != null && x.memTotalMB ? (x.memUsedMB / x.memTotalMB) * 100 : null; })} min={0} max={100} format={pct} label={`${name} memory`} />}
      />
    </>
  );
}
