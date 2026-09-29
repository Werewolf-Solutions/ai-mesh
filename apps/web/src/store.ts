/**
 * Browser-local state. Chats and gateway credentials never leave this browser
 * except as requests to the gateways the user configured. Nothing is
 * replicated around the mesh.
 */
import { useCallback, useEffect, useState } from 'react';

export interface Gateway {
  url: string;
  token: string;
  adminToken: string;
  label: string;
}

export type MsgStatus = 'streaming' | 'completed' | 'interrupted' | 'cancelled' | 'failed';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: MsgStatus;
  error?: string;
  worker?: string | null;
  route?: string | null;
  gatewayUrl?: string;
  runtime?: string | null;
  attempts?: Array<{ workerPeerId: string; outcome: string }>;
  /** Thinking text (models with a thinking mode). */
  reasoning?: string;
  /** How long the model thought before answering, ms. */
  thinkingMs?: number;
  /** Model and effort used for this answer. */
  model?: string;
  effort?: string;
  /** Pack notes the gateway gave the model for this answer. */
  packNotes?: Array<{ id: string; title: string; solution?: string; similarity: number }>;
  /** Web research done before this answer: steps as they happened, and the sources the model was given. */
  steps?: Array<{ kind: string; status: 'running' | 'done' | 'failed'; text: string }>;
  sources?: Array<{ n: number; title: string; url: string; kind: 'page' | 'snippet' }>;
  webQuery?: string | null;
  /** Set on an answer after it was shared with the pack. */
  sharedNoteId?: string;
  /** UI-only message (e.g. "share this with the pack" and its confirmation): never sent to the model. */
  meta?: boolean;
  /** Confirmation card for a note shared from the chat. */
  packCard?: { noteId: string; title: string; removed: string[]; withdrawn?: boolean; error?: string };
  at: number;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: state lives for this tab only */
  }
};

export function usePersistent<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => read(key, initial));
  useEffect(() => {
    write(key, v);
  }, [key, v]);
  return [v, setV];
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/**
 * Credentials passed as `#gateway=...&token=...&admin=...` (printed by `./mesh ui-url`).
 * The fragment is never sent to the server; we store it and scrub it from the address bar.
 */
export function takeFragmentGateway(): Gateway | null {
  const h = window.location.hash.slice(1);
  if (!h.includes('token=') && !h.includes('gateway=')) return null;
  const p = new URLSearchParams(h);
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return {
    url: p.get('gateway') ?? window.location.origin,
    token: p.get('token') ?? '',
    adminToken: p.get('admin') ?? '',
    label: new URL(p.get('gateway') ?? window.location.origin).host,
  };
}

export function useGateways() {
  const [gateways, setGateways] = usePersistent<Gateway[]>('wam.gateways', []);
  useEffect(() => {
    const frag = takeFragmentGateway();
    setGateways((g) => {
      let next = g;
      if (frag) next = [frag, ...g.filter((x) => x.url !== frag.url)];
      if (next.length === 0) next = [{ url: window.location.origin, token: '', adminToken: '', label: 'This node' }];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [gateways, setGateways] as const;
}

export function useChats() {
  const [chats, setChats] = usePersistent<Chat[]>('wam.chats', []);
  // An answer still marked "streaming" after a reload lost its connection: show it as interrupted.
  useEffect(() => {
    setChats((all) =>
      all.map((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.status === 'streaming' ? { ...m, status: 'interrupted', error: 'The page was closed or reloaded while this answer was streaming.' } : m)),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = useCallback(
    (id: string, fn: (c: Chat) => Chat) => setChats((all) => all.map((c) => (c.id === id ? fn(c) : c))),
    [setChats],
  );
  return { chats, setChats, update };
}
