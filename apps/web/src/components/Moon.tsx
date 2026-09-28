/**
 * A node drawn as a moon. The lit part shows how busy the node is (a full moon
 * is fully loaded); an unavailable node is an outlined new moon.
 */
export function hueFor(peerId: string): number {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Moon({ load, available = true, size = 18, title }: { load: number; available?: boolean; size?: number; title?: string }) {
  const r = size / 2 - 1.5;
  const c = size / 2;
  const f = Math.max(0, Math.min(1, load));
  // Terminator ellipse: rx goes from r (new) through 0 (half) back to r (full).
  const rx = Math.abs(1 - 2 * f) * r;
  const sweep = f > 0.5 ? 1 : 0;
  const lit = `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx} ${r} 0 0 ${sweep} ${c} ${c - r} Z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title ?? `load ${Math.round(f * 100)}%`}>
      {title && <title>{title}</title>}
      <circle cx={c} cy={c} r={r} fill={available ? 'var(--color-sheet)' : 'none'} stroke={available ? 'var(--color-slate)' : 'var(--color-rule)'} strokeWidth="1.2" strokeDasharray={available ? undefined : '2 2'} />
      {available && f > 0.02 && <path d={f >= 0.98 ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c} ${c + r} A ${r} ${r} 0 1 1 ${c} ${c - r} Z` : lit} fill="var(--color-moon)" />}
    </svg>
  );
}

/** Small attribution badge: which node answered. */
export function NodeBadge({ peerId, label, route }: { peerId: string; label?: string | null; route?: string | null }) {
  const hue = hueFor(peerId);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2 py-0.5 text-xs text-slate" title={peerId}>
      <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: `oklch(0.65 0.12 ${hue})` }} />
      <span className="text-ink">{label ?? `…${peerId.slice(-6)}`}</span>
      {route === 'remote' && <span>via the mesh</span>}
    </span>
  );
}
