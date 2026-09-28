/**
 * The model catalog as seen from the primary gateway: what the pack serves,
 * and (for the gateway's own operator) what this node can download and run.
 */
import type { CatalogModelView } from '@werewolf-mesh/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { Gateway } from './store';

export type Effort = 'none' | 'low' | 'high';
export const EFFORTS: Array<{ value: Effort; label: string; thinks: string; plain: string }> = [
  { value: 'none', label: 'Fast', thinks: 'Answers straight away, no thinking.', plain: 'Short answers.' },
  { value: 'low', label: 'Balanced', thinks: 'Thinks briefly before answering (up to ~500 tokens).', plain: 'Normal answer length.' },
  { value: 'high', label: 'Thorough', thinks: 'Thinks at length before answering (up to ~4,000 tokens). Slow on a CPU.', plain: 'Longer answers.' },
];

const auth = (g: Gateway): Record<string, string> => {
  const t = g.adminToken || g.token;
  return t ? { authorization: `Bearer ${t}` } : {};
};

export function useCatalog(gw: Gateway | undefined, intervalMs = 4000) {
  const [models, setModels] = useState<CatalogModelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!gw) return;
    try {
      const r = await fetch(`${gw.url.replace(/\/$/, '')}/v1/models?all=1`, { headers: auth(gw) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { data: Array<{ mesh: CatalogModelView }> };
      setModels(j.data.map((d) => d.mesh));
      setError(null);
    } catch (e) {
      setError(e instanceof TypeError ? `Cannot reach ${gw.url}` : (e as Error).message);
    }
  }, [gw]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  const act = useCallback(
    async (path: string, method = 'POST') => {
      if (!gw) return;
      const r = await fetch(`${gw.url.replace(/\/$/, '')}${path}`, { method, headers: auth(gw) });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      }
      await refresh();
    },
    [gw, refresh],
  );

  /** True when this browser is the gateway's operator (the server only then reports local install state). */
  const isOperator = !!models?.some((m) => m.local);

  return {
    models,
    error,
    refresh,
    isOperator,
    install: (id: string) => act(`/admin/models/${id}/install`),
    cancel: (id: string) => act(`/admin/models/${id}/cancel`),
    unhost: (id: string) => act(`/admin/models/${id}/unhost`),
    remove: (id: string) => act(`/admin/models/${id}`, 'DELETE'),
  };
}

export const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 2 ** 30 ? 2 : 1)} GB`;
export const ramGb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
